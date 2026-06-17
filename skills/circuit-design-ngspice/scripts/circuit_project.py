#!/usr/bin/env python3
"""Deterministic project editor/compiler for the Actoviq schematic canvas."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PROJECT_SCHEMA = "actoviq.project.v1"
MODULE_SCHEMA = "actoviq.module.v1"
COMMAND_SCHEMA = "actoviq.command.v1"
ALLOWED_COMPONENT_TYPES = {"R", "C", "L", "D", "Q", "M", "V", "I"}


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


def project_path(root: Path) -> Path:
    return root / "project.circuit.json"


def module_path(root: Path, module_id: str) -> Path:
    return root / "modules" / module_id / "module.circuit.json"


def ensure_inside(root: Path, candidate: Path) -> None:
    try:
        candidate.resolve().relative_to(root.resolve())
    except ValueError as exc:
        raise ValueError(f"path escapes project root: {candidate}") from exc


def validate_project(project: dict[str, Any]) -> None:
    if project.get("schema") != PROJECT_SCHEMA:
        raise ValueError(f"project schema must be {PROJECT_SCHEMA}")
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
    if module.get("schema") != MODULE_SCHEMA:
        raise ValueError(f"module schema must be {MODULE_SCHEMA}")
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
            raise ValueError(f"unsupported primitive component type: {component_type}")
        component_ids.add(component_id)
        for pin in component.get("pins", []):
            pin_id = pin.get("id")
            key = (component_id, pin_id)
            if not pin_id or key in pin_keys:
                raise ValueError("component pin ids must be present and unique")
            if not isinstance(pin.get("net"), str) or not pin["net"]:
                raise ValueError(f"pin {component_id}.{pin_id} has no net")
            pin_keys.add(key)
    port_ids = [port.get("id") for port in module.get("ports", [])]
    if len(port_ids) != len(set(port_ids)) or any(not value for value in port_ids):
        raise ValueError("module port ids must be present and unique")


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
        modules[module_ref["id"]] = module
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
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    operation: dict[str, Any],
    changed_modules: set[str],
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
        old_net = second_pin["net"]
        new_net = first_pin["net"]
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


def apply_command(root: Path, command: dict[str, Any]) -> dict[str, Any]:
    if command.get("schema") != COMMAND_SCHEMA:
        raise ValueError(f"command schema must be {COMMAND_SCHEMA}")
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

    snapshot_revision(root, project, modules, command)
    changed_modules: set[str] = set()
    for operation in operations:
        apply_operation(project, modules, operation, changed_modules)

    project["revision"] += 1
    project["updated_at"] = utc_now()
    for module_id in changed_modules:
        modules[module_id]["revision"] = int(modules[module_id].get("revision", 0)) + 1
        validate_module(modules[module_id])
    validate_project(project)
    for module_id in changed_modules:
        atomic_write_json(module_path(root, module_id), modules[module_id])
    atomic_write_json(project_path(root), project)
    command_id = command.get("command_id") or f"command-{project['revision']:06d}"
    applied_path = root / "commands" / "applied" / f"{command_id}.json"
    atomic_write_json(applied_path, {**command, "applied_revision": project["revision"], "applied_at": utc_now()})
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

    source_map: dict[str, Any] = {"components": {}, "nodes": {}}
    lines = [
        f"* {project['name']}",
        "* Generated from actoviq.project.v1 by circuit_project.py",
    ]
    output_nodes: list[str] = []
    for module_ref in project["modules"]:
        module_id = module_ref["id"]
        module = modules[module_id]
        local_node_map: dict[str, str] = {"0": "0"}
        for port in module.get("ports", []):
            root_key = union.find(f"{module_id}::{port['id']}")
            local_node_map[port["net"]] = global_names[root_key]
            if port.get("direction") == "output" and port.get("signal_type") == "analog":
                output_nodes.append(global_names[root_key])
        lines.append(f"* MODULE: {module_id} - {module['name']}")
        for component in module["components"]:
            component_name = sanitize_node(f"{module_id}_{component['name']}")
            component_type = component["type"]
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

    ac = project.get("analyses", {}).get("ac", {})
    if ac.get("enabled", True):
        points = int(ac.get("points_per_decade", 20))
        start = float(ac.get("start_hz", 10))
        stop = float(ac.get("stop_hz", 1_000_000))
        lines.append(f".ac dec {points} {start:g} {stop:g}")
        if output_nodes:
            output_node = output_nodes[-1]
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
        "built_at": utc_now(),
        "status": "compiled",
        "netlist": "system/design.final.cir",
        "source_map": "system/source-map.json",
    }
    atomic_write_json(root / "build" / "build-manifest.json", manifest)
    return {
        "ok": True,
        "project_id": project["project_id"],
        "revision": project["revision"],
        "netlist_path": str(netlist_path),
        "manifest_path": str(root / "build" / "build-manifest.json"),
        "primary_output_node": source_map.get("primary_output_node"),
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


def render_module_schematic(
    build_root: Path,
    netlist_path: Path,
    module: dict[str, Any],
) -> dict[str, Any]:
    scripts_root = Path(__file__).resolve().parent
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
    svg_path = build_root / "schematic.svg"
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
    rendered = run_json_script(
        scripts_root / "render_netlistsvg.py",
        [
            "--json-path", str(json_path),
            "--svg-path", str(svg_path),
            "--netlistsvg-bin", "netlistsvg",
            "--skin-profile", "analog",
            "--timeout-sec", "45",
        ],
        timeout_sec=60,
    )
    return {
        "ok": bool(rendered.get("ok")) and svg_path.exists(),
        "json_path": str(json_path),
        "svg_path": str(svg_path) if svg_path.exists() else "",
        "renderer": "netlistsvg",
        "details": rendered,
    }


def compile_module(root: Path, module_id: str) -> dict[str, Any]:
    project, modules = load_project(root)
    if module_id not in modules:
        raise ValueError(f"unknown module: {module_id}")
    module = modules[module_id]
    lines = [
        f"* {project['name']} / {module['name']}",
        "* Standalone module testbench generated by circuit_project.py",
    ]
    node_map: dict[str, str] = {"0": "0"}

    def node_name(local_net: str) -> str:
        if local_net not in node_map:
            node_map[local_net] = sanitize_node(local_net)
        return node_map[local_net]

    driven_nets: set[str] = set()
    for component in module["components"]:
        component_name = sanitize_node(f"{module_id}_{component['name']}")
        component_type = component["type"]
        if not component_name.upper().startswith(component_type):
            component_name = f"{component_type}{component_name}"
        nodes = [node_name(pin["net"]) for pin in component["pins"]]
        lines.append(" ".join([component_name, *nodes, str(component["value"])]))
        if component_type in {"V", "I"} and component["pins"]:
            driven_nets.add(component["pins"][0]["net"])

    analog_outputs: list[str] = []
    for port in module.get("ports", []):
        net = port["net"]
        node = node_name(net)
        if port["signal_type"] == "analog" and port["direction"] == "input" and net not in driven_nets:
            lines.append(f"Vtest_{sanitize_node(port['id'])} {node} 0 DC 0 AC 1")
            driven_nets.add(net)
        elif port["signal_type"] == "power" and port["direction"] == "input" and net not in driven_nets:
            lines.append(f"Vtest_{sanitize_node(port['id'])} {node} 0 DC 5")
            driven_nets.add(net)
        if port["signal_type"] == "analog" and port["direction"] == "output":
            analog_outputs.append(node)
            lines.append(f"Rload_{sanitize_node(port['id'])} {node} 0 1meg")

    lines.append(".ac dec 20 10 1meg")
    if analog_outputs:
        output_node = analog_outputs[-1]
        lines.append(f".meas ac module_output_1khz_db find vdb({output_node}) at=1k")
        lines.append(f".meas ac module_output_10khz_db find vdb({output_node}) at=10k")
        lines.append(f".print ac vdb({output_node})")
    lines.append(".end")

    notebook_path = root / "modules" / module_id / "netlist-notebook.md"
    netlist_text = (
        extract_notebook_netlist(notebook_path.read_text(encoding="utf-8"))
        if notebook_path.exists()
        else "\n".join(lines) + "\n"
    )
    build_root = root / "build" / "modules" / module_id
    build_root.mkdir(parents=True, exist_ok=True)
    netlist_path = build_root / "design.cir"
    netlist_path.write_text(netlist_text, encoding="utf-8")
    render_result = render_module_schematic(build_root, netlist_path, module)
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
        "renderer": "netlistsvg",
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
    metrics = []
    for name, value in re.findall(
        r"(?im)^\s*(output_(?:1khz|10khz)_db)\s*=\s*([-+0-9.eE]+)",
        log_text,
    ):
        metrics.append({"name": name, "value": float(value), "unit": "dB", "pass": True})
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
    metrics = [
        {"name": name, "value": float(value), "unit": "dB", "pass": True}
        for name, value in re.findall(
            r"(?im)^\s*(module_output_(?:1khz|10khz)_db)\s*=\s*([-+0-9.eE]+)",
            log_text,
        )
    ]
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
            result = compile_module(Path(args.project_root).resolve(), args.module_id)
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
