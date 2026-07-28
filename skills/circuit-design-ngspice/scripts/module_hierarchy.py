#!/usr/bin/env python3
"""Hierarchical MODULE instances, symbol geometry, connectivity, and safe netlist formats."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any


PLACEHOLDER_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")
SAFE_TOKEN_RE = re.compile(r"^[A-Za-z0-9_.+\-]+$")


def _canonical_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def ordered_connectivity_snapshot(module: dict[str, Any]) -> list[list[str]]:
    """Ordered pin/port bindings used as the connectivity authority."""
    rows: list[list[str]] = []
    for port in module.get("ports", []) or []:
        rows.append([
            "port",
            str(port.get("id") or ""),
            str(port.get("net_id") or port.get("net") or ""),
        ])
    for component in module.get("components", []) or []:
        identity = str(component.get("stable_id") or component.get("id") or "")
        for pin in component.get("pins", []) or []:
            rows.append([
                "pin",
                identity,
                str(pin.get("id") or ""),
                str(pin.get("net_id") or pin.get("net") or ""),
            ])
    return rows


def ordered_connectivity_hash(module: dict[str, Any]) -> str:
    return _canonical_hash(ordered_connectivity_snapshot(module))


def side_for_port(port: dict[str, Any]) -> str:
    signal = str(port.get("signal_type") or "").casefold()
    direction = str(port.get("direction") or "").casefold()
    if signal == "power":
        return "top"
    if signal == "ground":
        return "bottom"
    if direction == "output":
        return "right"
    if direction == "input":
        return "left"
    return "left"


def ports_to_symbol_geometry(ports: list[dict[str, Any]]) -> dict[str, Any]:
    """Derive BLOCK-like geometry and ordered pins from module ports."""
    by_side: dict[str, list[dict[str, Any]]] = {
        "left": [],
        "right": [],
        "top": [],
        "bottom": [],
    }
    for port in ports or []:
        side = side_for_port(port)
        by_side[side].append(port)

    for side in by_side:
        by_side[side].sort(key=lambda item: (str(item.get("name") or "").casefold(), str(item.get("id") or "")))

    pins: list[dict[str, Any]] = []
    for side in ("left", "right", "top", "bottom"):
        for index, port in enumerate(by_side[side]):
            port_id = str(port.get("id") or f"p{len(pins) + 1}")
            pins.append({
                "id": port_id,
                "name": str(port.get("name") or port_id),
                "net": str(port.get("net") or f"n_{port_id}"),
                "net_id": str(port.get("net_id") or "") or None,
                "side": side,
                "order": index,
            })

    max_vertical = max(len(by_side["left"]), len(by_side["right"]), 1)
    max_horizontal = max(len(by_side["top"]), len(by_side["bottom"]), 1)
    width = max(80.0, 40.0 + max_horizontal * 24.0)
    height = max(80.0, 40.0 + max_vertical * 24.0)
    return {
        "pins": [{k: v for k, v in pin.items() if v is not None} for pin in pins],
        "block": {"width": width, "height": height},
    }


def sync_instance_pins_from_ports(
    instance: dict[str, Any],
    child_ports: list[dict[str, Any]],
) -> dict[str, Any]:
    """Resync MODULE pins from child ports; preserve nets for matching port ids."""
    geometry = ports_to_symbol_geometry(child_ports)
    previous = {
        str(pin.get("id") or ""): pin
        for pin in instance.get("pins", []) or []
    }
    pins: list[dict[str, Any]] = []
    missing_previous: list[str] = []
    for pin in geometry["pins"]:
        pin_id = str(pin["id"])
        old = previous.get(pin_id)
        merged = {**pin}
        if old:
            if old.get("net"):
                merged["net"] = str(old["net"])
            if old.get("net_id"):
                merged["net_id"] = str(old["net_id"])
        pins.append(merged)
    for pin_id in previous:
        if pin_id and pin_id not in {str(pin.get("id")) for pin in pins}:
            missing_previous.append(pin_id)
    next_instance = {
        **instance,
        "pins": pins,
        "block": geometry["block"],
    }
    if missing_previous:
        diagnostics = list(next_instance.get("diagnostics") or [])
        diagnostics.append({
            "code": "module_instance_missing_ports",
            "message": f"child ports removed for pins: {', '.join(missing_previous)}",
            "pin_ids": missing_previous,
        })
        next_instance["diagnostics"] = diagnostics
    return next_instance


def make_module_instance(
    *,
    component_id: str,
    name: str,
    child_module_id: str,
    child_ports: list[dict[str, Any]],
    position: dict[str, float],
    parameters: dict[str, str] | None = None,
    revision: int | None = None,
    stable_id: str | None = None,
) -> dict[str, Any]:
    geometry = ports_to_symbol_geometry(child_ports)
    module_ref: dict[str, Any] = {"module_id": child_module_id}
    if revision is not None:
        module_ref["revision"] = int(revision)
    instance = {
        "id": component_id,
        "type": "MODULE",
        "name": name,
        "value": child_module_id,
        "position": position,
        "rotation": 0,
        "pins": geometry["pins"],
        "block": geometry["block"],
        "module_ref": module_ref,
        "parameters": dict(parameters or {}),
    }
    if stable_id:
        instance["stable_id"] = stable_id
    return instance


def module_instance_edges(modules: dict[str, dict[str, Any]]) -> dict[str, list[str]]:
    edges: dict[str, list[str]] = {module_id: [] for module_id in modules}
    for module_id, module in modules.items():
        children: list[str] = []
        for component in module.get("components", []) or []:
            if str(component.get("type") or "").upper() != "MODULE":
                continue
            ref = component.get("module_ref") or {}
            child_id = str(ref.get("module_id") or "").strip()
            if child_id:
                children.append(child_id)
        edges[module_id] = children
    return edges


def detect_module_cycles(
    modules: dict[str, dict[str, Any]],
    *,
    start_module_id: str | None = None,
) -> list[str]:
    """Return a cycle path if present, else []."""
    edges = module_instance_edges(modules)
    roots = [start_module_id] if start_module_id else list(edges)
    visiting: set[str] = set()
    visited: set[str] = set()
    stack: list[str] = []

    def dfs(node: str) -> list[str] | None:
        if node in visiting:
            if node in stack:
                idx = stack.index(node)
                return stack[idx:] + [node]
            return [node, node]
        if node in visited:
            return None
        visiting.add(node)
        stack.append(node)
        for child in edges.get(node, []):
            if child not in edges and child not in modules:
                continue
            found = dfs(child)
            if found:
                return found
        stack.pop()
        visiting.remove(node)
        visited.add(node)
        return None

    for root in roots:
        if not root:
            continue
        found = dfs(root)
        if found:
            return found
    return []


def safe_format_interpolate(template: str, values: dict[str, str]) -> str:
    """Interpolate {name} placeholders only. Reject unsafe tokens/scripts."""
    text = str(template or "")
    if any(token in text for token in (";", "`", "$(", "${", "exec", "eval", "tcl")):
        raise ValueError("netlist format template contains unsafe content")

    def replacer(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in values:
            raise ValueError(f"netlist format missing placeholder value: {key}")
        value = str(values[key])
        if not value or not SAFE_TOKEN_RE.match(value):
            raise ValueError(f"netlist format value is not a safe token: {key}={value!r}")
        return value

    return PLACEHOLDER_RE.sub(replacer, text)


def resolve_instance_parameters(
    child_module: dict[str, Any],
    instance: dict[str, Any],
    *,
    unknown_policy: str = "error",
) -> dict[str, str]:
    defs = {
        str(item.get("id") or "").strip(): str(item.get("default") or "")
        for item in child_module.get("parameter_defs", []) or []
        if str(item.get("id") or "").strip()
    }
    overrides = {
        str(key): str(value)
        for key, value in (instance.get("parameters") or {}).items()
        if str(key).strip()
    }
    unknown = [key for key in overrides if key not in defs and defs]
    if unknown and unknown_policy == "error":
        raise ValueError(f"unknown MODULE instance parameters: {', '.join(sorted(unknown))}")
    merged = {**defs, **overrides}
    return {key: value for key, value in merged.items() if value != ""}


def emit_parameter_suffix(parameters: dict[str, str]) -> str:
    if not parameters:
        return ""
    parts = []
    for key in sorted(parameters):
        value = parameters[key]
        if not SAFE_TOKEN_RE.match(key) or not SAFE_TOKEN_RE.match(value):
            raise ValueError(f"unsafe parameter token: {key}={value}")
        parts.append(f"{key}={value}")
    return " " + " ".join(parts)


def spice_name_for_subckt(module_id: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_]+", "_", str(module_id or "module")).strip("_")
    if not cleaned:
        cleaned = "module"
    if cleaned[0].isdigit():
        cleaned = f"m_{cleaned}"
    return cleaned


def emit_x_instance_line(
    instance: dict[str, Any],
    child_module: dict[str, Any],
    *,
    node_for_pin: dict[str, str] | None = None,
    unknown_policy: str = "error",
) -> str:
    child_id = spice_name_for_subckt(str((instance.get("module_ref") or {}).get("module_id") or ""))
    ports = child_module.get("ports", []) or []
    nodes: list[str] = []
    pin_lookup = {
        str(pin.get("id") or ""): pin
        for pin in instance.get("pins", []) or []
    }
    for port in ports:
        port_id = str(port.get("id") or "")
        pin = pin_lookup.get(port_id)
        if node_for_pin and port_id in node_for_pin:
            nodes.append(node_for_pin[port_id])
        elif pin:
            nodes.append(str(pin.get("net") or "0"))
        else:
            nodes.append(str(port.get("net") or "0"))
    params = resolve_instance_parameters(child_module, instance, unknown_policy=unknown_policy)
    name = str(instance.get("name") or instance.get("id") or "X1")
    if not name.upper().startswith("X"):
        name = f"X{name}"
    return f"{name} {' '.join(nodes)} {child_id}{emit_parameter_suffix(params)}".strip()


def connectivity_payload(module: dict[str, Any], *, diagnostics: list[str] | None = None) -> dict[str, Any]:
    snapshot = ordered_connectivity_snapshot(module)
    return {
        "schema": "actoviq.module-connectivity.v1",
        "module_id": str(module.get("module_id") or ""),
        "hash": _canonical_hash(snapshot),
        "ordered_bindings": snapshot,
        "diagnostics": list(diagnostics or []),
    }


def compare_ordered_pin_nets(
    expected_by_instance: dict[str, list[str]],
    actual_by_instance: dict[str, list[str]],
) -> dict[str, Any]:
    """Order-sensitive connectivity comparison for reference netlists."""
    diagnostics: list[str] = []
    compared = 0
    for name, expected in expected_by_instance.items():
        actual = actual_by_instance.get(name.casefold()) or actual_by_instance.get(name)
        if actual is None:
            # try case-insensitive key map
            folded = {key.casefold(): value for key, value in actual_by_instance.items()}
            actual = folded.get(name.casefold())
        if actual is None:
            diagnostics.append(f"reference netlist is missing instance {name}")
            continue
        compared += 1
        expected_nodes = [str(item).casefold() for item in expected]
        actual_nodes = [str(item).casefold() for item in actual[: len(expected_nodes)]]
        if actual_nodes != expected_nodes:
            diagnostics.append(
                f"{name} connectivity differs: expected {expected_nodes}, reference has {actual_nodes}"
            )
    return {
        "ok": not diagnostics,
        "compared_instance_count": compared,
        "diagnostics": diagnostics,
    }
