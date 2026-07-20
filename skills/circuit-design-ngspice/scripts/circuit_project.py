#!/usr/bin/env python3
"""Deterministic project editor/compiler for the Actoviq schematic canvas."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import re
import shlex
import shutil
import statistics
import struct
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from workspace_paths import (
    get_active_workspace,
    list_workspaces,
    resolve_projects_root,
    select_workspace,
)
from eda_export import connectivity_hash, evaluate_layout_patches, export_eda, prepare_layout_review


PROJECT_SCHEMA = "actoviq.project.v2"
MODULE_SCHEMA = "actoviq.module.v2"
LEGACY_PROJECT_SCHEMAS = {"actoviq.project.v1", PROJECT_SCHEMA}
LEGACY_MODULE_SCHEMAS = {"actoviq.module.v1", MODULE_SCHEMA}
COMMAND_SCHEMA = "actoviq.command.v1"
ERC_SCHEMA = "actoviq.erc.v1"
AGENT_PROTOCOL_VERSION = "actoviq.project-agent.v2"
SCHEMATIC_OVERRIDES_SCHEMA = "actoviq.schematic-overrides.v1"
ALLOWED_COMPONENT_TYPES = {"R", "C", "L", "D", "Q", "M", "V", "I", "E", "BLOCK"}
BLOCK_PIN_SIDES = {"left", "right", "top", "bottom"}
EDITABLE_PIN_NAMES = {
    "R": [("a", "1"), ("b", "2")],
    "C": [("a", "1"), ("b", "2")],
    "L": [("a", "1"), ("b", "2")],
    "D": [("a", "A"), ("b", "K")],
    "V": [("p", "+"), ("n", "-")],
    "I": [("p", "+"), ("n", "-")],
    "E": [("p", "OUT+"), ("n", "OUT-"), ("cp", "+"), ("cn", "-")],
    "Q": [("c", "C"), ("b", "B"), ("e", "E")],
    "M": [("d", "D"), ("g", "G"), ("s", "S"), ("b", "B")],
}
EDITABLE_NODE_COUNTS = {
    "R": 2,
    "C": 2,
    "L": 2,
    "D": 2,
    "V": 2,
    "I": 2,
    "E": 4,
    "Q": 3,
    "M": 4,
}
EDITABLE_TESTBENCH_PREFIXES = ("vtest_", "rload_")

# SPICE control/analysis/measurement directives that a notebook module may
# declare. compile_project hoists these to the top-level system deck (instead of
# treating them as device lines) so DC/transient/active designs can drive the
# system-level simulation, not just the auto-generated AC test bench.
ANALYSIS_DIRECTIVE_PREFIXES = (
    ".ac", ".dc", ".tran", ".op", ".sp", ".noise", ".pz", ".disto",
    ".sens", ".tf", ".four", ".meas", ".measure", ".print", ".plot",
    ".probe", ".save", ".ic", ".nodeset", ".options", ".option",
    ".temp", ".control", ".endc", ".actoviq",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")[:48]
    return slug or "circuit-project"


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def replace_with_retry(temp_path: Path, target_path: Path) -> None:
    for attempt in range(20):
        try:
            os.replace(temp_path, target_path)
            return
        except PermissionError:
            if attempt == 19:
                raise
            time.sleep(0.02 * (attempt + 1))


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as handle:
        handle.write(content)
        temp_path = Path(handle.name)
    replace_with_retry(temp_path, path)


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False
    ) as handle:
        handle.write(content)
        temp_path = Path(handle.name)
    replace_with_retry(temp_path, path)


def project_path(root: Path) -> Path:
    return root / "project.circuit.json"


def module_path(root: Path, module_id: str) -> Path:
    return root / "modules" / module_id / "module.circuit.json"


def schematic_overrides_path(root: Path, module_id: str) -> Path:
    return root / "modules" / module_id / "schematic.overrides.json"


def ensure_inside(root: Path, candidate: Path) -> None:
    try:
        candidate.resolve().relative_to(root.resolve())
    except ValueError as exc:
        raise ValueError(f"path escapes project root: {candidate}") from exc


def validate_project(project: dict[str, Any]) -> None:
    if project.get("schema") not in LEGACY_PROJECT_SCHEMAS:
        raise ValueError(f"project schema must be one of {sorted(LEGACY_PROJECT_SCHEMAS)}")
    if not isinstance(project.get("project_id"), str) or not project["project_id"]:
        raise ValueError("project_id is required")
    if not isinstance(project.get("revision"), int) or project["revision"] < 0:
        raise ValueError("project revision must be a non-negative integer")
    modules = project.get("modules")
    if not isinstance(modules, list):
        raise ValueError("project modules must be an array")
    module_ids = [entry.get("id") for entry in modules if isinstance(entry, dict)]
    if len(module_ids) != len(set(module_ids)) or any(not value for value in module_ids):
        raise ValueError("module ids must be present and unique")

    port_keys: set[tuple[str, str]] = set()
    for module in modules:
        for port in module.get("ports", []):
            key = (module["id"], port.get("id"))
            if not key[1] or key in port_keys:
                raise ValueError("module port ids must be present and unique")
            port_keys.add(key)
    connection_ids: set[str] = set()
    for connection in project.get("connections", []):
        connection_id = connection.get("id")
        if not connection_id or connection_id in connection_ids:
            raise ValueError("connection ids must be present and unique")
        connection_ids.add(connection_id)
        for endpoint_name in ("from", "to"):
            endpoint = connection.get(endpoint_name, {})
            key = (endpoint.get("module_id"), endpoint.get("port_id"))
            if key not in port_keys:
                raise ValueError(f"connection references unknown port: {key}")


def validate_module(module: dict[str, Any]) -> None:
    if module.get("schema") not in LEGACY_MODULE_SCHEMAS:
        raise ValueError(f"module schema must be one of {sorted(LEGACY_MODULE_SCHEMAS)}")
    if not isinstance(module.get("module_id"), str) or not module["module_id"]:
        raise ValueError("module_id is required")
    nets = module.get("nets", [])
    if not isinstance(nets, list):
        raise ValueError("module nets must be an array")
    net_names_by_id: dict[str, set[str]] = {}
    used_net_names: dict[str, str] = {}
    for net in nets:
        if not isinstance(net, dict):
            raise ValueError("module nets must contain objects")
        net_id = net.get("id")
        net_name = net.get("name")
        if not isinstance(net_id, str) or not net_id or net_id in net_names_by_id:
            raise ValueError("net ids must be present and unique")
        if not isinstance(net_name, str) or not net_name:
            raise ValueError(f"net {net_id} must have a name")
        aliases = net.get("aliases", [])
        if not isinstance(aliases, list) or any(not isinstance(alias, str) or not alias for alias in aliases):
            raise ValueError(f"net {net_id} aliases must be non-empty strings")
        names = {net_name, *aliases}
        for name in names:
            previous = used_net_names.get(name)
            if previous is not None and previous != net_id:
                raise ValueError(f"net name or alias {name} belongs to multiple nets")
            used_net_names[name] = net_id
        net_names_by_id[net_id] = names

    def validate_net_reference(owner: str, net_name: Any, net_id: Any, *, required: bool = False) -> None:
        if not isinstance(net_name, str) or not net_name:
            raise ValueError(f"{owner} has no net")
        if net_id is None and not required:
            return
        if not isinstance(net_id, str) or not net_id:
            raise ValueError(f"{owner} has no net_id")
        names = net_names_by_id.get(net_id)
        if names is None:
            raise ValueError(f"{owner} references unknown net_id: {net_id}")
        if net_name not in names:
            raise ValueError(f"{owner} net/name mismatch: {net_name} is not {net_id}")

    component_ids: set[str] = set()
    pin_keys: set[tuple[str, str]] = set()
    pin_networks: dict[tuple[str, str], tuple[str, str | None]] = {}
    for component in module.get("components", []):
        component_id = component.get("id")
        component_type = component.get("type")
        if not component_id or component_id in component_ids:
            raise ValueError("component ids must be present and unique")
        if component_type not in ALLOWED_COMPONENT_TYPES:
            raise ValueError(f"unsupported component type: {component_type}")
        component_ids.add(component_id)
        pins = component.get("pins", [])
        if not isinstance(pins, list) or not pins:
            raise ValueError(f"component {component_id} must have at least one pin")
        for pin in pins:
            pin_id = pin.get("id")
            key = (component_id, pin_id)
            if not pin_id or key in pin_keys:
                raise ValueError("component pin ids must be present and unique")
            if not isinstance(pin.get("net"), str) or not pin["net"]:
                raise ValueError(f"pin {component_id}.{pin_id} has no net")
            validate_net_reference(
                f"pin {component_id}.{pin_id}",
                pin.get("net"),
                pin.get("net_id"),
            )
            side = pin.get("side")
            if side is not None and side not in BLOCK_PIN_SIDES:
                raise ValueError(f"pin {component_id}.{pin_id} has invalid side: {side}")
            pin_keys.add(key)
            pin_networks[key] = (str(pin["net"]), pin.get("net_id"))
        if component_type == "BLOCK":
            block = component.get("block", {})
            if not isinstance(block, dict):
                raise ValueError(f"block geometry for {component_id} must be an object")
            for dimension in ("width", "height"):
                value = block.get(dimension)
                if value is not None and (not isinstance(value, (int, float)) or value < 40 or value > 1000):
                    raise ValueError(f"block {component_id} {dimension} is outside 40..1000")
    port_ids = [port.get("id") for port in module.get("ports", [])]
    if len(port_ids) != len(set(port_ids)) or any(not value for value in port_ids):
        raise ValueError("module port ids must be present and unique")
    port_networks: dict[str, tuple[str, str | None]] = {}
    for port in module.get("ports", []):
        port_id = str(port["id"])
        validate_net_reference(f"port {port_id}", port.get("net"), port.get("net_id"))
        port_networks[port_id] = (str(port["net"]), port.get("net_id"))

    wires = module.get("wires", [])
    if not isinstance(wires, list):
        raise ValueError("module wires must be an array")
    wire_ids: set[str] = set()
    junctions: dict[str, tuple[float, float, str]] = {}
    wire_segments: list[tuple[tuple[float, float], tuple[float, float], str, str]] = []

    def coordinate(value: Any, owner: str) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            raise ValueError(f"{owner} must be a finite number")
        return float(value)

    def endpoint_network(endpoint: Any, owner: str, wire_net: str, wire_net_id: str) -> tuple[float, float]:
        if not isinstance(endpoint, dict):
            raise ValueError(f"{owner} must be an endpoint object")
        x = coordinate(endpoint.get("x"), f"{owner}.x")
        y = coordinate(endpoint.get("y"), f"{owner}.y")
        component_id = endpoint.get("component_id")
        pin_id = endpoint.get("pin_id")
        port_id = endpoint.get("port_id")
        junction_id = endpoint.get("junction_id")
        has_pin_fields = component_id is not None or pin_id is not None
        identities = int(has_pin_fields) + int(port_id is not None) + int(junction_id is not None)
        if identities != 1:
            raise ValueError(f"{owner} must identify exactly one component pin, port, or junction_id")

        endpoint_net: str
        endpoint_net_id: str | None
        if has_pin_fields:
            if not isinstance(component_id, str) or not component_id:
                raise ValueError(f"{owner} references an invalid component")
            if component_id not in component_ids:
                raise ValueError(f"{owner} references unknown component: {component_id}")
            if not isinstance(pin_id, str) or not pin_id:
                raise ValueError(f"{owner} references an invalid pin")
            network = pin_networks.get((component_id, pin_id))
            if network is None:
                raise ValueError(f"{owner} references unknown pin: {component_id}.{pin_id}")
            endpoint_net, endpoint_net_id = network
        elif port_id is not None:
            if not isinstance(port_id, str) or not port_id or port_id not in port_networks:
                raise ValueError(f"{owner} references unknown port: {port_id}")
            endpoint_net, endpoint_net_id = port_networks[port_id]
        else:
            if not isinstance(junction_id, str) or not junction_id:
                raise ValueError(f"{owner} has an invalid junction_id")
            previous = junctions.get(junction_id)
            if previous is not None:
                previous_x, previous_y, previous_net_id = previous
                if x != previous_x or y != previous_y:
                    raise ValueError(f"junction {junction_id} is used at multiple coordinates")
                if wire_net_id != previous_net_id:
                    raise ValueError(f"junction {junction_id} is used by inconsistent networks")
            else:
                junctions[junction_id] = (x, y, wire_net_id)
            endpoint_net, endpoint_net_id = wire_net, wire_net_id

        if endpoint_net_id is not None and endpoint_net_id != wire_net_id:
            raise ValueError(f"{owner} network does not match wire network {wire_net_id}")
        endpoint_names = net_names_by_id.get(wire_net_id, set())
        if endpoint_net not in endpoint_names or wire_net not in endpoint_names:
            raise ValueError(f"{owner} network does not match wire net/name")
        return x, y

    for wire in wires:
        if not isinstance(wire, dict):
            raise ValueError("module wires must contain objects")
        wire_id = wire.get("id")
        if not isinstance(wire_id, str) or not wire_id or wire_id in wire_ids:
            raise ValueError("wire ids must be present and unique")
        wire_ids.add(wire_id)
        wire_net = wire.get("net")
        wire_net_id = wire.get("net_id")
        validate_net_reference(f"wire {wire_id}", wire_net, wire_net_id, required=True)
        points = wire.get("points")
        if not isinstance(points, list) or len(points) < 2:
            raise ValueError(f"wire {wire_id} must have at least two points")
        normalized_points: list[tuple[float, float]] = []
        for index, point in enumerate(points):
            if not isinstance(point, dict):
                raise ValueError(f"wire {wire_id} point {index} must be an object")
            normalized_points.append((
                coordinate(point.get("x"), f"wire {wire_id} point {index}.x"),
                coordinate(point.get("y"), f"wire {wire_id} point {index}.y"),
            ))
        for index, (start, end) in enumerate(zip(normalized_points, normalized_points[1:])):
            if start == end:
                raise ValueError(f"wire {wire_id} has a zero-length segment at {index}")
            if start[0] != end[0] and start[1] != end[1]:
                raise ValueError(f"wire {wire_id} has a non-orthogonal segment at {index}")
            wire_segments.append((start, end, str(wire_id), str(wire_net_id)))
        start_endpoint = endpoint_network(wire.get("from"), f"wire {wire_id}.from", str(wire_net), str(wire_net_id))
        end_endpoint = endpoint_network(wire.get("to"), f"wire {wire_id}.to", str(wire_net), str(wire_net_id))
        if normalized_points[0] != start_endpoint:
            raise ValueError(f"wire {wire_id} first point does not match from endpoint")
        if normalized_points[-1] != end_endpoint:
            raise ValueError(f"wire {wire_id} last point does not match to endpoint")

    def different_net_contact(
        left: tuple[tuple[float, float], tuple[float, float], str, str],
        right: tuple[tuple[float, float], tuple[float, float], str, str],
    ) -> str | None:
        (a, b, _, left_net), (c, d, _, right_net) = left, right
        if left_net == right_net:
            return None
        left_vertical = a[0] == b[0]
        right_vertical = c[0] == d[0]
        if left_vertical == right_vertical:
            same_axis = a[0] == c[0] if left_vertical else a[1] == c[1]
            if not same_axis:
                return None
            left_interval = sorted((a[1], b[1])) if left_vertical else sorted((a[0], b[0]))
            right_interval = sorted((c[1], d[1])) if right_vertical else sorted((c[0], d[0]))
            lower = max(left_interval[0], right_interval[0])
            upper = min(left_interval[1], right_interval[1])
            if lower > upper:
                return None
            return "collinear overlap" if lower < upper else "shared endpoint"
        vertical_start, vertical_end, horizontal_start, horizontal_end = (a, b, c, d) if left_vertical else (c, d, a, b)
        x, y = vertical_start[0], horizontal_start[1]
        vertical_range = sorted((vertical_start[1], vertical_end[1]))
        horizontal_range = sorted((horizontal_start[0], horizontal_end[0]))
        if not (vertical_range[0] <= y <= vertical_range[1] and horizontal_range[0] <= x <= horizontal_range[1]):
            return None
        if vertical_range[0] < y < vertical_range[1] and horizontal_range[0] < x < horizontal_range[1]:
            return None
        return "endpoint on foreign segment"

    for index, left in enumerate(wire_segments):
        for right in wire_segments[index + 1:]:
            contact = different_net_contact(left, right)
            if contact:
                raise ValueError(
                    f"wires {left[2]} and {right[2]} form a different-net {contact} "
                    f"between {left[3]} and {right[3]}"
                )


def stable_net_token(value: str) -> str:
    token = re.sub(r"[^A-Za-z0-9_]+", "_", value).strip("_") or "net"
    return f"net_{token}"


def upgrade_module_document(
    module: dict[str, Any],
    *,
    repair_legacy_wire_endpoints: bool = False,
    repair_invalid_net_ids: bool = False,
) -> dict[str, Any]:
    existing = {
        str(net.get("id")): dict(net)
        for net in module.get("nets", [])
        if isinstance(net, dict) and net.get("id") and net.get("name")
    }
    by_name: dict[str, str] = {}
    for net_id, net in existing.items():
        by_name[str(net["name"])] = net_id
        for alias in net.get("aliases", []):
            by_name[str(alias)] = net_id

    def ensure_net(name: str, current_id: Any = None, kind: str = "signal") -> str:
        if current_id:
            normalized_id = str(current_id)
            if normalized_id in existing:
                return normalized_id
            if not repair_invalid_net_ids:
                return normalized_id
        if name in by_name:
            return by_name[name]
        base = stable_net_token(name)
        net_id = base
        suffix = 2
        while net_id in existing:
            net_id = f"{base}_{suffix}"
            suffix += 1
        existing[net_id] = {
            "id": net_id,
            "name": name,
            "kind": "ground" if name == "0" else kind,
            "aliases": [],
        }
        by_name[name] = net_id
        return net_id

    for component in module.get("components", []):
        for pin in component.get("pins", []):
            pin["net_id"] = ensure_net(str(pin.get("net", "")), pin.get("net_id"))
    for port in module.get("ports", []):
        net_id = ensure_net(str(port.get("net", "")), port.get("net_id"), str(port.get("signal_type", "signal")))
        port["net_id"] = net_id
        if existing[net_id].get("kind") in (None, "signal"):
            existing[net_id]["kind"] = port.get("signal_type", "signal")
    for wire in module.get("wires", []):
        wire["net_id"] = ensure_net(str(wire.get("net") or f"n_{wire.get('id', 'wire')}"), wire.get("net_id"))
        if not repair_legacy_wire_endpoints:
            continue
        for endpoint_name in ("from", "to"):
            endpoint = wire.get(endpoint_name)
            if not isinstance(endpoint, dict):
                continue
            if any(endpoint.get(key) for key in ("component_id", "pin_id", "port_id", "junction_id")):
                continue
            x = endpoint.get("x")
            y = endpoint.get("y")
            if isinstance(x, bool) or isinstance(y, bool) or not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
                continue
            payload = "|".join((
                str(wire["net_id"]),
                format(float(x), ".12g"),
                format(float(y), ".12g"),
            ))
            endpoint["junction_id"] = f"j_{hashlib.sha256(payload.encode('utf-8')).hexdigest()[:16]}"
    module["schema"] = MODULE_SCHEMA
    module["nets"] = list(existing.values())
    return module


def default_schematic_overrides(project: dict[str, Any], module_id: str) -> dict[str, Any]:
    return {
        "schema": SCHEMATIC_OVERRIDES_SCHEMA,
        "project_id": project["project_id"],
        "module_id": module_id,
        "updated_at": utc_now(),
        "items": {},
    }


def read_schematic_overrides(root: Path, project: dict[str, Any], module_id: str) -> dict[str, Any]:
    path = schematic_overrides_path(root, module_id)
    if not path.exists():
        return default_schematic_overrides(project, module_id)
    overrides = read_json(path)
    if overrides.get("schema") != SCHEMATIC_OVERRIDES_SCHEMA:
        raise ValueError(f"schematic overrides schema must be {SCHEMATIC_OVERRIDES_SCHEMA}")
    if overrides.get("module_id") != module_id:
        raise ValueError(f"schematic overrides module mismatch: {module_id}")
    if not isinstance(overrides.get("items"), dict):
        raise ValueError("schematic overrides items must be an object")
    return overrides


def normalize_schematic_item_id(value: Any) -> str:
    item_id = str(value or "").strip()
    if not re.match(r"^[A-Za-z0-9_.$:-]+$", item_id):
        raise ValueError(f"invalid schematic item id: {item_id}")
    return item_id


def schematic_position(value: Any, name: str) -> float:
    number = float(value)
    if number < -10000 or number > 10000:
        raise ValueError(f"{name} is outside the editable schematic range")
    return round(number, 3)


def load_project(root: Path) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    project = read_json(project_path(root))
    validate_project(project)
    modules: dict[str, dict[str, Any]] = {}
    for module_ref in project["modules"]:
        path = module_path(root, module_ref["id"])
        ensure_inside(root, path)
        source_module = read_json(path)
        if source_module.get("schema") not in LEGACY_MODULE_SCHEMAS:
            raise ValueError(f"module schema must be one of {sorted(LEGACY_MODULE_SCHEMAS)}")
        module = upgrade_module_document(
            source_module,
            repair_legacy_wire_endpoints=True,
            repair_invalid_net_ids=True,
        )
        validate_module(module)
        if module["module_id"] != module_ref["id"]:
            raise ValueError(f"module id mismatch: {module_ref['id']}")
        modules[module_ref["id"]] = module
        module_ref["ports"] = modules[module_ref["id"]].get("ports", [])
    project["schema"] = PROJECT_SCHEMA
    return project, modules


def make_port(port_id: str, name: str, direction: str, signal_type: str, net: str) -> dict[str, Any]:
    return {
        "id": port_id,
        "name": name,
        "direction": direction,
        "signal_type": signal_type,
        "net": net,
    }


def make_component(
    component_id: str,
    component_type: str,
    name: str,
    value: str,
    x: int,
    y: int,
    pins: list[tuple[str, str, str]],
) -> dict[str, Any]:
    return {
        "id": component_id,
        "type": component_type,
        "name": name,
        "value": value,
        "position": {"x": x, "y": y},
        "rotation": 0,
        "pins": [{"id": pin_id, "name": pin_name, "net": net} for pin_id, pin_name, net in pins],
    }


def demo_modules() -> list[tuple[dict[str, Any], dict[str, Any]]]:
    power_ports = [
        make_port("signal_out", "Signal", "output", "analog", "signal"),
        make_port("vdd", "VDD", "output", "power", "vdd"),
        make_port("gnd", "GND", "bidirectional", "ground", "0"),
    ]
    power = {
        "schema": MODULE_SCHEMA,
        "module_id": "power",
        "name": "Power and stimulus",
        "revision": 0,
        "ports": power_ports,
        "components": [
            make_component("v_signal", "V", "Vsignal", "DC 0 AC 1", 120, 120, [
                ("p", "+", "signal"), ("n", "-", "0"),
            ]),
            make_component("v_supply", "V", "VDD", "DC 5", 120, 260, [
                ("p", "+", "vdd"), ("n", "-", "0"),
            ]),
        ],
        "wires": [],
        "annotations": [],
    }
    power_ref = {
        "id": "power",
        "name": power["name"],
        "kind": "power",
        "function": "Provides the AC stimulus and the shared 5 V supply for the signal chain.",
        "parameters": {
            "Supply": "5 V",
            "Stimulus": "AC 1 V",
        },
        "notes": "",
        "preview_enabled": True,
        "source": "modules/power/module.circuit.json",
        "position": {"x": 100, "y": 120},
        "size": {"width": 320, "height": 250},
        "ports": power_ports,
    }

    amplifier_ports = [
        make_port("input", "IN", "input", "analog", "in"),
        make_port("vdd", "VDD", "input", "power", "vdd"),
        make_port("output", "OUT", "output", "analog", "out"),
        make_port("gnd", "GND", "bidirectional", "ground", "0"),
    ]
    amplifier = {
        "schema": MODULE_SCHEMA,
        "module_id": "amplifier",
        "name": "Passive gain stage",
        "revision": 0,
        "ports": amplifier_ports,
        "components": [
            make_component("r_series", "R", "Rseries", "1k", 60, 120, [
                ("a", "1", "in"), ("b", "2", "out"),
            ]),
            make_component("r_bias", "R", "Rbias", "10k", 210, 220, [
                ("a", "1", "out"), ("b", "2", "0"),
            ]),
        ],
        "wires": [],
        "annotations": [],
    }
    amplifier_ref = {
        "id": "amplifier",
        "name": amplifier["name"],
        "kind": "amplifier",
        "function": "Sets the inter-stage impedance and provides passive signal conditioning.",
        "parameters": {
            "Series resistance": "1 kohm",
            "Bias resistance": "10 kohm",
        },
        "notes": "",
        "preview_enabled": False,
        "source": "modules/amplifier/module.circuit.json",
        "position": {"x": 500, "y": 300},
        "size": {"width": 320, "height": 250},
        "ports": amplifier_ports,
    }

    filter_ports = [
        make_port("input", "IN", "input", "analog", "in"),
        make_port("vdd", "VDD", "input", "power", "vdd"),
        make_port("output", "OUT", "output", "analog", "out"),
        make_port("gnd", "GND", "bidirectional", "ground", "0"),
    ]
    filter_module = {
        "schema": MODULE_SCHEMA,
        "module_id": "filter",
        "name": "RC low-pass filter",
        "revision": 0,
        "ports": filter_ports,
        "components": [
            make_component("r_filter", "R", "Rfilter", "10k", 60, 120, [
                ("a", "1", "in"), ("b", "2", "out"),
            ]),
            make_component("c_filter", "C", "Cfilter", "15.9n", 210, 220, [
                ("a", "1", "out"), ("b", "2", "0"),
            ]),
        ],
        "wires": [],
        "annotations": [],
    }
    filter_ref = {
        "id": "filter",
        "name": filter_module["name"],
        "kind": "filter",
        "function": "Attenuates high-frequency content with a first-order RC low-pass response.",
        "parameters": {
            "Resistance": "10 kohm",
            "Capacitance": "15.9 nF",
            "Target cutoff": "about 1 kHz",
        },
        "notes": "",
        "preview_enabled": True,
        "source": "modules/filter/module.circuit.json",
        "position": {"x": 900, "y": 120},
        "size": {"width": 320, "height": 250},
        "ports": filter_ports,
    }
    return [(power_ref, power), (amplifier_ref, amplifier), (filter_ref, filter_module)]


def initialize_project(projects_root: Path, name: str, project_id: str | None, demo: bool) -> Path:
    base_id = slugify(project_id or name)
    selected_id = base_id
    suffix = 2
    while (projects_root / selected_id).exists():
        selected_id = f"{base_id}-{suffix}"
        suffix += 1
    root = projects_root / selected_id
    (root / "modules").mkdir(parents=True, exist_ok=False)
    for directory in ("commands/pending", "commands/applied", "commands/rejected", "revisions", "build", "logs"):
        (root / directory).mkdir(parents=True, exist_ok=True)

    module_pairs = demo_modules() if demo else []
    now = utc_now()
    project = {
        "schema": PROJECT_SCHEMA,
        "project_id": selected_id,
        "name": name.strip() or selected_id,
        "revision": 0,
        "created_at": now,
        "updated_at": now,
        "modules": [pair[0] for pair in module_pairs],
        "connections": [],
        "analyses": {
            "ac": {"enabled": True, "start_hz": 10, "stop_hz": 1_000_000, "points_per_decade": 20},
        },
    }
    if demo:
        project["connections"] = [
            {
                "id": "signal-to-amplifier",
                "from": {"module_id": "power", "port_id": "signal_out"},
                "to": {"module_id": "amplifier", "port_id": "input"},
                "network": "SIGNAL",
            },
            {
                "id": "amplifier-to-filter",
                "from": {"module_id": "amplifier", "port_id": "output"},
                "to": {"module_id": "filter", "port_id": "input"},
                "network": "AMP_OUT",
            },
            {
                "id": "vdd-power-amplifier",
                "from": {"module_id": "power", "port_id": "vdd"},
                "to": {"module_id": "amplifier", "port_id": "vdd"},
                "network": "VDD",
            },
            {
                "id": "vdd-power-filter",
                "from": {"module_id": "power", "port_id": "vdd"},
                "to": {"module_id": "filter", "port_id": "vdd"},
                "network": "VDD",
            },
            {
                "id": "ground-power-amplifier",
                "from": {"module_id": "power", "port_id": "gnd"},
                "to": {"module_id": "amplifier", "port_id": "gnd"},
                "network": "GND",
            },
            {
                "id": "ground-power-filter",
                "from": {"module_id": "power", "port_id": "gnd"},
                "to": {"module_id": "filter", "port_id": "gnd"},
                "network": "GND",
            },
        ]
    validate_project(project)
    atomic_write_json(project_path(root), project)
    atomic_write_json(root / "project.settings.json", {"schema": "actoviq.project-settings.v1"})
    for module_ref, module in module_pairs:
        validate_module(module)
        atomic_write_json(module_path(root, module_ref["id"]), module)
    return root


def snapshot_revision(root: Path, project: dict[str, Any], modules: dict[str, dict[str, Any]], command: dict[str, Any]) -> Path:
    next_revision = project["revision"] + 1
    revision_root = root / "revisions" / f"{next_revision:06d}"
    snapshot_root = revision_root / "snapshot"
    atomic_write_json(snapshot_root / "project.circuit.json", project)
    for module_id, module in modules.items():
        atomic_write_json(snapshot_root / "modules" / module_id / "module.circuit.json", module)
        notebook_path = root / "modules" / module_id / "netlist-notebook.md"
        if notebook_path.exists():
            atomic_write_text(
                snapshot_root / "modules" / module_id / "netlist-notebook.md",
                notebook_path.read_text(encoding="utf-8"),
            )
        overrides_path = schematic_overrides_path(root, module_id)
        if overrides_path.exists():
            atomic_write_json(
                snapshot_root / "modules" / module_id / "schematic.overrides.json",
                read_json(overrides_path),
            )
    atomic_write_json(revision_root / "command.json", command)
    atomic_write_json(revision_root / "metadata.json", {
        "schema": "actoviq.revision.v1",
        "revision": next_revision,
        "base_revision": project["revision"],
        "actor": command.get("actor", "unknown"),
        "message": command.get("message", ""),
        "created_at": utc_now(),
    })
    return revision_root


def write_revision_result(
    revision_root: Path,
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    notebook_writes: dict[str, str | None] | None = None,
) -> None:
    result_root = revision_root / "result"
    atomic_write_json(result_root / "project.circuit.json", project)
    digest = hashlib.sha256(json.dumps(project, ensure_ascii=False, sort_keys=True).encode("utf-8"))
    project_root = revision_root.parent.parent
    for module_id, module in sorted(modules.items()):
        atomic_write_json(result_root / "modules" / module_id / "module.circuit.json", module)
        digest.update(json.dumps(module, ensure_ascii=False, sort_keys=True).encode("utf-8"))
        notebook = (notebook_writes or {}).get(module_id)
        if module_id not in (notebook_writes or {}):
            current_notebook = project_root / "modules" / module_id / "netlist-notebook.md"
            if current_notebook.exists():
                notebook = current_notebook.read_text(encoding="utf-8")
        if notebook is not None:
            atomic_write_text(result_root / "modules" / module_id / "netlist-notebook.md", notebook)
            digest.update(notebook.encode("utf-8"))
        current_overrides = schematic_overrides_path(project_root, module_id)
        if current_overrides.exists():
            overrides = read_json(current_overrides)
            atomic_write_json(result_root / "modules" / module_id / "schematic.overrides.json", overrides)
            digest.update(json.dumps(overrides, ensure_ascii=False, sort_keys=True).encode("utf-8"))
    metadata_path = revision_root / "metadata.json"
    metadata = read_json(metadata_path)
    metadata["schema"] = "actoviq.revision.v2"
    metadata["document_hash"] = digest.hexdigest()
    metadata["result_snapshot"] = "result/"
    atomic_write_json(metadata_path, metadata)


def project_document_hash(project: dict[str, Any], modules: dict[str, dict[str, Any]]) -> str:
    digest = hashlib.sha256(json.dumps(project, ensure_ascii=False, sort_keys=True).encode("utf-8"))
    for module_id, module in sorted(modules.items()):
        digest.update(module_id.encode("utf-8"))
        digest.update(json.dumps(module, ensure_ascii=False, sort_keys=True).encode("utf-8"))
    return digest.hexdigest()


def erc_diagnostic(
    diagnostics: list[dict[str, Any]],
    severity: str,
    code: str,
    message: str,
    **location: Any,
) -> None:
    target = ".".join(
        str(location[key]) for key in ("module_id", "component_id", "pin_id", "port_id")
        if location.get(key)
    ) or "project"
    diagnostics.append({
        "id": f"{code}:{target}",
        "severity": severity,
        "code": code,
        "message": message,
        **{key: value for key, value in location.items() if value is not None},
    })


def component_model_name(component: dict[str, Any]) -> str:
    component_type = str(component.get("type", "")).upper()
    raw = str((component.get("spice") or {}).get("raw", "")).strip()
    tokens = raw.split()
    token_index = {"D": 3, "Q": 4, "M": 5}.get(component_type)
    if token_index is not None and len(tokens) > token_index:
        return tokens[token_index]
    value = str(component.get("value", "")).strip()
    return value.split()[0] if value else ""


def module_spice_text(module: dict[str, Any]) -> str:
    spice = module.get("spice") or {}
    source = str(spice.get("source", "")).strip()
    if source:
        return source
    lines: list[str] = []
    for component in module.get("components", []):
        if component.get("type") == "BLOCK":
            continue
        pins = " ".join(str(pin.get("net", "")) for pin in component.get("pins", []))
        lines.append(
            f"{component.get('name', component.get('id', 'X'))} {pins} {component.get('value', '')}".strip()
        )
    lines.extend(str(line) for line in spice.get("models", []))
    lines.extend(str(line) for line in spice.get("directives", []))
    lines.extend(str(line) for line in spice.get("opaque", []))
    return "\n".join(lines)


def evaluate_erc(
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    diagnostics: list[dict[str, Any]] = []
    any_components = any(module.get("components") for module in modules.values())
    has_ground = False
    endpoint_adjacency: dict[str, set[str]] = {}
    port_lookup: dict[str, dict[str, Any]] = {}

    for module_ref in project.get("modules", []):
        module_id = str(module_ref.get("id", ""))
        for port in module_ref.get("ports", []):
            endpoint = f"{module_id}:{port.get('id', '')}"
            port_lookup[endpoint] = port
            endpoint_adjacency.setdefault(endpoint, set())
            if port.get("signal_type") == "ground" or str(port.get("net", "")).lower() in {"0", "gnd"}:
                has_ground = True
    for connection in project.get("connections", []):
        left = connection.get("from", {})
        right = connection.get("to", {})
        left_key = f"{left.get('module_id', '')}:{left.get('port_id', '')}"
        right_key = f"{right.get('module_id', '')}:{right.get('port_id', '')}"
        endpoint_adjacency.setdefault(left_key, set()).add(right_key)
        endpoint_adjacency.setdefault(right_key, set()).add(left_key)

    output_endpoints = {
        endpoint for endpoint, port in port_lookup.items()
        if port.get("direction") in {"output", "bidirectional"}
    }

    for module_id, module in modules.items():
        net_usage: dict[str, list[dict[str, str]]] = {}
        local_driven_nets: set[str] = set()
        net_names: dict[str, str] = {}
        critical_candidates: list[tuple[dict[str, Any], dict[str, Any], str, str]] = []
        for net in module.get("nets", []):
            net_id = str(net.get("id", ""))
            net_name = str(net.get("name", ""))
            net_names[net_id] = net_name
            if net_name.lower() in {"0", "gnd"} or net.get("kind") == "ground":
                has_ground = True
            if net.get("conflict"):
                erc_diagnostic(
                    diagnostics,
                    "error",
                    "conflicting_net_labels",
                    f"Net {net_name or net_id} has conflicting labels: {', '.join(net.get('aliases') or [])}.",
                    module_id=module_id,
                    net_id=net_id,
                )
        for port in module.get("ports", []):
            net_id = str(port.get("net_id") or stable_net_token(str(port.get("net", ""))))
            net_usage.setdefault(net_id, []).append({"kind": "port", "id": str(port.get("id", ""))})
            net_names.setdefault(net_id, str(port.get("net", "")))
            if port.get("signal_type") == "ground" or str(port.get("net", "")).lower() in {"0", "gnd"}:
                has_ground = True
        for component in module.get("components", []):
            component_id = str(component.get("id", ""))
            component_type = str(component.get("type", "")).upper()
            for index, pin in enumerate(component.get("pins", [])):
                net_id = str(pin.get("net_id") or stable_net_token(str(pin.get("net", ""))))
                net_usage.setdefault(net_id, []).append({
                    "kind": "pin",
                    "id": f"{component_id}.{pin.get('id', '')}",
                })
                net_names.setdefault(net_id, str(pin.get("net", "")))
                if str(pin.get("net", "")).lower() in {"0", "gnd"}:
                    has_ground = True
                if component_type in {"V", "I"} and index == 0:
                    local_driven_nets.add(net_id)

            critical_pins = {
                "M": {"g": "error", "d": "warning", "s": "warning", "b": "warning"},
                "Q": {"b": "error", "c": "warning", "e": "warning"},
            }.get(component_type, {})
            for pin in component.get("pins", []):
                pin_id = str(pin.get("id", "")).lower()
                severity = critical_pins.get(pin_id)
                net_id = str(pin.get("net_id") or stable_net_token(str(pin.get("net", ""))))
                if severity:
                    critical_candidates.append((component, pin, net_id, severity))

            if component_type == "BLOCK":
                block_spice = component.get("spice") or {}
                if not block_spice.get("raw") or not block_spice.get("simulated"):
                    erc_diagnostic(
                        diagnostics,
                        "warning",
                        "block_not_simulated",
                        f"Block {component.get('name', component_id)} is schematic-only and does not participate in simulation.",
                        module_id=module_id,
                        component_id=component_id,
                    )

        for component, pin, net_id, severity in critical_candidates:
            if len(net_usage.get(net_id, [])) <= 1:
                erc_diagnostic(
                    diagnostics,
                    severity,
                    "floating_critical_pin",
                    f"{component.get('name', component.get('id'))} pin {pin.get('name', pin.get('id'))} is not connected.",
                    module_id=module_id,
                    component_id=component.get("id"),
                    pin_id=pin.get("id"),
                    net_id=net_id,
                )

        model_names = {
            match.group(1).lower()
            for line in (module.get("spice") or {}).get("models", [])
            if (match := re.match(r"(?i)^\s*\.model\s+(\S+)", str(line)))
        }
        for component in module.get("components", []):
            component_type = str(component.get("type", "")).upper()
            if component_type not in {"D", "Q", "M"}:
                continue
            model_name = component_model_name(component)
            if not model_name or "=" in model_name or model_name.lower() not in model_names:
                erc_diagnostic(
                    diagnostics,
                    "error",
                    "missing_device_model",
                    f"{component.get('name', component.get('id'))} references model {model_name or '(missing)'}, but no matching .model is preserved.",
                    module_id=module_id,
                    component_id=component.get("id"),
                    model=model_name or None,
                )

        for port in module.get("ports", []):
            if port.get("direction") != "input" or port.get("signal_type") == "ground":
                continue
            net_id = str(port.get("net_id") or stable_net_token(str(port.get("net", ""))))
            if net_id in local_driven_nets:
                continue
            endpoint = f"{module_id}:{port.get('id', '')}"
            visited = {endpoint}
            pending = [endpoint]
            externally_driven = False
            while pending:
                current = pending.pop()
                if current != endpoint and current in output_endpoints:
                    externally_driven = True
                    break
                for neighbor in endpoint_adjacency.get(current, set()):
                    if neighbor not in visited:
                        visited.add(neighbor)
                        pending.append(neighbor)
            if not externally_driven:
                erc_diagnostic(
                    diagnostics,
                    "warning",
                    "undriven_input",
                    f"Input {port.get('name', port.get('id'))} has no local source or connected output driver.",
                    module_id=module_id,
                    port_id=port.get("id"),
                    net_id=net_id,
                )

    if any_components and not has_ground:
        erc_diagnostic(
            diagnostics,
            "error",
            "missing_ground",
            "The circuit has components but no explicit SPICE ground node 0.",
        )

    spice_text = "\n".join(module_spice_text(module) for module in modules.values())
    directives = [
        line.strip() for line in spice_text.splitlines()
        if line.strip().startswith(".")
    ]
    source_names = {
        tokens[0].lower()
        for raw in spice_text.splitlines()
        if (tokens := raw.strip().split()) and tokens[0][:1].upper() in {"V", "I"}
    }
    for directive in directives:
        lowered = directive.lower()
        if lowered.startswith(".ac") and not re.search(
            r"(?im)^\s*[vi]\S+\s+\S+\s+\S+.*\bac(?:\s+|=)(?!0(?:\.0*)?(?:\s|$))",
            spice_text,
        ):
            erc_diagnostic(
                diagnostics,
                "error",
                "missing_ac_excitation",
                "AC analysis is configured, but no independent source has a non-zero AC value.",
            )
        elif lowered.startswith(".dc"):
            tokens = directive.split()
            if len(tokens) > 1 and tokens[1].lower() not in source_names:
                erc_diagnostic(
                    diagnostics,
                    "error",
                    "invalid_dc_source",
                    f"DC sweep references missing source {tokens[1]}.",
                )
        elif lowered.startswith(".tran") and not re.search(
            r"(?i)\b(?:pulse|sin|pwl|exp|sffm)\s*\(", spice_text
        ):
            erc_diagnostic(
                diagnostics,
                "warning",
                "missing_transient_excitation",
                "Transient analysis has no time-varying independent source.",
            )
        elif lowered.startswith(".sp") and not has_sparameter_ports(spice_text):
            erc_diagnostic(
                diagnostics,
                "error",
                "missing_sparameter_ports",
                "S-parameter analysis requires consecutive VSRC portnum ports with Z0.",
            )

    severity_order = {"error": 0, "warning": 1, "info": 2}
    diagnostics.sort(key=lambda item: (severity_order.get(item["severity"], 9), item["id"]))
    errors = sum(item["severity"] == "error" for item in diagnostics)
    warnings = sum(item["severity"] == "warning" for item in diagnostics)
    infos = sum(item["severity"] == "info" for item in diagnostics)
    return {
        "schema": ERC_SCHEMA,
        "source_revision": project["revision"],
        "document_hash": project_document_hash(project, modules),
        "status": "error" if errors else "warning" if warnings else "clean",
        "blocking": errors > 0,
        "summary": {"errors": errors, "warnings": warnings, "infos": infos},
        "diagnostics": diagnostics,
        "checked_at": utc_now(),
    }


def write_erc_result(
    root: Path,
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    result = evaluate_erc(project, modules)
    atomic_write_json(root / "build" / "erc.json", result)
    return result


def find_module_ref(project: dict[str, Any], module_id: str) -> dict[str, Any]:
    for module in project["modules"]:
        if module["id"] == module_id:
            return module
    raise ValueError(f"unknown module: {module_id}")


def set_connection_group_network(
    project: dict[str, Any],
    connection_id: str,
    network: str,
) -> None:
    label = network.strip()
    if not label:
        raise ValueError("system network name cannot be empty")
    connections = project.get("connections", [])
    target = next(
        (connection for connection in connections if connection.get("id") == connection_id),
        None,
    )
    if target is None:
        raise ValueError(f"unknown connection: {connection_id}")

    endpoints = {
        (target["from"]["module_id"], target["from"]["port_id"]),
        (target["to"]["module_id"], target["to"]["port_id"]),
    }
    connected: list[dict[str, Any]] = []
    changed = True
    while changed:
        changed = False
        for connection in connections:
            pair = {
                (connection["from"]["module_id"], connection["from"]["port_id"]),
                (connection["to"]["module_id"], connection["to"]["port_id"]),
            }
            if connection in connected or endpoints.isdisjoint(pair):
                continue
            connected.append(connection)
            endpoints.update(pair)
            changed = True
    for connection in connected:
        connection["network"] = label


def find_component(module: dict[str, Any], component_id: str) -> dict[str, Any]:
    for component in module["components"]:
        if component["id"] == component_id:
            return component
    raise ValueError(f"unknown component: {module['module_id']}.{component_id}")


def module_from_netlist_notebook(
    module_id: str,
    notebook: str,
    current: dict[str, Any],
) -> dict[str, Any]:
    netlist_text = extract_notebook_netlist(notebook)
    parsed_components = parse_editable_netlist_components(module_id, netlist_text, current)
    parsed_ids = {str(component.get("id")) for component in parsed_components}
    schematic_blocks = [
        component for component in current.get("components", [])
        if component.get("type") == "BLOCK" and str(component.get("id")) not in parsed_ids
    ]
    components = [*parsed_components, *schematic_blocks]
    if not components:
        raise ValueError("netlist contains no editable or preserved components")
    ports = infer_editable_ports(list(current.get("ports", [])), components)
    next_module = upgrade_module_document({
        **current,
        "schema": MODULE_SCHEMA,
        "module_id": module_id,
        "components": components,
        "ports": ports,
        "spice": parse_spice_source(module_id, netlist_text, components),
    })
    validate_module(next_module)
    return next_module


def apply_operation(
    root: Path,
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    operation: dict[str, Any],
    changed_modules: set[str],
    schematic_override_writes: dict[str, dict[str, Any]],
    notebook_writes: dict[str, str | None],
) -> None:
    op = operation.get("op")
    if op == "restore_revision":
        target_revision = int(operation.get("revision", -1))
        result_root = root / "revisions" / f"{target_revision:06d}" / "result"
        restored_project_path = result_root / "project.circuit.json"
        if target_revision < 1 or not restored_project_path.exists():
            raise ValueError(f"revision {target_revision} does not have a restorable result snapshot")
        current_project_id = project["project_id"]
        current_revision = project["revision"]
        current_created_at = project.get("created_at")
        current_module_revisions = {
            module_id: int(module.get("revision", 0))
            for module_id, module in modules.items()
        }
        restored_project = read_json(restored_project_path)
        restored_modules: dict[str, dict[str, Any]] = {}
        for module_ref in restored_project.get("modules", []):
            module_id = str(module_ref.get("id", ""))
            restored_module_path = result_root / "modules" / module_id / "module.circuit.json"
            if not module_id or not restored_module_path.exists():
                raise ValueError(f"revision {target_revision} is missing module {module_id or '<unknown>'}")
            restored_module = read_json(restored_module_path)
            restored_module["revision"] = current_module_revisions.get(
                module_id,
                int(restored_module.get("revision", 0)),
            )
            restored_modules[module_id] = restored_module
            restored_notebook = result_root / "modules" / module_id / "netlist-notebook.md"
            if restored_notebook.exists():
                notebook_writes[module_id] = restored_notebook.read_text(encoding="utf-8")
            else:
                notebook_writes[module_id] = None
            restored_overrides = result_root / "modules" / module_id / "schematic.overrides.json"
            if restored_overrides.exists():
                schematic_override_writes[module_id] = read_json(restored_overrides)
            else:
                schematic_override_writes[module_id] = {
                    "schema": SCHEMATIC_OVERRIDES_SCHEMA,
                    "project_id": current_project_id,
                    "module_id": module_id,
                    "updated_at": utc_now(),
                    "items": {},
                }
        project.clear()
        project.update(restored_project)
        project["project_id"] = current_project_id
        project["revision"] = current_revision
        if current_created_at:
            project["created_at"] = current_created_at
        modules.clear()
        modules.update(restored_modules)
        changed_modules.update(restored_modules)
        return
    if op == "upsert_module":
        module_ref = operation["module_ref"]
        module = operation["module"]
        module_id = module_ref["id"]
        if module.get("module_id") != module_id:
            raise ValueError("upsert_module ids do not match")
        validate_module(module)
        project["modules"] = [
            entry for entry in project["modules"] if entry.get("id") != module_id
        ]
        project["modules"].append(module_ref)
        modules[module_id] = module
        changed_modules.add(module_id)
        return
    if op == "remove_module":
        module_id = operation["module_id"]
        find_module_ref(project, module_id)
        project["modules"] = [
            entry for entry in project["modules"] if entry.get("id") != module_id
        ]
        project["connections"] = [
            connection for connection in project.get("connections", [])
            if connection["from"]["module_id"] != module_id
            and connection["to"]["module_id"] != module_id
        ]
        modules.pop(module_id, None)
        return
    if op == "add_component":
        module_id = operation["module_id"]
        module = modules[module_id]
        component = operation["component"]
        if any(entry.get("id") == component.get("id") for entry in module["components"]):
            raise ValueError(f"component already exists: {component.get('id')}")
        module["components"].append(component)
        changed_modules.add(module_id)
        return
    if op == "remove_component":
        module_id = operation["module_id"]
        module = modules[module_id]
        component_id = operation["component_id"]
        before = len(module["components"])
        module["components"] = [
            component for component in module["components"]
            if component.get("id") != component_id
        ]
        if len(module["components"]) == before:
            raise ValueError(f"unknown component: {module_id}.{component_id}")
        changed_modules.add(module_id)
        return
    if op == "add_port":
        module_id = operation["module_id"]
        module = modules[module_id]
        port = operation["port"]
        if any(entry.get("id") == port.get("id") for entry in module.get("ports", [])):
            raise ValueError(f"port already exists: {module_id}.{port.get('id')}")
        module.setdefault("ports", []).append(port)
        find_module_ref(project, module_id).setdefault("ports", []).append(port)
        changed_modules.add(module_id)
        return
    if op == "move_module":
        module_ref = find_module_ref(project, operation["module_id"])
        module_ref["position"] = {"x": float(operation["x"]), "y": float(operation["y"])}
        return
    if op == "resize_module":
        module_ref = find_module_ref(project, operation["module_id"])
        width = float(operation["width"])
        height = float(operation["height"])
        if width <= 0 or height <= 0:
            raise ValueError("module size must be positive")
        module_ref["size"] = {"width": width, "height": height}
        return
    if op == "set_module_note":
        module_ref = find_module_ref(project, operation["module_id"])
        module_ref["notes"] = str(operation.get("notes", ""))
        return
    if op == "set_module_preview":
        module_ref = find_module_ref(project, operation["module_id"])
        module_ref["preview_enabled"] = bool(operation.get("enabled", True))
        return
    if op == "set_module_metadata":
        module_id = operation["module_id"]
        module_ref = find_module_ref(project, module_id)
        if "name" in operation:
            name = str(operation["name"]).strip()
            if not name:
                raise ValueError("module name cannot be empty")
            module_ref["name"] = name
            modules[module_id]["name"] = name
            changed_modules.add(module_id)
        if "kind" in operation:
            kind = str(operation["kind"]).strip()
            if not kind:
                raise ValueError("module kind cannot be empty")
            module_ref["kind"] = kind
        if "function" in operation:
            module_ref["function"] = str(operation["function"]).strip()
        if "parameters" in operation:
            parameters = operation["parameters"]
            if not isinstance(parameters, dict):
                raise ValueError("module parameters must be an object")
            module_ref["parameters"] = {
                str(key): str(value) for key, value in parameters.items()
            }
        return
    if op == "set_component_value":
        module_id = operation["module_id"]
        component = find_component(modules[module_id], operation["component_id"])
        value = str(operation["value"]).strip()
        if not value:
            raise ValueError("component value cannot be empty")
        component["value"] = value
        changed_modules.add(module_id)
        return
    if op == "move_component":
        module_id = operation["module_id"]
        component = find_component(modules[module_id], operation["component_id"])
        component["position"] = {"x": float(operation["x"]), "y": float(operation["y"])}
        changed_modules.add(module_id)
        return
    if op == "upsert_module_netlist":
        module_id = str(operation.get("module_id", "")).strip()
        if not module_id or not re.fullmatch(r"[A-Za-z0-9_.-]+", module_id):
            raise ValueError("upsert_module_netlist requires a stable module_id")
        notebook = operation.get("netlist_notebook")
        if not isinstance(notebook, str):
            raise ValueError("upsert_module_netlist netlist_notebook must be text")
        existing = modules.get(module_id, {
            "schema": MODULE_SCHEMA,
            "module_id": module_id,
            "name": str(operation.get("name") or module_id),
            "revision": 0,
            "ports": [],
            "components": [],
            "nets": [],
            "wires": [],
            "annotations": [],
        })
        existing = {
            **existing,
            "name": str(operation.get("name") or existing.get("name") or module_id).strip(),
        }
        next_module = module_from_netlist_notebook(module_id, notebook, existing)
        modules[module_id] = next_module
        previous_ref = next(
            (entry for entry in project.get("modules", []) if entry.get("id") == module_id),
            None,
        )
        module_ref = {
            **(previous_ref or {}),
            "id": module_id,
            "name": next_module["name"],
            "kind": str(operation.get("kind") or (previous_ref or {}).get("kind") or "circuit"),
            "function": str(operation.get("function") or (previous_ref or {}).get("function") or ""),
            "parameters": dict(operation.get("parameters") or (previous_ref or {}).get("parameters") or {}),
            "notes": str(operation.get("notes") or (previous_ref or {}).get("notes") or ""),
            "preview_enabled": bool(operation.get("preview_enabled", (previous_ref or {}).get("preview_enabled", True))),
            "source": f"modules/{module_id}/module.circuit.json",
            "position": dict(operation.get("position") or (previous_ref or {}).get("position") or {"x": 100, "y": 100}),
            "size": dict(operation.get("size") or (previous_ref or {}).get("size") or {"width": 360, "height": 280}),
            "ports": next_module["ports"],
        }
        project["modules"] = [
            entry for entry in project.get("modules", []) if entry.get("id") != module_id
        ]
        project["modules"].append(module_ref)
        notebook_writes[module_id] = notebook
        changed_modules.add(module_id)
        return
    if op == "set_module_schematic":
        module_id = operation["module_id"]
        module = modules[module_id]
        expected_connectivity_hash = operation.get("expected_connectivity_hash")
        connectivity_view = str(operation.get("connectivity_view", "design"))
        if expected_connectivity_hash is not None:
            if not isinstance(expected_connectivity_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_connectivity_hash):
                raise ValueError("set_module_schematic expected_connectivity_hash must be a SHA-256 hex digest")
            if connectivity_view not in {"design", "simulation"}:
                raise ValueError("set_module_schematic connectivity_view must be design or simulation")
            current_connectivity_hash = connectivity_hash(
                project,
                {module_id: module},
                module_id,
                connectivity_view,
            )
            if current_connectivity_hash != expected_connectivity_hash:
                raise ValueError("set_module_schematic source connectivity does not match the guarded layout hash")
        components = operation.get("components")
        ports = operation.get("ports")
        wires = operation.get("wires", [])
        nets = operation.get("nets", module.get("nets", []))
        annotations = operation.get("annotations", module.get("annotations", []))
        notebook = operation.get("netlist_notebook")
        if not isinstance(components, list):
            raise ValueError("set_module_schematic components must be an array")
        if not isinstance(ports, list):
            raise ValueError("set_module_schematic ports must be an array")
        if not isinstance(wires, list):
            raise ValueError("set_module_schematic wires must be an array")
        if not isinstance(nets, list):
            raise ValueError("set_module_schematic nets must be an array")
        if not isinstance(annotations, list):
            raise ValueError("set_module_schematic annotations must be an array")
        next_module = {
            **module,
            "components": components,
            "ports": ports,
            "wires": wires,
            "nets": nets,
            "annotations": annotations,
        }
        if notebook is not None:
            if not isinstance(notebook, str):
                raise ValueError("set_module_schematic netlist_notebook must be text")
            netlist_text = extract_notebook_netlist(notebook)
            next_module["spice"] = parse_spice_source(module_id, netlist_text, components)
            notebook_writes[module_id] = notebook
        next_module = upgrade_module_document(next_module)
        validate_module(next_module)
        if expected_connectivity_hash is not None:
            next_connectivity_hash = connectivity_hash(
                project,
                {module_id: next_module},
                module_id,
                connectivity_view,
            )
            if next_connectivity_hash != expected_connectivity_hash:
                raise ValueError("set_module_schematic layout update would change authoritative connectivity")
        module["components"] = components
        module["ports"] = ports
        module["wires"] = wires
        module["nets"] = nets
        module["annotations"] = annotations
        module["schema"] = next_module["schema"]
        module["nets"] = next_module.get("nets", [])
        if "spice" in next_module:
            module["spice"] = next_module["spice"]
        find_module_ref(project, module_id)["ports"] = ports
        changed_modules.add(module_id)
        return
    if op == "set_module_netlist":
        module_id = str(operation["module_id"])
        module = modules[module_id]
        notebook = operation.get("netlist_notebook")
        if not isinstance(notebook, str):
            raise ValueError("set_module_netlist netlist_notebook must be text")
        next_module = module_from_netlist_notebook(module_id, notebook, module)
        modules[module_id] = next_module
        find_module_ref(project, module_id)["ports"] = next_module["ports"]
        notebook_writes[module_id] = notebook
        changed_modules.add(module_id)
        return
    if op == "move_schematic_item":
        module_id = str(operation["module_id"])
        find_module_ref(project, module_id)
        if module_id not in modules:
            raise ValueError(f"unknown module: {module_id}")
        item_id = normalize_schematic_item_id(operation.get("item_id"))
        overrides = schematic_override_writes.get(module_id)
        if overrides is None:
            overrides = read_schematic_overrides(root, project, module_id)
        items = dict(overrides.get("items") or {})
        items[item_id] = {
            "x": schematic_position(operation.get("x"), "x"),
            "y": schematic_position(operation.get("y"), "y"),
            "locked": bool(operation.get("locked", True)),
        }
        overrides.update({
            "schema": SCHEMATIC_OVERRIDES_SCHEMA,
            "project_id": project["project_id"],
            "module_id": module_id,
            "updated_at": utc_now(),
            "items": items,
        })
        schematic_override_writes[module_id] = overrides
        changed_modules.add(module_id)
        return
    if op == "reset_schematic_item":
        module_id = str(operation["module_id"])
        find_module_ref(project, module_id)
        if module_id not in modules:
            raise ValueError(f"unknown module: {module_id}")
        item_id = normalize_schematic_item_id(operation.get("item_id"))
        overrides = schematic_override_writes.get(module_id)
        if overrides is None:
            overrides = read_schematic_overrides(root, project, module_id)
        items = dict(overrides.get("items") or {})
        items.pop(item_id, None)
        overrides.update({
            "schema": SCHEMATIC_OVERRIDES_SCHEMA,
            "project_id": project["project_id"],
            "module_id": module_id,
            "updated_at": utc_now(),
            "items": items,
        })
        schematic_override_writes[module_id] = overrides
        changed_modules.add(module_id)
        return
    if op == "connect_ports":
        source = operation["from"]
        target = operation["to"]
        find_module_ref(project, source["module_id"])
        find_module_ref(project, target["module_id"])
        endpoint_pair = {
            (source["module_id"], source["port_id"]),
            (target["module_id"], target["port_id"]),
        }
        existing = next(
            (
                connection for connection in project.get("connections", [])
                if {
                    (connection["from"]["module_id"], connection["from"]["port_id"]),
                    (connection["to"]["module_id"], connection["to"]["port_id"]),
                } == endpoint_pair
            ),
            None,
        )
        connection_id = (
            operation.get("connection_id")
            or (existing.get("id") if existing else None)
            or f"{source['module_id']}-{source['port_id']}-to-{target['module_id']}-{target['port_id']}"
        )
        project["connections"] = [
            connection for connection in project.get("connections", [])
            if connection.get("id") != connection_id
        ]
        connection = {"id": connection_id, "from": source, "to": target}
        network = str(operation.get("network") or (existing or {}).get("network") or "").strip()
        if network:
            connection["network"] = network
        project["connections"].append(connection)
        if network:
            set_connection_group_network(project, connection_id, network)
        return
    if op == "set_connection_network":
        set_connection_group_network(
            project,
            str(operation["connection_id"]),
            str(operation["network"]),
        )
        return
    if op == "connect_pins":
        module_id = operation["module_id"]
        module = modules[module_id]
        first = operation["first"]
        second = operation["second"]
        first_pin = next(
            pin for pin in find_component(module, first["component_id"])["pins"]
            if pin["id"] == first["pin_id"]
        )
        second_pin = next(
            pin for pin in find_component(module, second["component_id"])["pins"]
            if pin["id"] == second["pin_id"]
        )
        net_a = first_pin["net"]
        net_b = second_pin["net"]
        if net_a == net_b:
            changed_modules.add(module_id)
            return
        # Ground / node "0" must always survive a merge, regardless of click order,
        # so connecting a signal pin to ground never renames the ground reference.
        if net_b == "0":
            new_net, old_net = "0", net_a
        else:
            new_net, old_net = net_a, net_b
        for component in module["components"]:
            for pin in component["pins"]:
                if pin["net"] == old_net:
                    pin["net"] = new_net
        for port in module.get("ports", []):
            if port.get("net") == old_net:
                port["net"] = new_net
        changed_modules.add(module_id)
        return
    raise ValueError(f"unsupported operation: {op}")


class ProjectLock:
    """Best-effort cross-process lock so concurrent edits cannot clobber a revision."""

    def __init__(self, root: Path, timeout: float = 30.0) -> None:
        self.path = root / ".project.lock"
        self.timeout = timeout

    def __enter__(self) -> "ProjectLock":
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode("ascii"))
                os.close(fd)
                return self
            except FileExistsError:
                try:
                    stale = time.time() - self.path.stat().st_mtime > 60
                except FileNotFoundError:
                    continue
                if stale:
                    self.path.unlink(missing_ok=True)
                    continue
                if time.monotonic() >= deadline:
                    raise ValueError("project is locked by another operation; retry shortly")
                time.sleep(0.05)

    def __exit__(self, *_exc: Any) -> None:
        self.path.unlink(missing_ok=True)


def scan_driven_nodes(netlist: str) -> set[str]:
    """Collect node names already driven by a V/I source in a raw netlist."""
    driven: set[str] = set()
    for raw in netlist.splitlines():
        line = raw.strip()
        if not line or line.startswith("*") or line.startswith("."):
            continue
        tokens = line.split()
        if len(tokens) >= 2 and tokens[0][:1].upper() in {"V", "I"}:
            driven.add(tokens[1])
    return driven


def apply_command(root: Path, command: dict[str, Any]) -> dict[str, Any]:
    if command.get("schema") != COMMAND_SCHEMA:
        raise ValueError(f"command schema must be {COMMAND_SCHEMA}")
    with ProjectLock(root):
        return _apply_command_locked(root, command)


def _apply_command_locked(root: Path, command: dict[str, Any]) -> dict[str, Any]:
    project, modules = load_project(root)
    if command.get("project_id") != project["project_id"]:
        raise ValueError("command project_id does not match project")
    if command.get("base_revision") != project["revision"]:
        raise ValueError(
            f"stale revision: expected {project['revision']}, got {command.get('base_revision')}"
        )
    operations = command.get("operations")
    if not isinstance(operations, list) or not operations:
        raise ValueError("command operations must be a non-empty array")

    revision_root = snapshot_revision(root, project, modules, command)
    changed_modules: set[str] = set()
    schematic_override_writes: dict[str, dict[str, Any]] = {}
    notebook_writes: dict[str, str | None] = {}
    for operation in operations:
        apply_operation(
            root,
            project,
            modules,
            operation,
            changed_modules,
            schematic_override_writes,
            notebook_writes,
        )

    project["revision"] += 1
    project["updated_at"] = utc_now()
    for module_id in changed_modules:
        modules[module_id] = upgrade_module_document(modules[module_id])
        modules[module_id]["revision"] = int(modules[module_id].get("revision", 0)) + 1
        validate_module(modules[module_id])
    validate_project(project)
    for module_id, notebook in notebook_writes.items():
        notebook_path = root / "modules" / module_id / "netlist-notebook.md"
        if notebook is None:
            notebook_path.unlink(missing_ok=True)
        else:
            atomic_write_text(notebook_path, notebook)
    for module_id in changed_modules:
        atomic_write_json(module_path(root, module_id), modules[module_id])
    for module_id, overrides in schematic_override_writes.items():
        atomic_write_json(schematic_overrides_path(root, module_id), overrides)
    atomic_write_json(project_path(root), project)
    command_id = command.get("command_id") or f"command-{project['revision']:06d}"
    applied_path = root / "commands" / "applied" / f"{command_id}.json"
    atomic_write_json(applied_path, {**command, "applied_revision": project["revision"], "applied_at": utc_now()})
    write_revision_result(revision_root, project, modules, notebook_writes)
    erc = write_erc_result(root, project, modules)
    revision_metadata_path = revision_root / "metadata.json"
    revision_metadata = read_json(revision_metadata_path)
    revision_metadata["erc_status"] = erc["status"]
    revision_metadata["erc_summary"] = erc["summary"]
    atomic_write_json(revision_metadata_path, revision_metadata)
    return {
        "ok": True,
        "project_id": project["project_id"],
        "revision": project["revision"],
        "changed_modules": sorted(changed_modules),
        "command_path": str(applied_path),
        "erc": erc,
    }


class UnionFind:
    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def find(self, value: str) -> str:
        self.parent.setdefault(value, value)
        if self.parent[value] != value:
            self.parent[value] = self.find(self.parent[value])
        return self.parent[value]

    def union(self, left: str, right: str) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root != right_root:
            self.parent[right_root] = left_root


def sanitize_node(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_]+", "_", value).strip("_")
    return cleaned or "node"


def extract_notebook_netlist(markdown: str) -> str:
    blocks = [
        match.strip()
        for match in re.findall(
            r"```(?:spice|cir|netlist)\s*\r?\n([\s\S]*?)```",
            markdown,
            flags=re.IGNORECASE,
        )
        if match.strip()
    ]
    if not blocks:
        raise ValueError(
            "netlist notebook requires a fenced spice, cir, or netlist code block"
        )
    return "\n\n".join(blocks) + "\n"


def strip_spice_comment(line: str) -> str:
    stripped = line.strip()
    if not stripped or stripped.startswith(("*", ";", "//", "$")):
        return ""
    in_quote = False
    result: list[str] = []
    for char in line:
        if char == "'":
            in_quote = not in_quote
        if char == ";" and not in_quote:
            break
        result.append(char)
    return "".join(result).strip()


def merged_spice_lines(netlist_text: str) -> list[str]:
    lines: list[str] = []
    current = ""
    for raw in netlist_text.splitlines():
        stripped = raw.strip()
        if not stripped:
            if current:
                lines.append(current)
                current = ""
            continue
        if stripped.startswith("+"):
            if current:
                current = f"{current} {stripped[1:].strip()}"
            continue
        if current:
            lines.append(current)
        current = raw
    if current:
        lines.append(current)
    return lines


def compiled_component_name(module_id: str, component: dict[str, Any]) -> str:
    component_name = sanitize_node(f"{module_id}_{component['name']}")
    component_type = str(component["type"])
    if not component_name.upper().startswith(component_type):
        component_name = f"{component_type}{component_name}"
    return component_name


def editable_component_name(module_id: str, instance_name: str) -> str:
    component_type = instance_name[:1].upper()
    rest = instance_name[1:]
    module_prefix = f"{module_id}_".lower()
    if rest.lower().startswith(module_prefix):
        tail = rest[len(module_prefix):]
        return tail if tail.upper().startswith(component_type) else f"{component_type}{tail}"
    return instance_name


def editable_component_id(name: str, used_ids: set[str]) -> str:
    base = re.sub(r"[^a-z0-9_]+", "_", name.lower()).strip("_") or "component"
    candidate = base
    suffix = 2
    while candidate in used_ids:
        candidate = f"{base}_{suffix}"
        suffix += 1
    used_ids.add(candidate)
    return candidate


def parse_editable_netlist_components(
    module_id: str,
    netlist_text: str,
    existing_module: dict[str, Any],
) -> list[dict[str, Any]]:
    existing_by_name = {
        str(component.get("name", "")).lower(): component
        for component in existing_module.get("components", [])
    }
    existing_by_compiled = {
        compiled_component_name(module_id, component).lower(): component
        for component in existing_module.get("components", [])
        if component.get("name") and component.get("type")
    }
    used_ids: set[str] = set()
    parsed: list[dict[str, Any]] = []
    grid_index = 0

    for raw in merged_spice_lines(netlist_text):
        line = strip_spice_comment(raw)
        if not line or line.startswith("."):
            continue
        tokens = line.split()
        if len(tokens) < 3:
            continue
        instance = tokens[0]
        component_type = instance[:1].upper()
        if component_type not in EDITABLE_NODE_COUNTS:
            continue
        if instance.lower().startswith(EDITABLE_TESTBENCH_PREFIXES):
            continue
        node_count = EDITABLE_NODE_COUNTS[component_type]
        if len(tokens) < 1 + node_count:
            continue
        nodes = tokens[1:1 + node_count]
        value = " ".join(tokens[1 + node_count:]).strip() or "1"
        name = editable_component_name(module_id, instance)
        existing = existing_by_compiled.get(instance.lower()) or existing_by_name.get(name.lower())
        if existing:
            component_id = str(existing.get("id") or editable_component_id(name, used_ids))
            if component_id in used_ids:
                component_id = editable_component_id(name, used_ids)
            else:
                used_ids.add(component_id)
            position = existing.get("position") if isinstance(existing.get("position"), dict) else None
            rotation = existing.get("rotation", 0)
        else:
            component_id = editable_component_id(name, used_ids)
            position = {
                "x": 140 + (grid_index % 4) * 180,
                "y": 120 + (grid_index // 4) * 140,
            }
            rotation = 0
        grid_index += 1
        pin_names = EDITABLE_PIN_NAMES[component_type]
        pins = [
            {
                "id": pin_names[index][0] if index < len(pin_names) else f"p{index + 1}",
                "name": pin_names[index][1] if index < len(pin_names) else str(index + 1),
                "net": node,
            }
            for index, node in enumerate(nodes)
        ]
        parsed.append({
            "id": component_id,
            "type": component_type,
            "name": name,
            "value": value,
            "position": position,
            "rotation": rotation,
            "pins": pins,
        })
    return parsed


def parse_spice_source(
    module_id: str,
    netlist_text: str,
    components: list[dict[str, Any]],
) -> dict[str, Any]:
    known_instances = {
        compiled_component_name(module_id, component).lower()
        for component in components
        if component.get("type") != "BLOCK"
    }
    known_instances.update(
        str(component.get("name", "")).lower()
        for component in components
        if component.get("type") != "BLOCK"
    )
    models: list[str] = []
    directives: list[str] = []
    opaque: list[str] = []
    for raw in merged_spice_lines(netlist_text):
        line = strip_spice_comment(raw)
        if not line:
            continue
        low = line.lower()
        if low == ".end":
            continue
        if low.startswith((".model", ".param", ".include", ".lib", ".func")):
            models.append(line)
            continue
        if low.startswith("."):
            directives.append(line)
            continue
        instance = line.split(maxsplit=1)[0].lower()
        if instance not in known_instances:
            opaque.append(line)
    return {
        "source": netlist_text,
        "models": models,
        "directives": directives,
        "opaque": opaque,
        "generated_testbench": "standalone module testbench generated by circuit_project.py" in netlist_text.lower(),
    }


def infer_editable_ports(existing_ports: list[dict[str, Any]], components: list[dict[str, Any]]) -> list[dict[str, Any]]:
    nodes: list[str] = []
    for component in components:
        for pin in component.get("pins", []):
            node = str(pin.get("net", "")).strip()
            if node and node not in nodes:
                nodes.append(node)

    ports: list[dict[str, Any]] = []
    used_port_ids: set[str] = set()
    for port in existing_ports:
        port_id = str(port.get("id", "")).strip()
        if not port_id or port_id in used_port_ids:
            continue
        if port.get("inferred") and str(port.get("net", "")) not in nodes:
            continue
        used_port_ids.add(port_id)
        ports.append(port)

    existing_nets = {str(port.get("net", "")) for port in ports}

    def add_port(port_id: str, name: str, direction: str, signal_type: str, net: str) -> None:
        if net in existing_nets or port_id in used_port_ids:
            return
        used_port_ids.add(port_id)
        existing_nets.add(net)
        port = make_port(port_id, name, direction, signal_type, net)
        port["inferred"] = True
        ports.append(port)

    lower_to_node = {node.lower(): node for node in nodes}
    if "0" in nodes:
        add_port("gnd", "GND", "bidirectional", "ground", "0")
    for rail in ("vdd", "vcc", "vee", "vss"):
        if rail in lower_to_node:
            add_port(rail, rail.upper(), "input", "power", lower_to_node[rail])
    for label in ("in", "vin", "input", "rf_in"):
        if label in lower_to_node:
            add_port("input", "IN", "input", "analog", lower_to_node[label])
            break
    for label in ("out", "vout", "output", "rf_out"):
        if label in lower_to_node:
            add_port("output", "OUT", "output", "analog", lower_to_node[label])
            break
    return ports


def sync_module_from_netlist(root: Path, module_id: str) -> dict[str, Any]:
    project, modules = load_project(root)
    if module_id not in modules:
        raise ValueError(f"unknown module: {module_id}")
    notebook_path = root / "modules" / module_id / "netlist-notebook.md"
    if not notebook_path.exists():
        return {"ok": True, "project_id": project["project_id"], "module_id": module_id, "changed": False}
    module_file = module_path(root, module_id)
    if module_file.exists() and notebook_path.stat().st_mtime <= module_file.stat().st_mtime:
        return {"ok": True, "project_id": project["project_id"], "module_id": module_id, "changed": False}

    module = modules[module_id]
    netlist_text = extract_notebook_netlist(notebook_path.read_text(encoding="utf-8"))
    parsed_components = parse_editable_netlist_components(module_id, netlist_text, module)
    parsed_ids = {str(component.get("id")) for component in parsed_components}
    schematic_blocks = [
        component for component in module.get("components", [])
        if component.get("type") == "BLOCK" and str(component.get("id")) not in parsed_ids
    ]
    components = [*parsed_components, *schematic_blocks]
    if not components:
        return {"ok": True, "project_id": project["project_id"], "module_id": module_id, "changed": False}
    ports = infer_editable_ports(list(module.get("ports", [])), components)
    next_module = {
        **module,
        "components": components,
        "ports": ports,
        "wires": module.get("wires", []),
        "annotations": module.get("annotations", []),
    }
    validate_module(next_module)

    comparable_keys = ("components", "ports", "wires", "annotations")
    before = {key: module.get(key) for key in comparable_keys}
    after = {key: next_module.get(key) for key in comparable_keys}
    changed = json.dumps(before, ensure_ascii=False, sort_keys=True) != json.dumps(after, ensure_ascii=False, sort_keys=True)
    if not changed:
        return {"ok": True, "project_id": project["project_id"], "module_id": module_id, "changed": False}

    with ProjectLock(root):
        project, modules = load_project(root)
        module = modules[module_id]
        next_module = {
            **module,
            "components": components,
            "ports": ports,
            "wires": module.get("wires", []),
            "annotations": module.get("annotations", []),
            "revision": int(module.get("revision", 0)) + 1,
        }
        validate_module(next_module)
        modules[module_id] = next_module
        module_ref = find_module_ref(project, module_id)
        module_ref["ports"] = ports
        project["revision"] = int(project.get("revision", 0)) + 1
        project["updated_at"] = utc_now()
        atomic_write_json(project_path(root), project)
        atomic_write_json(module_path(root, module_id), next_module)
    return {
        "ok": True,
        "project_id": project["project_id"],
        "module_id": module_id,
        "changed": True,
        "revision": project["revision"],
        "module_revision": next_module["revision"],
    }


def hydrated_summary_module(root: Path, module_id: str, module: dict[str, Any]) -> dict[str, Any]:
    module_file = module_path(root, module_id)
    notebook_path = root / "modules" / module_id / "netlist-notebook.md"
    build_netlist_path = root / "build" / "modules" / module_id / "design.cir"
    netlist_text = ""

    try:
        if notebook_path.exists() and (
            not module.get("components")
            or not module_file.exists()
            or notebook_path.stat().st_mtime > module_file.stat().st_mtime
        ):
            netlist_text = extract_notebook_netlist(notebook_path.read_text(encoding="utf-8"))
        elif not module.get("components") and build_netlist_path.exists():
            netlist_text = build_netlist_path.read_text(encoding="utf-8")
    except (OSError, ValueError):
        netlist_text = ""

    if not netlist_text:
        return module

    parsed_components = parse_editable_netlist_components(module_id, netlist_text, module)
    parsed_ids = {str(component.get("id")) for component in parsed_components}
    schematic_blocks = [
        component for component in module.get("components", [])
        if component.get("type") == "BLOCK" and str(component.get("id")) not in parsed_ids
    ]
    components = [*parsed_components, *schematic_blocks]
    if not components:
        return module
    next_module = {
        **module,
        "components": components,
        "ports": infer_editable_ports(list(module.get("ports", [])), components),
        "wires": module.get("wires", []),
        "annotations": module.get("annotations", []),
    }
    try:
        validate_module(next_module)
    except ValueError:
        return module
    return next_module


def build_report_markdown(
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    netlist_text: str,
    simulation: dict[str, Any] | None,
    erc: dict[str, Any] | None = None,
) -> str:
    lines: list[str] = [
        f"# {project['name']}",
        "",
        f"Revision {project['revision']} · {len(project['modules'])} modules · "
        f"{len(project.get('connections', []))} connections · generated {utc_now()}",
        "",
        "## Modules",
        "",
    ]
    for module_ref in project["modules"]:
        module = modules.get(module_ref["id"], {})
        ports = module_ref.get("ports", [])

        def nets(*, direction: str | None = None, ground: bool = False) -> str:
            selected = {
                port.get("net", "")
                for port in ports
                if (port.get("signal_type") == "ground") == ground
                and (ground or port.get("direction") == direction)
            }
            return ", ".join(sorted(selected)) or "—"

        lines.append(f"### {module_ref.get('name', module_ref['id'])} (`{module_ref['id']}`)")
        if module_ref.get("kind"):
            lines.append(f"- Kind: {module_ref['kind']}")
        if module_ref.get("function"):
            lines.append(f"- Function: {module_ref['function']}")
        lines.append(
            f"- IN: {nets(direction='input')} · OUT: {nets(direction='output')} · GND: {nets(ground=True)}"
        )
        params = module_ref.get("parameters") or {}
        if params:
            lines.append("- Parameters: " + ", ".join(f"{key} = {value}" for key, value in params.items()))
        lines.append(f"- Components: {len(module.get('components', []))}")
        if (module_ref.get("notes") or "").strip():
            lines.append(f"- Agent note: {module_ref['notes'].strip()}")
        lines.append("")

    connections = project.get("connections", [])
    if connections:
        lines.extend(["## System networks", ""])
        for connection in connections:
            label = connection.get("network") or connection.get("id")
            source = connection["from"]
            target = connection["to"]
            lines.append(
                f"- **{label}**: `{source['module_id']}.{source['port_id']}`"
                f" → `{target['module_id']}.{target['port_id']}`"
            )
        lines.append("")

    lines.extend(["## Electrical rules", ""])
    if erc is None:
        lines.append("_ERC was not available for this report._")
    else:
        summary = erc.get("summary") or {}
        lines.extend([
            f"- Source revision: `{erc.get('source_revision', 'unknown')}`",
            f"- Document hash: `{erc.get('document_hash', 'unknown')}`",
            f"- Status: **{erc.get('status', 'unknown')}**",
            f"- Errors: {summary.get('errors', 0)}",
            f"- Warnings: {summary.get('warnings', 0)}",
        ])
        diagnostics = erc.get("diagnostics") or []
        if diagnostics:
            lines.extend([
                "",
                "| Severity | Code | Location | Diagnostic |",
                "| --- | --- | --- | --- |",
            ])
            for diagnostic in diagnostics:
                location = ".".join(
                    str(diagnostic.get(key))
                    for key in ("module_id", "component_id", "pin_id", "port_id")
                    if diagnostic.get(key)
                ) or "project"
                lines.append(
                    f"| {diagnostic.get('severity', '')} | {diagnostic.get('code', '')} | "
                    f"{location} | {diagnostic.get('message', '')} |"
                )
    lines.extend(["", "## Simulation", ""])
    if simulation is None:
        lines.append("_Not simulated yet. Run \"Simulate system\" to populate analyses and metrics._")
    else:
        execution_status = simulation.get("execution_status") or (
            "success" if simulation.get("ok") else "failed"
        )
        measurement_status = simulation.get("measurement_status", "unknown")
        specification_status = simulation.get("specification_status", "not_evaluated")
        lines.extend([
            f"- Run: `{simulation.get('run_id', 'legacy')}`",
            f"- Source revision: `{simulation.get('source_revision', project.get('revision', 'unknown'))}`",
            f"- Document hash: `{simulation.get('document_hash', 'unknown')}`",
            f"- Execution: **{execution_status}**",
            f"- Measurements: **{measurement_status}**",
            f"- Specifications: **{specification_status}**",
            f"- Backend: `{simulation.get('ngspice', '')}`",
            f"- Simulated at: {simulation.get('simulated_at', '')}",
        ])
        lines.append("")
        analyses = simulation.get("analyses") or []
        if analyses:
            lines.extend([
                "### Analyses",
                "",
                "| Analysis | Type | Directive | Execution | Measurements | Specifications | Dataset |",
                "| --- | --- | --- | --- | --- | --- | --- |",
            ])
            for analysis in analyses:
                dataset = analysis.get("dataset") or {}
                dataset_summary = "not produced"
                if dataset:
                    dataset_summary = (
                        f"{dataset.get('point_count', 0)} points / "
                        f"{len(dataset.get('traces') or [])} traces"
                    )
                lines.append(
                    f"| {analysis.get('id', '')} | {analysis.get('type', '')} | "
                    f"`{analysis.get('directive', '')}` | "
                    f"{analysis.get('execution_status', analysis.get('status', 'unknown'))} | "
                    f"{analysis.get('measurement_status', 'unknown')} | "
                    f"{analysis.get('specification_status', 'not_evaluated')} | {dataset_summary} |"
                )
                for diagnostic in analysis.get("diagnostics") or []:
                    lines.append(f"- `{analysis.get('id', '')}`: {diagnostic}")
            lines.append("")
        metrics = simulation.get("metrics") or []
        if metrics:
            lines.extend([
                "### Metrics",
                "",
                "| Metric | Value | Measurement | Specification |",
                "| --- | --- | --- | --- |",
            ])
            for metric in metrics:
                unit = metric.get("unit", "")
                value = metric.get("value")
                shown = f"{value:.4g} {unit}".strip() if isinstance(value, (int, float)) else "failed"
                measured = metric.get("measurement_status")
                if measured is None:
                    measured = "measured" if value is not None else "failed"
                specification = metric.get("specification_status")
                if specification is None:
                    specification = "passed" if metric.get("pass") else "not_evaluated"
                lines.append(
                    f"| {metric['name']} | {shown} | {measured} | {specification} |"
                )
        else:
            lines.append("_No measurements were produced._")
        specifications = simulation.get("specifications") or []
        if specifications:
            lines.extend([
                "",
                "### Specification Results",
                "",
                "| Metric | Minimum | Maximum | Actual | Unit | Status |",
                "| --- | --- | --- | --- | --- | --- |",
            ])
            for specification in specifications:
                lines.append(
                    f"| {specification.get('metric', '')} | "
                    f"{specification.get('minimum', '') if specification.get('minimum') is not None else ''} | "
                    f"{specification.get('maximum', '') if specification.get('maximum') is not None else ''} | "
                    f"{specification.get('value', '') if specification.get('value') is not None else 'missing'} | "
                    f"{specification.get('unit', '')} | {specification.get('status', '')} |"
                )
        for diagnostic in simulation.get("specification_diagnostics") or []:
            lines.append(f"- Specification configuration: {diagnostic}")
    lines.extend(["", "## System netlist", "", "```spice", netlist_text.strip(), "```", ""])
    return "\n".join(lines)


def write_project_report(
    root: Path,
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    netlist_text: str,
    simulation: dict[str, Any] | None,
) -> Path:
    report_path = root / "build" / "system" / "report.md"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    erc_path = root / "build" / "erc.json"
    erc = read_json(erc_path) if erc_path.exists() else None
    report_path.write_text(
        build_report_markdown(project, modules, netlist_text, simulation, erc),
        encoding="utf-8",
    )
    return report_path


def compile_project(root: Path) -> dict[str, Any]:
    project, modules = load_project(root)
    erc = write_erc_result(root, project, modules)
    union = UnionFind()
    port_lookup: dict[tuple[str, str], dict[str, Any]] = {}
    for module_ref in project["modules"]:
        for port in module_ref.get("ports", []):
            key = f"{module_ref['id']}::{port['id']}"
            union.find(key)
            port_lookup[(module_ref["id"], port["id"])] = port
    for connection in project.get("connections", []):
        source = connection["from"]
        target = connection["to"]
        union.union(
            f"{source['module_id']}::{source['port_id']}",
            f"{target['module_id']}::{target['port_id']}",
        )

    connection_networks: dict[str, set[str]] = {}
    for connection in project.get("connections", []):
        network = str(connection.get("network", "")).strip()
        if not network:
            continue
        source = connection["from"]
        root_key = union.find(f"{source['module_id']}::{source['port_id']}")
        connection_networks.setdefault(root_key, set()).add(network)

    groups: dict[str, list[tuple[str, str, dict[str, Any]]]] = {}
    for (module_id, port_id), port in port_lookup.items():
        groups.setdefault(union.find(f"{module_id}::{port_id}"), []).append((module_id, port_id, port))
    global_names: dict[str, str] = {}
    used_names: set[str] = {"0"}
    for root_key, members in groups.items():
        labels = connection_networks.get(root_key, set())
        if len(labels) > 1:
            raise ValueError(
                f"conflicting system network names for one connected group: {sorted(labels)}"
            )
        if any(port.get("signal_type") == "ground" or port.get("net") == "0" for _, _, port in members):
            global_names[root_key] = "0"
            continue
        preferred = next(iter(labels), None) or next(
            (
                port["name"].lower()
                for _, _, port in members
                if port.get("direction") == "output" and port.get("name")
            ),
            f"{members[0][0]}_{members[0][1]}",
        )
        node = sanitize_node(preferred)
        suffix = 2
        base = node
        while node in used_names:
            node = f"{base}_{suffix}"
            suffix += 1
        used_names.add(node)
        global_names[root_key] = node

    source_map: dict[str, Any] = {"components": {}, "blocks": {}, "nodes": {}}
    lines = [
        f"* {project['name']}",
        "* Generated from actoviq.project.v1 by circuit_project.py",
    ]
    model_lines: list[str] = []
    notebook_directives: list[str] = []
    output_nodes: list[str] = []
    input_nodes: list[str] = []
    for module_ref in project["modules"]:
        module_id = module_ref["id"]
        module = modules[module_id]
        lines.append(f"* MODULE: {module_id} - {module['name']}")
        if module["components"]:
            local_node_map: dict[str, str] = {"0": "0"}
            for port in module.get("ports", []):
                root_key = union.find(f"{module_id}::{port['id']}")
                local_node_map[port["net"]] = global_names[root_key]
                if port.get("direction") == "output" and port.get("signal_type") == "analog":
                    output_nodes.append(global_names[root_key])
                if port.get("direction") == "input" and port.get("signal_type") == "analog":
                    input_nodes.append(global_names[root_key])
            for component in module["components"]:
                component_name = sanitize_node(f"{module_id}_{component['name']}")
                component_type = component["type"]
                if component_type == "BLOCK":
                    pin_summary = ", ".join(
                        f"{pin.get('name', pin.get('id', 'PIN'))}={pin.get('net', '')}"
                        for pin in component.get("pins", [])
                    )
                    lines.append(f"* BLOCK {component_name}: {component.get('value', '')} [{pin_summary}]")
                    source_map["blocks"][component_name] = {
                        "module_id": module_id,
                        "component_id": component["id"],
                        "pins": component.get("pins", []),
                    }
                    continue
                if not component_name.upper().startswith(component_type):
                    component_name = f"{component_type}{component_name}"
                node_values = []
                for pin in component["pins"]:
                    local_net = pin["net"]
                    node = local_node_map.get(local_net)
                    if node is None:
                        node = sanitize_node(f"{module_id}_{local_net}")
                        local_node_map[local_net] = node
                    node_values.append(node)
                lines.append(" ".join([component_name, *node_values, str(component["value"])]))
                source_map["components"][component_name] = {
                    "module_id": module_id,
                    "component_id": component["id"],
                }
            for local_net, global_node in local_node_map.items():
                source_map["nodes"][global_node] = {"module_id": module_id, "local_net": local_net}
        else:
            # Notebook-backed module: splice its SPICE body (devices + models)
            # and hoist its analysis/measurement directives to the system deck so
            # MOSFET/active and DC/transient designs simulate at the system level,
            # not only through the auto-generated AC test bench. Local node names
            # are kept verbatim (a notebook module is a self-contained sub-circuit).
            notebook_path = root / "modules" / module_id / "netlist-notebook.md"
            if notebook_path.exists():
                for raw in extract_notebook_netlist(
                    notebook_path.read_text(encoding="utf-8")
                ).splitlines():
                    stripped = raw.strip()
                    if not stripped or stripped.startswith("*"):
                        continue
                    low = stripped.lower()
                    if low == ".end":
                        continue
                    if low.startswith(".model"):
                        if stripped not in model_lines:
                            model_lines.append(stripped)
                    elif low.startswith(ANALYSIS_DIRECTIVE_PREFIXES):
                        notebook_directives.append(stripped)
                    else:
                        lines.append(stripped)

        spice = module.get("spice") if isinstance(module.get("spice"), dict) else {}
        generated_testbench = bool(spice.get("generated_testbench")) or (
            "standalone module testbench generated by circuit_project.py" in str(spice.get("source", "")).lower()
        )
        if not generated_testbench:
            for raw in spice.get("opaque", []):
                stripped = str(raw).strip()
                if stripped and stripped not in lines:
                    lines.append(stripped)
        for raw in spice.get("models", []):
            stripped = str(raw).strip()
            if stripped and stripped not in model_lines:
                model_lines.append(stripped)
        if not generated_testbench:
            for raw in spice.get("directives", []):
                stripped = str(raw).strip()
                if stripped and stripped.lower() != ".end" and stripped not in notebook_directives:
                    notebook_directives.append(stripped)

    if model_lines:
        lines.append("* Device models")
        lines.extend(model_lines)

    if notebook_directives:
        # The design author specified the analysis; use it verbatim.
        lines.append("* Analysis (from module notebooks)")
        lines.extend(notebook_directives)
        probed = re.findall(
            r"(?i)v(?:db)?\(\s*([a-z0-9_.:+\-]+)", " ".join(notebook_directives)
        )
        if probed:
            source_map["primary_output_node"] = probed[-1]
    else:
        ac = project.get("analyses", {}).get("ac", {})
        if ac.get("enabled", True):
            points = int(ac.get("points_per_decade", 20))
            start = float(ac.get("start_hz", 10))
            stop = float(ac.get("stop_hz", 1_000_000))
            lines.append(f".ac dec {points} {start:g} {stop:g}")
            if output_nodes:
                consumed = set(input_nodes)
                system_outputs = [node for node in output_nodes if node not in consumed]
                output_node = (system_outputs or output_nodes)[-1]
                lines.append(f".meas ac output_1khz_db find vdb({output_node}) at=1k")
                lines.append(f".meas ac output_10khz_db find vdb({output_node}) at=10k")
                lines.append(f".print ac vdb({output_node})")
                source_map["primary_output_node"] = output_node
    lines.append(".end")
    build_root = root / "build" / "system"
    build_root.mkdir(parents=True, exist_ok=True)
    netlist_path = build_root / "design.final.cir"
    netlist_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    atomic_write_json(build_root / "source-map.json", source_map)
    manifest = {
        "schema": "actoviq.build.v1",
        "project_id": project["project_id"],
        "revision": project["revision"],
        "source_revision": project["revision"],
        "document_hash": project_document_hash(project, modules),
        "built_at": utc_now(),
        "status": "compiling",
        "netlist": "system/design.final.cir",
        "source_map": "system/source-map.json",
        "erc": "erc.json",
        "erc_status": erc["status"],
        "erc_summary": erc["summary"],
        "modules": {},
    }
    atomic_write_json(root / "build" / "build-manifest.json", manifest)
    # Recompiling invalidates any prior run, so the report is design-only until
    # the next simulate_project regenerates it with fresh AC metrics.
    write_project_report(root, project, modules, "\n".join(lines) + "\n", None)
    module_results = []
    for module_ref in project["modules"]:
        module_results.append(compile_module(root, module_ref["id"]))
    final_manifest = {
        **manifest,
        "built_at": utc_now(),
        "status": "compiled",
        "modules": {
            result["module_id"]: {
                "status": "compiled",
                "revision": result["revision"],
                "netlist": f"modules/{result['module_id']}/design.cir",
                "schematic": (
                    f"modules/{result['module_id']}/schematic.svg"
                    if result.get("render", {}).get("ok")
                    else None
                ),
                "renderer": result.get("render", {}).get("renderer", "netlistsvg"),
                "render_ok": bool(result.get("render", {}).get("ok")),
            }
            for result in module_results
        },
    }
    atomic_write_json(root / "build" / "build-manifest.json", final_manifest)
    return {
        "ok": True,
        "project_id": project["project_id"],
        "revision": project["revision"],
        "netlist_path": str(netlist_path),
        "manifest_path": str(root / "build" / "build-manifest.json"),
        "primary_output_node": source_map.get("primary_output_node"),
        "erc": erc,
        "modules": {
            result["module_id"]: result for result in module_results
        },
    }


def run_json_script(script_path: Path, args: list[str], timeout_sec: int = 90) -> dict[str, Any]:
    completed = subprocess.run(
        [sys.executable, str(script_path), *args],
        cwd=str(script_path.parent),
        text=True,
        capture_output=True,
        timeout=timeout_sec,
        check=False,
    )
    line = next(
        (entry for entry in reversed(completed.stdout.splitlines()) if entry.strip()),
        "",
    )
    try:
        result = json.loads(line)
    except json.JSONDecodeError:
        result = {
            "ok": False,
            "error": completed.stderr.strip() or completed.stdout.strip(),
        }
    if completed.returncode != 0:
        result["ok"] = False
    return result


def resolve_netlistsvg_bin() -> str:
    repo_root = Path(__file__).resolve().parents[3]
    local_bin = repo_root / "node_modules" / ".bin" / ("netlistsvg.cmd" if os.name == "nt" else "netlistsvg")
    return str(local_bin) if local_bin.exists() else "netlistsvg"


def render_module_schematic(
    build_root: Path,
    netlist_path: Path,
    module: dict[str, Any],
    renderer: str = "netlistsvg",
) -> dict[str, Any]:
    scripts_root = Path(__file__).resolve().parent
    svg_path = build_root / "schematic.svg"
    if renderer == "grid-experimental":
        grid = run_json_script(
            scripts_root / "render_grid.py",
            ["--netlist", str(netlist_path), "--svg-path", str(svg_path)],
            timeout_sec=60,
        )
        if grid.get("ok") and svg_path.exists():
            return {
                "ok": True,
                "json_path": "",
                "svg_path": str(svg_path),
                "renderer": "grid-experimental",
                "details": grid,
            }
        return {
            "ok": False,
            "json_path": "",
            "svg_path": str(svg_path) if svg_path.exists() else "",
            "renderer": "grid-experimental",
            "details": grid,
        }
    input_port = next(
        (
            port for port in module.get("ports", [])
            if port.get("direction") == "input" and port.get("signal_type") != "ground"
        ),
        None,
    )
    output_port = next(
        (
            port for port in module.get("ports", [])
            if port.get("direction") == "output" and port.get("signal_type") != "ground"
        ),
        None,
    )
    json_path = build_root / "design.json"
    convert_args = [
        "--netlist-path", str(netlist_path),
        "--json-path", str(json_path),
        "--view", "schematic",
    ]
    if input_port:
        convert_args.extend(["--input-node", str(input_port["net"])])
    if output_port:
        convert_args.extend(["--output-node", str(output_port["net"])])
    converted = run_json_script(scripts_root / "netlist_to_json.py", convert_args)
    if not converted.get("ok"):
        return {
            "ok": False,
            "stage": "netlist_to_json",
            "error": converted.get("error") or converted.get("stderr"),
        }
    project_root = build_root.parents[2]
    overrides_path = schematic_overrides_path(project_root, module["module_id"])
    render_args = [
        "--json-path", str(json_path),
        "--svg-path", str(svg_path),
        "--netlistsvg-bin", resolve_netlistsvg_bin(),
        "--skin-profile", "analog",
        "--timeout-sec", "45",
    ]
    if overrides_path.exists():
        render_args.extend(["--overrides-path", str(overrides_path)])
    rendered = run_json_script(
        scripts_root / "render_netlistsvg.py",
        render_args,
        timeout_sec=60,
    )
    return {
        "ok": bool(rendered.get("ok")) and svg_path.exists(),
        "json_path": str(json_path),
        "svg_path": str(svg_path) if svg_path.exists() else "",
        "renderer": "netlistsvg",
        "details": rendered,
    }


def compile_module(root: Path, module_id: str, renderer: str = "netlistsvg") -> dict[str, Any]:
    project, modules = load_project(root)
    erc = write_erc_result(root, project, modules)
    if module_id not in modules:
        raise ValueError(f"unknown module: {module_id}")
    module = modules[module_id]
    node_map: dict[str, str] = {"0": "0"}

    def node_name(local_net: str) -> str:
        if local_net not in node_map:
            node_map[local_net] = sanitize_node(local_net)
        return node_map[local_net]

    body_lines = [
        f"* {project['name']} / {module['name']}",
        "* Standalone module testbench generated by circuit_project.py",
    ]
    driven_nodes: set[str] = set()
    for component in module["components"]:
        component_name = sanitize_node(f"{module_id}_{component['name']}")
        component_type = component["type"]
        if component_type == "BLOCK":
            pin_summary = ", ".join(
                f"{pin.get('name', pin.get('id', 'PIN'))}={pin.get('net', '')}"
                for pin in component.get("pins", [])
            )
            body_lines.append(f"* BLOCK {component_name}: {component.get('value', '')} [{pin_summary}]")
            continue
        if not component_name.upper().startswith(component_type):
            component_name = f"{component_type}{component_name}"
        nodes = [node_name(pin["net"]) for pin in component["pins"]]
        body_lines.append(" ".join([component_name, *nodes, str(component["value"])]))
        if component_type in {"V", "I"} and component["pins"]:
            driven_nodes.add(node_name(component["pins"][0]["net"]))

    def testbench_tail(existing_driven: set[str]) -> list[str]:
        tail: list[str] = []
        outputs: list[str] = []
        local_driven = set(existing_driven)
        for port in module.get("ports", []):
            node = node_name(port["net"])
            if port["signal_type"] == "analog" and port["direction"] == "input" and node not in local_driven:
                tail.append(f"Vtest_{sanitize_node(port['id'])} {node} 0 DC 0 AC 1")
                local_driven.add(node)
            elif port["signal_type"] == "power" and port["direction"] == "input" and node not in local_driven:
                tail.append(f"Vtest_{sanitize_node(port['id'])} {node} 0 DC 5")
                local_driven.add(node)
            if port["signal_type"] == "analog" and port["direction"] == "output":
                outputs.append(node)
                tail.append(f"Rload_{sanitize_node(port['id'])} {node} 0 1meg")
        tail.append(".ac dec 20 10 1meg")
        if outputs:
            output_node = outputs[-1]
            tail.append(f".meas ac module_output_1khz_db find vdb({output_node}) at=1k")
            tail.append(f".meas ac module_output_10khz_db find vdb({output_node}) at=10k")
            tail.append(f".print ac vdb({output_node})")
        return tail

    notebook_path = root / "modules" / module_id / "netlist-notebook.md"
    if notebook_path.exists():
        notebook_netlist = extract_notebook_netlist(notebook_path.read_text(encoding="utf-8"))
        if re.search(r"(?im)^\s*\.meas\b", notebook_netlist):
            # The notebook defines its own measurements; run it verbatim.
            netlist_text = notebook_netlist
        else:
            # Wrap the user's schematic netlist with a generated testbench so the
            # module still produces simulation metrics. Schematic rendering filters
            # the Vtest_/Rload_ helpers out through the "schematic" view.
            trimmed = re.sub(r"(?im)^\s*\.end\s*$", "", notebook_netlist).rstrip()
            tail = testbench_tail(scan_driven_nodes(notebook_netlist))
            netlist_text = "\n".join([trimmed, *tail, ".end"]) + "\n"
        # SPICE treats the first line as the title and ignores it, so a notebook
        # that starts with a component would lose that element in ngspice. Ensure
        # a leading comment/title line whenever the user's netlist lacks one.
        if not netlist_text.lstrip().startswith("*"):
            netlist_text = f"* {project['name']} / {module['name']}\n{netlist_text}"
    else:
        netlist_text = "\n".join([*body_lines, *testbench_tail(driven_nodes), ".end"]) + "\n"
    build_root = root / "build" / "modules" / module_id
    build_root.mkdir(parents=True, exist_ok=True)
    netlist_path = build_root / "design.cir"
    netlist_path.write_text(netlist_text, encoding="utf-8")
    render_result = render_module_schematic(build_root, netlist_path, module, renderer)
    manifest_path = root / "build" / "build-manifest.json"
    manifest = read_json(manifest_path) if manifest_path.exists() else {
        "schema": "actoviq.build.v1",
        "project_id": project["project_id"],
        "revision": project["revision"],
        "built_at": utc_now(),
        "status": "compiled",
    }
    manifest.setdefault("modules", {})[module_id] = {
        "status": "compiled",
        "revision": module["revision"],
        "netlist": f"modules/{module_id}/design.cir",
        "schematic": f"modules/{module_id}/schematic.svg" if render_result.get("ok") else None,
        "renderer": render_result.get("renderer", "netlistsvg"),
        "render_ok": bool(render_result.get("ok")),
    }
    manifest["erc"] = "erc.json"
    manifest["erc_status"] = erc["status"]
    manifest["erc_summary"] = erc["summary"]
    atomic_write_json(manifest_path, manifest)
    return {
        "ok": True,
        "project_id": project["project_id"],
        "module_id": module_id,
        "revision": module["revision"],
        "netlist_path": str(netlist_path),
        "schematic_path": render_result.get("svg_path", ""),
        "render": render_result,
        "erc": erc,
    }


def resolve_ngspice(value: str) -> str:
    candidates = [
        value.strip(),
        os.environ.get("NGSPICE_BIN", "").strip(),
    ]
    config_path = Path(__file__).resolve().parents[1] / "tool_paths.json"
    if config_path.exists():
        try:
            candidates.append(str(read_json(config_path).get("ngspice_bin", "")).strip())
        except (OSError, json.JSONDecodeError):
            pass
    candidates.append("ngspice")
    for candidate in candidates:
        if not candidate:
            continue
        path_value = Path(candidate)
        if path_value.exists():
            if os.name == "nt" and path_value.name.lower() == "ngspice.exe":
                console = path_value.with_name("ngspice_con.exe")
                if console.exists():
                    return str(console.resolve())
            return str(path_value.resolve())
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    raise ValueError("ngspice executable not found; configure Settings, NGSPICE_BIN, or tool_paths.json")


def parse_measurements(netlist_text: str, log_text: str) -> list[dict[str, Any]]:
    """Surface every ``.meas``/``.measure`` result from an ngspice batch log.

    Measurement names are read from the netlist so this works for any analysis
    (ac/dc/tran) and any user-defined measurement name, not just the AC dB
    metrics the generated test benches happen to emit. A measurement that
    ngspice could not evaluate (e.g. ``find ... at=`` outside the swept
    interval) is reported as a failed metric instead of silently vanishing.
    """
    metrics: list[dict[str, Any]] = []
    seen: set[str] = set()
    for name in re.findall(r"(?im)^\s*\.meas(?:ure)?\s+\w+\s+([a-z_]\w*)", netlist_text):
        if name in seen:
            continue
        seen.add(name)
        match = re.search(rf"(?im)^\s*{re.escape(name)}\s*=\s*([-+0-9.eE]+)", log_text)
        value: float | None = None
        if match:
            try:
                value = float(match.group(1))
            except ValueError:
                value = None
        metrics.append({
            "name": name,
            "value": value,
            "unit": "dB" if name.lower().endswith("_db") else "",
            "pass": value is not None,
            "measurement_status": "measured" if value is not None else "failed",
            "specification_status": "not_evaluated",
            "source": "ngspice-measure",
        })
    return metrics


ANALYSIS_LINE = re.compile(r"^\s*\.(op|dc|ac|tran|sp|noise|pz)\b", re.IGNORECASE)
ANALYSIS_OUTPUT_LINE = re.compile(
    r"^\s*\.(?:meas(?:ure)?|print|plot|probe)\s+(op|dc|ac|tran|sp|noise|pz)\b",
    re.IGNORECASE,
)


CURRENT_PROBE_PARAMETER = {
    "R": "i",
    "C": "i",
    "L": "i",
    "D": "id",
    "M": "id",
    "Q": "ic",
}


def current_probe_vectors(lines: list[str]) -> list[str]:
    vectors: list[str] = []
    for raw in lines:
        stripped = strip_spice_comment(raw)
        if not stripped or stripped.startswith("."):
            continue
        instance = stripped.split(maxsplit=1)[0]
        parameter = CURRENT_PROBE_PARAMETER.get(instance[:1].upper())
        if parameter and re.fullmatch(r"[A-Za-z][A-Za-z0-9_.:+\-]*", instance):
            vectors.append(f"@{instance}[{parameter}]")
    return list(dict.fromkeys(vectors))


def advanced_directive_parts(directive: str) -> tuple[str, list[str], dict[str, str]]:
    tokens = shlex.split(directive)
    if len(tokens) < 2 or tokens[0].lower() != ".actoviq":
        raise ValueError(f"invalid Actoviq analysis directive: {directive}")
    positional: list[str] = []
    options: dict[str, str] = {}
    for token in tokens[2:]:
        if "=" in token:
            key, value = token.split("=", 1)
            options[key.lower()] = value
        else:
            positional.append(token)
    return tokens[1].lower(), positional, options


def split_analysis_decks(netlist_text: str) -> list[dict[str, Any]]:
    lines = netlist_text.splitlines()
    title = lines[0] if lines and lines[0].strip() else "* Actoviq simulation"
    analyses: list[tuple[str, str]] = []
    advanced_directives: list[str] = []
    base_lines: list[str] = [title]
    output_lines: list[tuple[str, str]] = []
    for index, raw in enumerate(lines):
        if index == 0:
            continue
        stripped = raw.strip()
        low = stripped.lower()
        if low == ".end":
            continue
        if low.startswith(".actoviq "):
            advanced_directives.append(stripped)
            continue
        analysis_match = ANALYSIS_LINE.match(stripped)
        if analysis_match:
            analyses.append((analysis_match.group(1).lower(), stripped))
            continue
        output_match = ANALYSIS_OUTPUT_LINE.match(stripped)
        if output_match:
            output_lines.append((output_match.group(1).lower(), stripped))
            continue
        base_lines.append(raw)
    if not analyses:
        analyses.append(("op", ".op"))
    probe_vectors = current_probe_vectors(base_lines)
    if probe_vectors:
        base_lines.append(f".save all {' '.join(probe_vectors)}")
    counts: dict[str, int] = {}
    decks: list[dict[str, Any]] = []
    ordinary_by_type: dict[str, dict[str, Any]] = {}
    for analysis_type, directive in analyses:
        counts[analysis_type] = counts.get(analysis_type, 0) + 1
        normalized_type = "sparameter" if analysis_type == "sp" else analysis_type
        analysis_id = f"{normalized_type}-{counts[analysis_type]}"
        related = [line for line_type, line in output_lines if line_type == analysis_type]
        if not any(re.match(r"(?i)^\s*\.print\b", line) for line in related):
            probes = []
            for line in related:
                probes.extend(re.findall(r"(?i)\b(?:v(?:db|m|p|r|i)?|i)\([^()]+\)", line))
            if probes:
                related.append(f".print {analysis_type} {' '.join(dict.fromkeys(probes))}")
        deck = "\n".join([*base_lines, directive, *related, ".end", ""])
        analysis = {
            "id": analysis_id,
            "type": normalized_type,
            "directive_type": analysis_type,
            "directive": directive,
            "deck": deck,
        }
        decks.append(analysis)
        ordinary_by_type.setdefault(analysis_type, analysis)

    advanced_counts: dict[str, int] = {}
    for directive in advanced_directives:
        kind, positional, options = advanced_directive_parts(directive)
        if kind == "spec":
            continue
        advanced_counts[kind] = advanced_counts.get(kind, 0) + 1
        analysis_id = f"{'parameter-sweep' if kind == 'sweep' else kind}-{advanced_counts[kind]}"
        if kind == "fft":
            trace = positional[0] if positional else ""
            window = options.get("window", "blackman")
            transient = ordinary_by_type.get("tran")
            error = None
            if not transient:
                error = "FFT requires a transient analysis in the same netlist."
            elif not trace or not re.fullmatch(r"[A-Za-z0-9_#().:+,\-]+", trace):
                error = "FFT requires a valid transient vector such as v(out)."
            elif window not in {
                "none", "rectangular", "bartlet", "hanning", "hann", "blackman",
                "blackmanharris", "hamming", "gaussian", "flattop",
            }:
                error = f"Unsupported FFT window: {window}"
            tran_command = transient["directive"].lstrip(".") if transient else "tran 1n 1u"
            deck = "\n".join([
                *base_lines,
                ".control",
                tran_command,
                f"linearize {trace or 'v(out)'}",
                f"set specwindow={window}",
                f"fft {trace or 'v(out)'}",
                f"write vectors.raw {trace or 'v(out)'}",
                "quit",
                ".endc",
                ".end",
                "",
            ])
            decks.append({
                "id": analysis_id,
                "type": "fft",
                "directive_type": "fft",
                "directive": directive,
                "deck": deck,
                "configuration_error": error,
            })
            continue
        if kind in {"sweep", "montecarlo"}:
            required = 4 if kind == "sweep" else 4
            requested_type = options.get("analysis", "ac").lower()
            inner = ordinary_by_type.get(requested_type)
            error = None
            if len(positional) < required:
                error = (
                    ".actoviq sweep requires TARGET START STOP COUNT."
                    if kind == "sweep"
                    else ".actoviq montecarlo requires TARGET NOMINAL RELATIVE_SIGMA RUNS."
                )
            elif inner is None:
                error = f"{kind} requires a .{requested_type} analysis in the same netlist."
            decks.append({
                "id": analysis_id,
                "type": "parameter_sweep" if kind == "sweep" else "monte_carlo",
                "directive_type": kind,
                "directive": directive,
                "deck": inner["deck"] if inner else "\n".join([*base_lines, ".op", ".end", ""]),
                "inner_type": inner["type"] if inner else requested_type,
                "target": positional[0] if positional else "",
                "start": positional[1] if len(positional) > 1 else "",
                "stop": positional[2] if len(positional) > 2 else "",
                "count": positional[3] if len(positional) > 3 else "",
                "seed": options.get("seed", "1"),
                "configuration_error": error,
            })
            continue
        decks.append({
            "id": analysis_id,
            "type": kind,
            "directive_type": kind,
            "directive": directive,
            "deck": "\n".join([*base_lines, ".op", ".end", ""]),
            "configuration_error": f"Unsupported Actoviq analysis: {kind}",
        })
    return decks


def parse_raw_scalar(token: str) -> complex:
    normalized = token.strip().strip("()")
    if "," in normalized:
        real, imaginary = normalized.split(",", 1)
        return complex(float(real), float(imaginary))
    return complex(float(normalized), 0.0)


def raw_header_int(header: str, name: str) -> int:
    match = re.search(rf"(?im)^{re.escape(name)}:\s*(\d+)", header)
    if not match:
        raise ValueError(f"ngspice rawfile is missing {name}")
    return int(match.group(1))


def parse_ngspice_raw(raw_path: Path) -> list[dict[str, Any]]:
    data = raw_path.read_bytes()
    cursor = 0
    plots: list[dict[str, Any]] = []
    while cursor < len(data):
        while cursor < len(data) and data[cursor] in b"\r\n\x00 \t":
            cursor += 1
        if cursor >= len(data):
            break
        markers = [
            (position, marker)
            for marker in (b"Values:", b"Binary:")
            if (position := data.find(marker, cursor)) >= 0
        ]
        if not markers:
            break
        marker_position, marker = min(markers, key=lambda value: value[0])
        header = data[cursor:marker_position].decode("utf-8", errors="replace")
        if "Title:" not in header:
            cursor = marker_position + len(marker)
            continue
        variable_count = raw_header_int(header, "No. Variables")
        point_count = raw_header_int(header, "No. Points")
        flags_match = re.search(r"(?im)^Flags:\s*(.+)$", header)
        flags = (flags_match.group(1).strip().lower().split() if flags_match else ["real"])
        complex_values = "complex" in flags
        plotname_match = re.search(r"(?im)^Plotname:\s*(.+)$", header)
        variables: list[dict[str, str]] = []
        variables_section = header.split("Variables:", 1)[-1] if "Variables:" in header else ""
        for raw in variables_section.splitlines():
            match = re.match(r"^\s*\d+\s+(\S+)\s+(\S+)", raw)
            if match:
                variables.append({"name": match.group(1), "kind": match.group(2)})
        if len(variables) != variable_count:
            raise ValueError(
                f"ngspice rawfile variable table has {len(variables)} entries, expected {variable_count}"
            )
        line_end = data.find(b"\n", marker_position)
        values_start = len(data) if line_end < 0 else line_end + 1
        values: list[list[complex]] = [[] for _ in range(variable_count)]
        if marker == b"Binary:":
            scalar_count = point_count * variable_count * (2 if complex_values else 1)
            byte_count = scalar_count * 8
            if values_start + byte_count > len(data):
                raise ValueError("ngspice binary rawfile is truncated")
            scalar_values = struct.unpack_from(f"<{scalar_count}d", data, values_start)
            scalar_index = 0
            for _point in range(point_count):
                for variable_index in range(variable_count):
                    if complex_values:
                        value = complex(scalar_values[scalar_index], scalar_values[scalar_index + 1])
                        scalar_index += 2
                    else:
                        value = complex(scalar_values[scalar_index], 0.0)
                        scalar_index += 1
                    values[variable_index].append(value)
            cursor = values_start + byte_count
        else:
            cursor = values_start
            for _point in range(point_count):
                for variable_index in range(variable_count):
                    while cursor < len(data):
                        next_line = data.find(b"\n", cursor)
                        if next_line < 0:
                            next_line = len(data)
                        line = data[cursor:next_line].decode("utf-8", errors="replace").strip()
                        cursor = min(len(data), next_line + 1)
                        if line:
                            break
                    tokens = line.split()
                    if not tokens:
                        raise ValueError("ngspice ASCII rawfile is truncated")
                    token = tokens[-1]
                    values[variable_index].append(parse_raw_scalar(token))
        plots.append({
            "plotname": plotname_match.group(1).strip() if plotname_match else "ngspice analysis",
            "flags": flags,
            "variables": variables,
            "values": values,
            "point_count": point_count,
        })
    return plots


def variable_unit(kind: str, name: str) -> str:
    low_kind = kind.lower()
    low_name = name.lower()
    if low_kind == "frequency" or low_name == "frequency":
        return "Hz"
    if low_kind == "time" or low_name == "time":
        return "s"
    if "pole(" in low_name or "zero(" in low_name:
        return "rad/s"
    if "noise" in low_name:
        return "V/sqrt(Hz)"
    if low_kind == "voltage" or low_name.startswith("v("):
        return "V"
    if low_kind == "current" or low_name.startswith("i("):
        return "A"
    return ""


def plot_to_dataset(plot: dict[str, Any], analysis_id: str, analysis_type: str) -> dict[str, Any]:
    variables = plot["variables"]
    values = plot["values"]
    if analysis_type == "pz":
        scale_name = "root"
        scale_unit = ""
        scale_values = [0.0]
        trace_variables = variables
        trace_values = values
    else:
        scale_name = variables[0]["name"] if variables else "index"
        scale_unit = variable_unit(variables[0]["kind"], variables[0]["name"]) if variables else ""
        scale_values = [value.real for value in values[0]] if values else []
        trace_variables = variables[1:]
        trace_values = values[1:]
    traces: list[dict[str, Any]] = []
    for variable, variable_values in zip(trace_variables, trace_values):
        real = [value.real for value in variable_values]
        imaginary = [value.imag for value in variable_values]
        trace: dict[str, Any] = {
            "name": variable["name"],
            "unit": variable_unit(variable["kind"], variable["name"]),
            "real": real,
        }
        if "complex" in plot["flags"] or any(abs(value) > 1e-30 for value in imaginary):
            magnitude = [math.hypot(real_value, imaginary_value) for real_value, imaginary_value in zip(real, imaginary)]
            trace.update({
                "imag": imaginary,
                "magnitude": magnitude,
                "db": [20 * math.log10(max(value, 1e-300)) for value in magnitude],
                "phase_deg": [math.degrees(math.atan2(imag_value, real_value)) for real_value, imag_value in zip(real, imaginary)],
            })
        traces.append(trace)
    return {
        "schema": "actoviq.simulation-dataset.v1",
        "id": f"{analysis_id}-dataset-1",
        "analysis_id": analysis_id,
        "analysis_type": analysis_type,
        "plotname": plot["plotname"],
        "point_count": plot["point_count"],
        "x": {
            "name": scale_name,
            "unit": scale_unit,
            "values": scale_values,
        },
        "traces": traces,
    }


def measured_metric(name: str, value: float | None, unit: str, source: str = "derived") -> dict[str, Any]:
    return {
        "name": name,
        "value": value,
        "unit": unit,
        "pass": value is not None and math.isfinite(value),
        "measurement_status": "measured" if value is not None and math.isfinite(value) else "failed",
        "specification_status": "not_evaluated",
        "source": source,
    }


def primary_trace(dataset: dict[str, Any]) -> dict[str, Any] | None:
    traces = dataset.get("traces", [])
    def output_score(trace: dict[str, Any]) -> int:
        name = str(trace.get("name", "")).lower()
        if re.fullmatch(r"v\((?:v?out|output)\)", name):
            return 0
        if "vout" in name or "output" in name:
            return 1
        if "out" in name:
            return 2
        return 100

    preferred = sorted((trace for trace in traces if output_score(trace) < 100), key=output_score)
    voltages = [trace for trace in traces if trace.get("unit") == "V"]
    return (preferred or voltages or traces or [None])[0]


def crossing_x(x: list[float], y: list[float], target: float, start_index: int = 1) -> float | None:
    for index in range(max(1, start_index), min(len(x), len(y))):
        left = y[index - 1] - target
        right = y[index] - target
        if left == 0:
            return x[index - 1]
        if left * right <= 0 and y[index] != y[index - 1]:
            ratio = (target - y[index - 1]) / (y[index] - y[index - 1])
            return x[index - 1] + ratio * (x[index] - x[index - 1])
    return None


def derived_metrics(dataset: dict[str, Any]) -> list[dict[str, Any]]:
    analysis_type = dataset.get("analysis_type")
    x = [float(value) for value in dataset.get("x", {}).get("values", [])]
    trace = primary_trace(dataset)
    if not trace or not x:
        return []
    metrics: list[dict[str, Any]] = []
    if analysis_type == "ac" and trace.get("db"):
        db = [float(value) for value in trace["db"]]
        phase = [float(value) for value in trace.get("phase_deg", [])]
        bandwidth = crossing_x(x, db, db[0] - 3.0)
        metrics.append(measured_metric("bandwidth_3db", bandwidth, "Hz"))
        unity = crossing_x(x, db, 0.0)
        if unity is not None and phase:
            unity_index = min(range(len(x)), key=lambda index: abs(x[index] - unity))
            metrics.append(measured_metric("phase_margin", 180.0 + phase[unity_index], "deg"))
        if phase:
            phase_crossing = crossing_x(x, phase, -180.0)
            if phase_crossing is not None:
                phase_index = min(range(len(x)), key=lambda index: abs(x[index] - phase_crossing))
                metrics.append(measured_metric("gain_margin", -db[phase_index], "dB"))
    elif analysis_type == "tran":
        y = [float(value) for value in trace.get("real", [])]
        if len(y) >= 2:
            low = min(y)
            high = max(y)
            span = high - low
            t10 = crossing_x(x, y, low + 0.1 * span) if span > 0 else None
            t90 = crossing_x(x, y, low + 0.9 * span) if span > 0 else None
            rise_time = t90 - t10 if t10 is not None and t90 is not None and t90 >= t10 else None
            slopes = [
                (y[index] - y[index - 1]) / (x[index] - x[index - 1])
                for index in range(1, min(len(x), len(y)))
                if x[index] != x[index - 1]
            ]
            metrics.extend([
                measured_metric("rise_time_10_90", rise_time, "s"),
                measured_metric("slew_rate_positive", max(slopes) if slopes else None, "V/s"),
                measured_metric("slew_rate_negative", min(slopes) if slopes else None, "V/s"),
            ])
            tail = y[max(0, int(len(y) * 0.8)):]
            metrics.append(measured_metric("output_ripple", max(tail) - min(tail) if tail else None, "V"))
    elif analysis_type == "dc":
        y = [float(value) for value in trace.get("real", [])]
        if len(y) >= 2 and x[-1] != x[0]:
            metrics.append(measured_metric("dc_output_min", min(y), trace.get("unit", "")))
            metrics.append(measured_metric("dc_output_max", max(y), trace.get("unit", "")))
            metrics.append(measured_metric("dc_line_slope", (y[-1] - y[0]) / (x[-1] - x[0]), "V/V"))
    elif analysis_type == "sparameter" and trace.get("magnitude"):
        return_loss = [-20 * math.log10(max(float(value), 1e-300)) for value in trace["magnitude"]]
        metrics.append(measured_metric("minimum_return_loss", min(return_loss), "dB"))
    elif analysis_type == "noise":
        for noise_trace in dataset.get("traces", []):
            values = [abs(float(value)) for value in noise_trace.get("real", [])]
            if not values:
                continue
            index = min(range(len(x)), key=lambda item: abs(x[item] - 1_000.0))
            metrics.append(measured_metric(f"{noise_trace['name']}_at_1khz", values[index], noise_trace.get("unit", "")))
    elif analysis_type == "fft":
        magnitude = [float(value) for value in trace.get("magnitude", trace.get("real", []))]
        candidates = [index for index, frequency in enumerate(x) if frequency > 0 and index < len(magnitude)]
        if candidates:
            dominant = max(candidates, key=lambda index: magnitude[index])
            metrics.append(measured_metric("dominant_frequency", x[dominant], "Hz"))
            metrics.append(measured_metric("dominant_magnitude", magnitude[dominant], trace.get("unit", "")))
    elif analysis_type == "pz":
        pole_count = sum("pole" in str(item.get("name", "")).lower() for item in dataset.get("traces", []))
        zero_count = sum("zero" in str(item.get("name", "")).lower() for item in dataset.get("traces", []))
        metrics.append(measured_metric("pole_count", float(pole_count), ""))
        metrics.append(measured_metric("zero_count", float(zero_count), ""))
    return metrics


SPICE_NUMBER_SUFFIXES = {
    "t": 1e12,
    "g": 1e9,
    "meg": 1e6,
    "k": 1e3,
    "m": 1e-3,
    "u": 1e-6,
    "n": 1e-9,
    "p": 1e-12,
    "f": 1e-15,
}


def parse_spice_number(value: str) -> float:
    match = re.fullmatch(
        r"\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*([A-Za-z]+)?\s*",
        value,
        flags=re.IGNORECASE,
    )
    if not match:
        raise ValueError(f"invalid SPICE scalar: {value}")
    number = float(match.group(1))
    suffix = (match.group(2) or "").lower()
    if not suffix:
        return number
    multiplier = next(
        (factor for name, factor in sorted(SPICE_NUMBER_SUFFIXES.items(), key=lambda item: -len(item[0])) if suffix.startswith(name)),
        None,
    )
    if multiplier is None:
        raise ValueError(f"unsupported SPICE scalar suffix: {value}")
    return number * multiplier


def simple_spice_parameters(deck: str) -> dict[str, float]:
    raw_values: dict[str, str] = {}
    for raw in deck.splitlines():
        stripped = strip_spice_comment(raw)
        if not re.match(r"(?i)^\s*\.param\b", stripped):
            continue
        declaration = re.sub(r"(?i)^\s*\.param\b", "", stripped, count=1)
        for match in re.finditer(r"([A-Za-z_]\w*)\s*=\s*(\{[^}]+\}|[^\s]+)", declaration):
            raw_values[match.group(1).lower()] = match.group(2)

    resolved: dict[str, float] = {}

    def resolve(name: str, resolving: set[str]) -> float:
        key = name.lower()
        if key in resolved:
            return resolved[key]
        if key in resolving or key not in raw_values:
            raise ValueError(f"unresolved SPICE parameter: {name}")
        token = raw_values[key].strip()
        reference = token[1:-1].strip() if token.startswith("{") and token.endswith("}") else token
        try:
            value = parse_spice_number(reference)
        except ValueError:
            value = resolve(reference, {*resolving, key})
        resolved[key] = value
        return value

    for parameter in raw_values:
        try:
            resolve(parameter, set())
        except ValueError:
            continue
    return resolved


def passive_ac_current_specs(deck: str) -> list[tuple[str, str, str, str, float]]:
    parameters = simple_spice_parameters(deck)
    specs: list[tuple[str, str, str, str, float]] = []
    for raw in deck.splitlines():
        stripped = strip_spice_comment(raw)
        if not stripped or stripped.startswith("."):
            continue
        tokens = stripped.split()
        if len(tokens) < 4 or tokens[0][:1].upper() not in {"R", "C", "L"}:
            continue
        value_token = tokens[3].strip()
        reference = (
            value_token[1:-1].strip().lower()
            if value_token.startswith("{") and value_token.endswith("}")
            else ""
        )
        try:
            value = parameters[reference] if reference else parse_spice_number(value_token)
        except (KeyError, ValueError):
            continue
        if value > 0:
            specs.append((tokens[0], tokens[0][0].upper(), tokens[1], tokens[2], value))
    return specs


def add_passive_ac_currents(dataset: dict[str, Any], deck: str) -> None:
    if dataset.get("analysis_type") != "ac":
        return
    frequencies = [float(value) for value in dataset.get("x", {}).get("values", [])]
    if not frequencies:
        return
    traces = dataset.get("traces", [])
    by_name = {
        str(trace.get("name", "")).replace(" ", "").lower(): trace
        for trace in traces
    }

    def node_values(node: str) -> list[complex] | None:
        if node.lower() in {"0", "gnd!"}:
            return [0j] * len(frequencies)
        trace = by_name.get(f"v({node})".replace(" ", "").lower())
        if not trace:
            return None
        real = trace.get("real", [])
        imaginary = trace.get("imag", [0.0] * len(real))
        if len(real) != len(frequencies) or len(imaginary) != len(real):
            return None
        return [complex(float(real_value), float(imag_value)) for real_value, imag_value in zip(real, imaginary)]

    for instance, kind, positive_node, negative_node, value in passive_ac_current_specs(deck):
        positive = node_values(positive_node)
        negative = node_values(negative_node)
        if positive is None or negative is None:
            continue
        voltage = [left - right for left, right in zip(positive, negative)]
        if kind == "R":
            current = [item / value for item in voltage]
        elif kind == "C":
            current = [item * complex(0.0, 2.0 * math.pi * frequency * value) for item, frequency in zip(voltage, frequencies)]
        else:
            current = [
                item / complex(0.0, 2.0 * math.pi * frequency * value)
                for item, frequency in zip(voltage, frequencies)
            ]
        magnitude = [abs(item) for item in current]
        replacement = {
            "name": f"i(@{instance}[i])",
            "unit": "A",
            "real": [item.real for item in current],
            "imag": [item.imag for item in current],
            "magnitude": magnitude,
            "db": [20 * math.log10(max(item, 1e-300)) for item in magnitude],
            "phase_deg": [math.degrees(math.atan2(item.imag, item.real)) for item in current],
            "source": "derived_from_ac_node_voltages",
        }
        existing = next(
            (
                index for index, trace in enumerate(traces)
                if str(trace.get("name", "")).replace(" ", "").lower()
                == replacement["name"].replace(" ", "").lower()
            ),
            None,
        )
        if existing is None:
            traces.append(replacement)
        else:
            traces[existing] = replacement


def parse_simulation_specifications(netlist_text: str) -> tuple[list[dict[str, Any]], list[str]]:
    specifications: list[dict[str, Any]] = []
    diagnostics: list[str] = []
    for line_number, raw in enumerate(netlist_text.splitlines(), start=1):
        stripped = raw.strip()
        if not re.match(r"(?i)^\.actoviq\s+spec\b", stripped):
            continue
        try:
            _kind, positional, options = advanced_directive_parts(stripped)
            if not positional:
                raise ValueError("spec requires a metric name")
            if "min" not in options and "max" not in options:
                raise ValueError("spec requires min=, max=, or both")
            minimum = parse_spice_number(options["min"]) if "min" in options else None
            maximum = parse_spice_number(options["max"]) if "max" in options else None
            if minimum is not None and maximum is not None and minimum > maximum:
                raise ValueError("spec min cannot be greater than max")
            specifications.append({
                "metric": positional[0],
                "minimum": minimum,
                "maximum": maximum,
                "unit": options.get("unit", ""),
                "directive": stripped,
                "line": line_number,
            })
        except ValueError as exc:
            diagnostics.append(f"line {line_number}: {exc}")
    return specifications, diagnostics


def evaluate_simulation_specifications(
    metrics: list[dict[str, Any]],
    specifications: list[dict[str, Any]],
) -> tuple[str, list[dict[str, Any]]]:
    if not specifications:
        return "not_evaluated", []
    outcomes: list[dict[str, Any]] = []
    for specification in specifications:
        matching = [metric for metric in metrics if metric.get("name") == specification["metric"]]
        measured = next(
            (
                metric for metric in matching
                if isinstance(metric.get("value"), (int, float)) and math.isfinite(float(metric["value"]))
            ),
            None,
        )
        value = float(measured["value"]) if measured else None
        passed = bool(
            value is not None
            and (specification["minimum"] is None or value >= specification["minimum"])
            and (specification["maximum"] is None or value <= specification["maximum"])
        )
        status = "passed" if passed else "failed" if measured else "missing"
        target = {
            "minimum": specification["minimum"],
            "maximum": specification["maximum"],
            "unit": specification["unit"],
        }
        if measured:
            measured["specification_status"] = status
            measured["specification"] = target
        outcomes.append({
            **specification,
            "value": value,
            "status": status,
        })
    return (
        "passed" if all(outcome["status"] == "passed" for outcome in outcomes) else "failed",
        outcomes,
    )


def replace_sweep_target(deck: str, target: str, value: float) -> tuple[str, bool]:
    formatted = f"{value:.12g}"
    if target.lower().startswith("param:"):
        parameter = target.split(":", 1)[1]
        pattern = re.compile(rf"(?i)(\b{re.escape(parameter)}\s*=\s*)([^\s)]+)")
        replaced, count = pattern.subn(lambda match: f"{match.group(1)}{formatted}", deck, count=1)
        return replaced, count == 1
    output: list[str] = []
    changed = False
    for raw in deck.splitlines():
        tokens = raw.split()
        if tokens and tokens[0].lower() == target.lower() and tokens[0][:1].upper() in {"R", "C", "L"}:
            if len(tokens) < 4:
                return deck, False
            tokens[3] = formatted
            output.append(" ".join(tokens))
            changed = True
        else:
            output.append(raw)
    return "\n".join(output) + ("\n" if deck.endswith("\n") else ""), changed


def select_analysis_plot(plots: list[dict[str, Any]], analysis_type: str) -> dict[str, Any] | None:
    if not plots:
        return None
    if analysis_type == "noise":
        return max(plots, key=lambda plot: int(plot.get("point_count", 0)))
    if analysis_type == "pz":
        return next(
            (plot for plot in plots if "pole" in str(plot.get("plotname", "")).lower()),
            plots[-1],
        )
    return plots[-1]


def configuration_error_result(
    analysis: dict[str, Any],
    analysis_root: Path,
    message: str,
) -> dict[str, Any]:
    return {
        "id": analysis["id"],
        "type": analysis["type"],
        "directive": analysis["directive"],
        "status": "configuration_error",
        "execution_status": "not_run",
        "measurement_status": "not_requested",
        "specification_status": "not_evaluated",
        "diagnostics": [message],
        "metrics": [],
        "dataset": None,
        "deck_path": str(analysis_root / "deck.cir"),
        "log_path": str(analysis_root / "ngspice.log"),
    }


def run_ensemble_analysis(
    executable: str,
    run_root: Path,
    analysis: dict[str, Any],
) -> dict[str, Any]:
    analysis_root = run_root / analysis["id"]
    analysis_root.mkdir(parents=True, exist_ok=True)
    deck_path = analysis_root / "deck.cir"
    atomic_write_text(deck_path, analysis["deck"])
    try:
        count = int(analysis["count"])
        if analysis["type"] == "parameter_sweep":
            if count < 2 or count > 101:
                raise ValueError("parameter sweep count must be between 2 and 101")
            start = parse_spice_number(str(analysis["start"]))
            stop = parse_spice_number(str(analysis["stop"]))
            values = [start + (stop - start) * index / (count - 1) for index in range(count)]
        else:
            if count < 2 or count > 200:
                raise ValueError("Monte Carlo run count must be between 2 and 200")
            nominal = parse_spice_number(str(analysis["start"]))
            relative_sigma = float(analysis["stop"])
            if relative_sigma <= 0 or relative_sigma > 1:
                raise ValueError("Monte Carlo relative sigma must be within 0..1")
            generator = random.Random(int(analysis.get("seed", 1)))
            values = [generator.gauss(nominal, abs(nominal) * relative_sigma) for _ in range(count)]
    except (TypeError, ValueError) as exc:
        return configuration_error_result(analysis, analysis_root, str(exc))

    members_root = analysis_root / "members"
    datasets: list[tuple[float, dict[str, Any]]] = []
    member_summaries: list[dict[str, Any]] = []
    diagnostics: list[str] = []
    for index, value in enumerate(values):
        member_deck, changed = replace_sweep_target(analysis["deck"], analysis["target"], value)
        if not changed:
            return configuration_error_result(
                analysis,
                analysis_root,
                f"Sweep target {analysis['target']} was not found or is not a supported R/C/L device or param.",
            )
        member_id = f"member-{index + 1:03d}"
        member = run_analysis(executable, members_root, {
            "id": member_id,
            "type": analysis["inner_type"],
            "directive_type": analysis["inner_type"],
            "directive": analysis["directive"],
            "deck": member_deck,
        })
        member_summaries.append({
            "id": member_id,
            "value": value,
            "status": member.get("status"),
        })
        member_dataset_path = members_root / member_id / "dataset.json"
        if member.get("status") == "completed" and member_dataset_path.exists():
            datasets.append((value, read_json(member_dataset_path)))
        else:
            diagnostics.extend(str(item) for item in member.get("diagnostics", []))

    if not datasets:
        return {
            **configuration_error_result(analysis, analysis_root, "No ensemble member produced a dataset."),
            "status": "failed",
            "execution_status": "failed",
            "members": member_summaries,
            "diagnostics": diagnostics or ["No ensemble member produced a dataset."],
        }

    first_dataset = datasets[0][1]
    point_count = min(int(dataset.get("point_count", 0)) for _, dataset in datasets)
    x_values = list(first_dataset["x"]["values"][:point_count])
    aggregate_traces: list[dict[str, Any]] = []
    samples: list[float] = []
    for value, dataset in datasets:
        trace = primary_trace(dataset)
        if trace is None:
            continue
        next_trace = {
            key: (list(field[:point_count]) if isinstance(field, list) else field)
            for key, field in trace.items()
        }
        next_trace["name"] = f"{trace['name']} [{analysis['target']}={value:.6g}]"
        aggregate_traces.append(next_trace)
        series = next_trace.get("magnitude") or next_trace.get("real") or []
        if series:
            samples.append(float(series[-1]))

    dataset = {
        "schema": "actoviq.simulation-dataset.v1",
        "id": f"{analysis['id']}-dataset-1",
        "analysis_id": analysis["id"],
        "analysis_type": analysis["type"],
        "plotname": "Parameter sweep" if analysis["type"] == "parameter_sweep" else "Monte Carlo",
        "point_count": point_count,
        "x": {**first_dataset["x"], "values": x_values},
        "traces": aggregate_traces,
        "members": [{"value": value} for value, _dataset in datasets],
    }
    dataset_path = analysis_root / "dataset.json"
    atomic_write_json(dataset_path, dataset)
    metrics = [measured_metric("ensemble_member_count", float(len(datasets)), "")]
    if samples:
        metrics.extend([
            measured_metric("ensemble_output_min", min(samples), aggregate_traces[0].get("unit", "")),
            measured_metric("ensemble_output_max", max(samples), aggregate_traces[0].get("unit", "")),
            measured_metric("ensemble_output_mean", statistics.fmean(samples), aggregate_traces[0].get("unit", "")),
            measured_metric(
                "ensemble_output_stddev",
                statistics.pstdev(samples) if len(samples) > 1 else 0.0,
                aggregate_traces[0].get("unit", ""),
            ),
        ])
    status = "completed" if len(datasets) == len(values) else "partial"
    return {
        "id": analysis["id"],
        "type": analysis["type"],
        "directive": analysis["directive"],
        "status": status,
        "execution_status": "success" if status == "completed" else "partial",
        "measurement_status": "success",
        "specification_status": "not_evaluated",
        "diagnostics": diagnostics,
        "metrics": metrics,
        "members": member_summaries,
        "dataset": {
            "path": str(dataset_path.relative_to(run_root.parent.parent)).replace("\\", "/"),
            "id": dataset["id"],
            "plotname": dataset["plotname"],
            "point_count": point_count,
            "x_name": dataset["x"]["name"],
            "x_unit": dataset["x"]["unit"],
            "traces": [
                {"name": trace["name"], "unit": trace.get("unit", ""), "complex": "imag" in trace}
                for trace in aggregate_traces
            ],
        },
        "deck_path": str(deck_path),
        "log_path": str(analysis_root / "ngspice.log"),
    }


def has_sparameter_ports(deck: str) -> bool:
    ports = {
        int(value)
        for value in re.findall(r"(?im)^\s*v\S+\s+\S+\s+\S+.*\bportnum\s*(?:=\s*)?(\d+)", deck)
    }
    return len(ports) >= 2 and ports == set(range(1, len(ports) + 1))


def run_analysis(
    executable: str,
    run_root: Path,
    analysis: dict[str, Any],
) -> dict[str, Any]:
    analysis_root = run_root / analysis["id"]
    analysis_root.mkdir(parents=True, exist_ok=True)
    deck_path = analysis_root / "deck.cir"
    raw_path = analysis_root / "vectors.raw"
    log_path = analysis_root / "ngspice.log"
    atomic_write_text(deck_path, analysis["deck"])
    if analysis.get("configuration_error"):
        return configuration_error_result(
            analysis,
            analysis_root,
            str(analysis["configuration_error"]),
        )
    if analysis["type"] in {"parameter_sweep", "monte_carlo"}:
        return run_ensemble_analysis(executable, run_root, analysis)
    if analysis["type"] == "sparameter" and not has_sparameter_ports(analysis["deck"]):
        return configuration_error_result(
            analysis,
            analysis_root,
            "S-parameter analysis requires at least two consecutive VSRC portnum ports with Z0.",
        )
    try:
        # Windows rejects long working-directory paths before ngspice starts.
        # Execute from a short temporary directory, then persist every artifact
        # beneath the revisioned run directory once the process has exited.
        with tempfile.TemporaryDirectory(prefix="actoviq-ngspice-") as temporary:
            execution_root = Path(temporary)
            execution_deck_path = execution_root / "deck.cir"
            execution_raw_path = execution_root / "vectors.raw"
            execution_log_path = execution_root / "ngspice.log"
            execution_deck_path.write_text(analysis["deck"], encoding="utf-8")
            command = [executable, "-b"]
            if analysis["type"] != "fft":
                command.extend(["-r", str(execution_raw_path)])
            command.extend(["-o", str(execution_log_path), str(execution_deck_path)])
            completed = subprocess.run(
                command,
                cwd=str(execution_root),
                text=True,
                capture_output=True,
                timeout=120,
                check=False,
            )
            log_text = (
                execution_log_path.read_text(encoding="utf-8", errors="replace")
                if execution_log_path.exists() else ""
            )
            plots = parse_ngspice_raw(execution_raw_path) if execution_raw_path.exists() else []
            if execution_raw_path.exists():
                shutil.copyfile(execution_raw_path, raw_path)
            atomic_write_text(log_path, log_text)
            measurement_log_path: Path | None = None
            measurement_log_text = log_text
            if re.search(r"(?im)^\s*\.meas(?:ure)?\b", analysis["deck"]):
                measurement_log_path = analysis_root / "measurements.log"
                execution_measurement_path = execution_root / "measurements.log"
                subprocess.run(
                    [executable, "-b", "-o", str(execution_measurement_path), str(execution_deck_path)],
                    cwd=str(execution_root),
                    text=True,
                    capture_output=True,
                    timeout=120,
                    check=False,
                )
                measurement_log_text = (
                    execution_measurement_path.read_text(encoding="utf-8", errors="replace")
                    if execution_measurement_path.exists() else ""
                )
                atomic_write_text(measurement_log_path, measurement_log_text)
        selected_plot = select_analysis_plot(plots, analysis["type"])
        dataset = (
            plot_to_dataset(selected_plot, analysis["id"], analysis["type"])
            if selected_plot else None
        )
        dataset_path = analysis_root / "dataset.json"
        if dataset:
            add_passive_ac_currents(dataset, analysis["deck"])
            atomic_write_json(dataset_path, dataset)
        metrics = parse_measurements(analysis["deck"], measurement_log_text)
        if dataset:
            metrics.extend(derived_metrics(dataset))
        measured = [metric for metric in metrics if metric.get("measurement_status") == "measured"]
        status = "completed" if completed.returncode == 0 and dataset else "failed"
        diagnostics = []
        if status == "failed":
            diagnostics.append(log_text[-2000:] or completed.stderr.strip() or "ngspice produced no dataset")
        return {
            "id": analysis["id"],
            "type": analysis["type"],
            "directive": analysis["directive"],
            "status": status,
            "execution_status": "success" if completed.returncode == 0 else "failed",
            "measurement_status": (
                "not_requested" if not metrics else "success" if len(measured) == len(metrics) else "partial"
            ),
            "specification_status": "not_evaluated",
            "return_code": completed.returncode,
            "diagnostics": diagnostics,
            "metrics": metrics,
            "dataset": ({
                "path": str(dataset_path.relative_to(run_root.parent.parent)).replace("\\", "/"),
                "id": dataset["id"],
                "plotname": dataset["plotname"],
                "point_count": dataset["point_count"],
                "x_name": dataset["x"]["name"],
                "x_unit": dataset["x"]["unit"],
                "traces": [
                    {"name": trace["name"], "unit": trace["unit"], "complex": "imag" in trace}
                    for trace in dataset["traces"]
                ],
            } if dataset else None),
            "deck_path": str(deck_path),
            "raw_path": str(raw_path) if raw_path.exists() else None,
            "log_path": str(log_path),
            "measurement_log_path": str(measurement_log_path) if measurement_log_path else None,
            "stderr": completed.stderr.strip(),
        }
    except subprocess.TimeoutExpired:
        return {
            "id": analysis["id"],
            "type": analysis["type"],
            "directive": analysis["directive"],
            "status": "failed",
            "execution_status": "timeout",
            "measurement_status": "not_requested",
            "specification_status": "not_evaluated",
            "diagnostics": ["ngspice analysis exceeded the 120 second timeout."],
            "metrics": [],
            "dataset": None,
            "deck_path": str(deck_path),
            "log_path": str(log_path),
        }


def execute_simulation_run(
    root: Path,
    executable: str,
    netlist_path: Path,
    source_revision: int,
    document_hash: str,
    scope: str,
) -> dict[str, Any]:
    netlist_text = netlist_path.read_text(encoding="utf-8", errors="replace")
    simulation_root = netlist_path.parent / "simulation"
    runs_root = simulation_root / "runs"
    run_id = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}-{document_hash[:8] or 'document'}"
    run_root = runs_root / run_id
    run_root.mkdir(parents=True, exist_ok=False)
    analyses = [run_analysis(executable, run_root, analysis) for analysis in split_analysis_decks(netlist_text)]
    metrics = [metric for analysis in analyses for metric in analysis.get("metrics", [])]
    specifications, specification_diagnostics = parse_simulation_specifications(netlist_text)
    specification_status, specification_results = evaluate_simulation_specifications(metrics, specifications)
    if specification_diagnostics:
        specification_status = "invalid"
    for analysis in analyses:
        metric_names = {metric.get("name") for metric in analysis.get("metrics", [])}
        relevant = [result for result in specification_results if result["metric"] in metric_names]
        analysis["specification_status"] = (
            "not_evaluated" if not relevant else
            "passed" if all(result["status"] == "passed" for result in relevant) else "failed"
        )
    completed = [analysis for analysis in analyses if analysis.get("status") == "completed"]
    failed = [analysis for analysis in analyses if analysis.get("status") != "completed"]
    result = {
        "schema": "actoviq.simulation.v2",
        "run_id": run_id,
        "scope": scope,
        "source_revision": source_revision,
        "document_hash": document_hash,
        "ok": len(failed) == 0 and len(completed) > 0,
        "execution_status": "success" if not failed else "partial" if completed else "failed",
        "measurement_status": (
            "not_requested" if not metrics else
            "success" if all(metric.get("measurement_status") == "measured" for metric in metrics) else "partial"
        ),
        "specification_status": specification_status,
        "verified": specification_status == "passed",
        "specifications": specification_results,
        "specification_diagnostics": specification_diagnostics,
        "analysis_count": len(analyses),
        "analyses": analyses,
        "metrics": metrics,
        "ngspice": executable,
        "simulated_at": utc_now(),
    }
    atomic_write_json(run_root / "run.json", result)
    atomic_write_json(simulation_root / "result.json", result)
    return result


def simulate_project(root: Path, ngspice_bin: str) -> dict[str, Any]:
    compile_result = compile_project(root)
    executable = resolve_ngspice(ngspice_bin)
    netlist_path = Path(compile_result["netlist_path"])
    manifest_path = root / "build" / "build-manifest.json"
    manifest = read_json(manifest_path)
    result = execute_simulation_run(
        root,
        executable,
        netlist_path,
        int(manifest.get("source_revision", manifest.get("revision", compile_result.get("revision", 0)))),
        str(manifest.get("document_hash", "")),
        "project",
    )
    manifest["status"] = "simulated" if result["ok"] else "simulation_failed"
    manifest["simulation"] = "system/simulation/result.json"
    manifest["simulation_run_id"] = result["run_id"]
    atomic_write_json(manifest_path, manifest)
    report_project, report_modules = load_project(root)
    write_project_report(
        root,
        report_project,
        report_modules,
        netlist_path.read_text(encoding="utf-8"),
        result,
    )
    return result


def simulate_module(root: Path, module_id: str, ngspice_bin: str) -> dict[str, Any]:
    compile_result = compile_module(root, module_id)
    executable = resolve_ngspice(ngspice_bin)
    netlist_path = Path(compile_result["netlist_path"])
    manifest_path = root / "build" / "build-manifest.json"
    manifest = read_json(manifest_path)
    result = execute_simulation_run(
        root,
        executable,
        netlist_path,
        int(manifest.get("source_revision", manifest.get("revision", 0))),
        str(manifest.get("document_hash", project_document_hash(*load_project(root)))),
        f"module:{module_id}",
    )
    result["module_id"] = module_id
    atomic_write_json(netlist_path.parent / "simulation" / "result.json", result)
    manifest.setdefault("modules", {}).setdefault(module_id, {})["status"] = (
        "simulated" if result["ok"] else "simulation_failed"
    )
    manifest["modules"][module_id]["simulation"] = f"modules/{module_id}/simulation/result.json"
    manifest["modules"][module_id]["simulation_run_id"] = result["run_id"]
    atomic_write_json(manifest_path, manifest)
    return result


def project_summary(root: Path) -> dict[str, Any]:
    project, modules = load_project(root)
    erc = evaluate_erc(project, modules)
    modules = {
        module_id: hydrated_summary_module(root, module_id, module)
        for module_id, module in modules.items()
    }
    for module_ref in project.get("modules", []):
        module_id = module_ref.get("id")
        if module_id in modules and modules[module_id].get("ports"):
            module_ref["ports"] = modules[module_id]["ports"]
    return {
        "ok": True,
        "project": project,
        "modules": modules,
        "erc": erc,
        "project_root": str(root.resolve()),
    }


def agent_context(root: Path) -> dict[str, Any]:
    project, modules = load_project(root)
    erc = write_erc_result(root, project, modules)
    document_hash = project_document_hash(project, modules)
    manifest_path = root / "build" / "build-manifest.json"
    manifest = read_json(manifest_path) if manifest_path.exists() else None
    simulation_path = root / "build" / "system" / "simulation" / "result.json"
    simulation = read_json(simulation_path) if simulation_path.exists() else None
    build_current = bool(
        manifest
        and int(manifest.get("source_revision", manifest.get("revision", -1))) == project["revision"]
        and str(manifest.get("document_hash", "")) == document_hash
    )
    simulation_current = bool(
        simulation
        and int(simulation.get("source_revision", -1)) == project["revision"]
        and str(simulation.get("document_hash", "")) == document_hash
    )
    if erc["blocking"]:
        next_action = "fix_erc"
    elif not build_current:
        next_action = "compile"
    elif not simulation_current:
        next_action = "simulate"
    elif simulation and simulation.get("specification_status") == "not_evaluated":
        next_action = "evaluate_specifications"
    else:
        next_action = "ready"
    return {
        "ok": True,
        "protocol_version": AGENT_PROTOCOL_VERSION,
        "compatibility": {
            "project_schema": PROJECT_SCHEMA,
            "module_schema": MODULE_SCHEMA,
            "command_schema": COMMAND_SCHEMA,
            "erc_schema": ERC_SCHEMA,
            "simulation_schema": "actoviq.simulation.v2",
        },
        "workspace_root": str(root.parent.parent.resolve()),
        "project_root": str(root.resolve()),
        "project_id": project["project_id"],
        "base_revision": project["revision"],
        "document_hash": document_hash,
        "project": project,
        "modules": modules,
        "erc": erc,
        "build": {
            "state": "current" if build_current else "stale" if manifest else "missing",
            "manifest": manifest,
        },
        "simulation": {
            "state": "current" if simulation_current else "stale" if simulation else "missing",
            "run": simulation,
        },
        "next_action": next_action,
        "transaction": {
            "schema": COMMAND_SCHEMA,
            "project_id": project["project_id"],
            "base_revision": project["revision"],
            "allowed_operations": [
                "upsert_module_netlist",
                "set_module_netlist",
                "set_module_schematic",
                "upsert_module",
                "remove_module",
                "add_component",
                "remove_component",
                "add_port",
                "connect_pins",
                "connect_ports",
                "set_connection_network",
                "set_component_value",
                "move_component",
                "set_module_metadata",
                "set_module_note",
            ],
        },
    }


def parse_command(args: argparse.Namespace) -> dict[str, Any]:
    if args.command_json:
        return json.loads(args.command_json)
    if args.command_file:
        return read_json(Path(args.command_file))
    raise ValueError("--command-json or --command-file is required")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    for name, demo in (("create", False), ("create-demo", True)):
        subparser = subparsers.add_parser(name)
        subparser.add_argument(
            "--projects-root",
            default="",
            help="Projects directory. Defaults to the active GUI workspace projectsDir.",
        )
        subparser.add_argument(
            "--workspace-id",
            default="",
            help="Create under this workspace's projectsDir (does not change active).",
        )
        subparser.add_argument("--name", required=True)
        subparser.add_argument("--project-id", default="")
        subparser.set_defaults(demo=demo)

    workspace_list = subparsers.add_parser(
        "workspace-list",
        help="List GUI workspaces and mark the active one.",
    )
    workspace_list.set_defaults()

    workspace_active = subparsers.add_parser(
        "workspace-active",
        help="Show the active workspace root and projectsDir (use before create).",
    )
    workspace_active.set_defaults()

    workspace_use = subparsers.add_parser(
        "workspace-use",
        help="Select the active workspace (shared with the Electron GUI).",
    )
    workspace_use.add_argument("--workspace-id", required=True)

    workspace_resolve = subparsers.add_parser(
        "workspace-resolve-projects-root",
        help="Resolve where create/create-demo will write projects.",
    )
    workspace_resolve.add_argument("--projects-root", default="")
    workspace_resolve.add_argument("--workspace-id", default="")

    summary = subparsers.add_parser("summary")
    summary.add_argument("--project-root", required=True)

    erc_parser = subparsers.add_parser("erc")
    erc_parser.add_argument("--project-root", required=True)

    agent_context_parser = subparsers.add_parser("agent-context")
    agent_context_parser.add_argument("--project-root", required=True)

    apply_parser = subparsers.add_parser("apply")
    apply_parser.add_argument("--project-root", required=True)
    apply_parser.add_argument("--command-json", default="")
    apply_parser.add_argument("--command-file", default="")

    compile_parser = subparsers.add_parser("compile")
    compile_parser.add_argument("--project-root", required=True)

    compile_module_parser = subparsers.add_parser("compile-module")
    compile_module_parser.add_argument("--project-root", required=True)
    compile_module_parser.add_argument("--module-id", required=True)
    compile_module_parser.add_argument(
        "--renderer",
        default="netlistsvg",
        choices=["netlistsvg", "grid-experimental"],
    )

    simulate_parser = subparsers.add_parser("simulate")
    simulate_parser.add_argument("--project-root", required=True)
    simulate_parser.add_argument("--ngspice-bin", default="")

    simulate_module_parser = subparsers.add_parser("simulate-module")
    simulate_module_parser.add_argument("--project-root", required=True)
    simulate_module_parser.add_argument("--module-id", required=True)
    simulate_module_parser.add_argument("--ngspice-bin", default="")

    export_parser = subparsers.add_parser(
        "export-eda",
        help="Export editable schematic packages from the current structured project revision.",
    )
    export_parser.add_argument("--project-root", required=True)
    export_parser.add_argument("--scope", choices=["project", "module"], default="project")
    export_parser.add_argument("--module-id", default="")
    export_parser.add_argument("--targets", default="kicad,altium,orcad,virtuoso")
    export_parser.add_argument("--view", choices=["design", "simulation"], default="design")
    export_parser.add_argument("--mapping-file", default="")
    export_parser.add_argument("--native-convert", choices=["auto", "never", "required"], default="auto")
    export_parser.add_argument("--strict-layout", action="store_true")
    export_parser.add_argument("--source-revision", type=int, required=True)
    export_parser.add_argument(
        "--output-dir",
        default="",
        help="Optional parent directory for the export. Defaults to <project>/build/exports.",
    )

    prepare_layout_parser = subparsers.add_parser(
        "prepare-layout-review",
        help="Prepare a deterministic routed candidate and vision-review stage without modifying the project.",
    )
    prepare_layout_parser.add_argument("--project-root", required=True)
    prepare_layout_parser.add_argument("--module-id", required=True)
    prepare_layout_parser.add_argument("--source-revision", type=int, required=True)
    prepare_layout_parser.add_argument("--view", choices=["design", "simulation"], default="design")
    prepare_layout_parser.add_argument("--output-dir", required=True)

    evaluate_layout_parser = subparsers.add_parser(
        "evaluate-layout-patches",
        help="Validate and score one strict vision layout patch-set without modifying the project.",
    )
    evaluate_layout_parser.add_argument("--project-root", required=True)
    evaluate_layout_parser.add_argument("--module-id", required=True)
    evaluate_layout_parser.add_argument("--source-revision", type=int, required=True)
    evaluate_layout_parser.add_argument("--state-path", required=True)
    evaluate_layout_parser.add_argument("--view", choices=["design", "simulation"], default=None)
    evaluate_layout_parser.add_argument("--output-dir", required=True)
    patch_source = evaluate_layout_parser.add_mutually_exclusive_group(required=True)
    patch_source.add_argument("--patch-set-json", default="")
    patch_source.add_argument("--patch-set-file", default="")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "workspace-list":
            result = list_workspaces()
        elif args.command == "workspace-active":
            result = get_active_workspace()
        elif args.command == "workspace-use":
            result = select_workspace(args.workspace_id)
        elif args.command == "workspace-resolve-projects-root":
            result = resolve_projects_root(
                projects_root=args.projects_root or None,
                workspace_id=args.workspace_id or None,
            )
        elif args.command in {"create", "create-demo"}:
            resolved = resolve_projects_root(
                projects_root=args.projects_root or None,
                workspace_id=args.workspace_id or None,
            )
            root = initialize_project(
                Path(resolved["projects_root"]),
                args.name,
                args.project_id or None,
                bool(args.demo),
            )
            result = {
                **project_summary(root),
                "workspace_resolution": resolved,
            }
        elif args.command == "summary":
            result = project_summary(Path(args.project_root).resolve())
        elif args.command == "erc":
            root = Path(args.project_root).resolve()
            result = write_erc_result(root, *load_project(root))
            result = {"ok": True, **result}
        elif args.command == "agent-context":
            result = agent_context(Path(args.project_root).resolve())
        elif args.command == "apply":
            result = apply_command(Path(args.project_root).resolve(), parse_command(args))
        elif args.command == "compile":
            result = compile_project(Path(args.project_root).resolve())
        elif args.command == "compile-module":
            result = compile_module(Path(args.project_root).resolve(), args.module_id, args.renderer)
        elif args.command == "simulate":
            result = simulate_project(Path(args.project_root).resolve(), args.ngspice_bin)
        elif args.command == "simulate-module":
            result = simulate_module(
                Path(args.project_root).resolve(),
                args.module_id,
                args.ngspice_bin,
            )
        elif args.command == "export-eda":
            root = Path(args.project_root).resolve()
            project, modules = load_project(root)
            erc = evaluate_erc(project, modules)
            requested_targets = [target.strip().lower() for target in args.targets.split(",") if target.strip()]
            result = export_eda(
                root,
                project,
                modules,
                erc,
                project_document_hash(project, modules),
                scope=args.scope,
                module_id=args.module_id or None,
                targets=requested_targets,
                view=args.view,
                mapping_file=args.mapping_file,
                native_convert=args.native_convert,
                strict_layout=bool(args.strict_layout),
                source_revision=args.source_revision,
                output_dir=args.output_dir or None,
            )
        elif args.command == "prepare-layout-review":
            root = Path(args.project_root).resolve()
            project, modules = load_project(root)
            result = prepare_layout_review(
                project,
                modules,
                module_id=args.module_id,
                view=args.view,
                document_hash=project_document_hash(project, modules),
                source_revision=args.source_revision,
                output_dir=Path(args.output_dir).resolve(),
            )
        elif args.command == "evaluate-layout-patches":
            root = Path(args.project_root).resolve()
            project, modules = load_project(root)
            patch_set = json.loads(args.patch_set_json) if args.patch_set_json else read_json(Path(args.patch_set_file).resolve())
            result = evaluate_layout_patches(
                project,
                modules,
                read_json(Path(args.state_path).resolve()),
                patch_set,
                module_id=args.module_id,
                document_hash=project_document_hash(project, modules),
                source_revision=args.source_revision,
                output_dir=Path(args.output_dir).resolve(),
                view=args.view,
            )
        else:
            raise ValueError(f"unknown command: {args.command}")
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
