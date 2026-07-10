#!/usr/bin/env python3
"""Deterministic project editor/compiler for the Actoviq schematic canvas."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PROJECT_SCHEMA = "actoviq.project.v2"
MODULE_SCHEMA = "actoviq.module.v2"
LEGACY_PROJECT_SCHEMAS = {"actoviq.project.v1", PROJECT_SCHEMA}
LEGACY_MODULE_SCHEMAS = {"actoviq.module.v1", MODULE_SCHEMA}
COMMAND_SCHEMA = "actoviq.command.v1"
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
    ".temp", ".control", ".endc",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")[:48]
    return slug or "circuit-project"


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


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
    os.replace(temp_path, path)


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False
    ) as handle:
        handle.write(content)
        temp_path = Path(handle.name)
    os.replace(temp_path, path)


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
    component_ids: set[str] = set()
    pin_keys: set[tuple[str, str]] = set()
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
            side = pin.get("side")
            if side is not None and side not in BLOCK_PIN_SIDES:
                raise ValueError(f"pin {component_id}.{pin_id} has invalid side: {side}")
            pin_keys.add(key)
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


def stable_net_token(value: str) -> str:
    token = re.sub(r"[^A-Za-z0-9_]+", "_", value).strip("_") or "net"
    return f"net_{token}"


def upgrade_module_document(module: dict[str, Any]) -> dict[str, Any]:
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
        if current_id and str(current_id) in existing:
            return str(current_id)
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
        module = read_json(path)
        validate_module(module)
        if module["module_id"] != module_ref["id"]:
            raise ValueError(f"module id mismatch: {module_ref['id']}")
        modules[module_ref["id"]] = upgrade_module_document(module)
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
    notebook_writes: dict[str, str] | None = None,
) -> None:
    result_root = revision_root / "result"
    atomic_write_json(result_root / "project.circuit.json", project)
    digest = hashlib.sha256(json.dumps(project, ensure_ascii=False, sort_keys=True).encode("utf-8"))
    for module_id, module in sorted(modules.items()):
        atomic_write_json(result_root / "modules" / module_id / "module.circuit.json", module)
        digest.update(json.dumps(module, ensure_ascii=False, sort_keys=True).encode("utf-8"))
        notebook = (notebook_writes or {}).get(module_id)
        if notebook is not None:
            atomic_write_text(result_root / "modules" / module_id / "netlist-notebook.md", notebook)
            digest.update(notebook.encode("utf-8"))
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


def apply_operation(
    root: Path,
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    operation: dict[str, Any],
    changed_modules: set[str],
    schematic_override_writes: dict[str, dict[str, Any]],
    notebook_writes: dict[str, str],
) -> None:
    op = operation.get("op")
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
    if op == "set_module_schematic":
        module_id = operation["module_id"]
        module = modules[module_id]
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
        netlist_text = extract_notebook_netlist(notebook)
        parsed_components = parse_editable_netlist_components(module_id, netlist_text, module)
        parsed_ids = {str(component.get("id")) for component in parsed_components}
        schematic_blocks = [
            component for component in module.get("components", [])
            if component.get("type") == "BLOCK" and str(component.get("id")) not in parsed_ids
        ]
        components = [*parsed_components, *schematic_blocks]
        if not components:
            raise ValueError("netlist contains no editable or preserved components")
        ports = infer_editable_ports(list(module.get("ports", [])), components)
        next_module = upgrade_module_document({
            **module,
            "components": components,
            "ports": ports,
            "spice": parse_spice_source(module_id, netlist_text, components),
        })
        validate_module(next_module)
        modules[module_id] = next_module
        find_module_ref(project, module_id)["ports"] = ports
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
    notebook_writes: dict[str, str] = {}
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
        atomic_write_text(root / "modules" / module_id / "netlist-notebook.md", notebook)
    for module_id in changed_modules:
        atomic_write_json(module_path(root, module_id), modules[module_id])
    for module_id, overrides in schematic_override_writes.items():
        atomic_write_json(schematic_overrides_path(root, module_id), overrides)
    atomic_write_json(project_path(root), project)
    command_id = command.get("command_id") or f"command-{project['revision']:06d}"
    applied_path = root / "commands" / "applied" / f"{command_id}.json"
    atomic_write_json(applied_path, {**command, "applied_revision": project["revision"], "applied_at": utc_now()})
    write_revision_result(revision_root, project, modules, notebook_writes)
    return {
        "ok": True,
        "project_id": project["project_id"],
        "revision": project["revision"],
        "changed_modules": sorted(changed_modules),
        "command_path": str(applied_path),
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

    lines.extend(["## Simulation", ""])
    if simulation is None:
        lines.append("_Not simulated yet. Run \"Simulate system\" to populate AC metrics._")
    else:
        status = "passed" if simulation.get("ok") else "failed"
        lines.append(
            f"ngspice **{status}** · {simulation.get('ngspice', '')} · {simulation.get('simulated_at', '')}"
        )
        lines.append("")
        metrics = simulation.get("metrics") or []
        if metrics:
            lines.append("| Metric | Value | Status |")
            lines.append("| --- | --- | --- |")
            for metric in metrics:
                unit = metric.get("unit", "")
                verdict = "PASS" if metric.get("pass") else "FAIL"
                value = metric.get("value")
                shown = f"{value:.4g} {unit}".strip() if isinstance(value, (int, float)) else "failed"
                lines.append(f"| {metric['name']} | {shown} | {verdict} |")
        else:
            lines.append("_No measurements were produced._")
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
    report_path.write_text(
        build_report_markdown(project, modules, netlist_text, simulation),
        encoding="utf-8",
    )
    return report_path


def compile_project(root: Path) -> dict[str, Any]:
    project, modules = load_project(root)
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
    atomic_write_json(manifest_path, manifest)
    return {
        "ok": True,
        "project_id": project["project_id"],
        "module_id": module_id,
        "revision": module["revision"],
        "netlist_path": str(netlist_path),
        "schematic_path": render_result.get("svg_path", ""),
        "render": render_result,
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
        })
    return metrics


def simulate_project(root: Path, ngspice_bin: str) -> dict[str, Any]:
    compile_result = compile_project(root)
    executable = resolve_ngspice(ngspice_bin)
    netlist_path = Path(compile_result["netlist_path"])
    simulation_root = root / "build" / "system" / "simulation"
    simulation_root.mkdir(parents=True, exist_ok=True)
    log_path = simulation_root / "ngspice.log"
    completed = subprocess.run(
        [executable, "-b", "-o", str(log_path), str(netlist_path)],
        cwd=str(simulation_root),
        text=True,
        capture_output=True,
        timeout=120,
        check=False,
    )
    log_text = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
    metrics = parse_measurements(netlist_path.read_text(encoding="utf-8", errors="replace"), log_text)
    result = {
        "schema": "actoviq.simulation.v1",
        "ok": completed.returncode == 0,
        "return_code": completed.returncode,
        "ngspice": executable,
        "log_path": str(log_path),
        "metrics": metrics,
        "stderr": completed.stderr.strip(),
        "simulated_at": utc_now(),
    }
    atomic_write_json(simulation_root / "result.json", result)
    manifest_path = root / "build" / "build-manifest.json"
    manifest = read_json(manifest_path)
    manifest["status"] = "simulated" if result["ok"] else "simulation_failed"
    manifest["simulation"] = "system/simulation/result.json"
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
    simulation_root = netlist_path.parent / "simulation"
    simulation_root.mkdir(parents=True, exist_ok=True)
    log_path = simulation_root / "ngspice.log"
    completed = subprocess.run(
        [executable, "-b", "-o", str(log_path), str(netlist_path)],
        cwd=str(simulation_root),
        text=True,
        capture_output=True,
        timeout=120,
        check=False,
    )
    log_text = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
    metrics = parse_measurements(netlist_path.read_text(encoding="utf-8", errors="replace"), log_text)
    result = {
        "schema": "actoviq.module-simulation.v1",
        "ok": completed.returncode == 0,
        "module_id": module_id,
        "return_code": completed.returncode,
        "ngspice": executable,
        "log_path": str(log_path),
        "metrics": metrics,
        "stderr": completed.stderr.strip(),
        "simulated_at": utc_now(),
    }
    atomic_write_json(simulation_root / "result.json", result)
    manifest_path = root / "build" / "build-manifest.json"
    manifest = read_json(manifest_path)
    manifest.setdefault("modules", {}).setdefault(module_id, {})["status"] = (
        "simulated" if result["ok"] else "simulation_failed"
    )
    manifest["modules"][module_id]["simulation"] = f"modules/{module_id}/simulation/result.json"
    atomic_write_json(manifest_path, manifest)
    return result


def project_summary(root: Path) -> dict[str, Any]:
    project, modules = load_project(root)
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
        "project_root": str(root.resolve()),
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
        subparser.add_argument("--projects-root", required=True)
        subparser.add_argument("--name", required=True)
        subparser.add_argument("--project-id", default="")
        subparser.set_defaults(demo=demo)

    summary = subparsers.add_parser("summary")
    summary.add_argument("--project-root", required=True)

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
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command in {"create", "create-demo"}:
            root = initialize_project(
                Path(args.projects_root).resolve(),
                args.name,
                args.project_id or None,
                bool(args.demo),
            )
            result = project_summary(root)
        elif args.command == "summary":
            result = project_summary(Path(args.project_root).resolve())
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
        else:
            raise ValueError(f"unknown command: {args.command}")
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
