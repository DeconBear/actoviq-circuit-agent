#!/usr/bin/env python3
"""Semantic layout planner for netlistsvg schematics.

The planner does not draw SVG or change connectivity. It annotates the
netlistsvg design JSON with profile metadata and ELK hints so netlistsvg remains
the canonical port/edge renderer.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def component_nodes(component: dict[str, Any]) -> list[str]:
    return [str(node) for node in component.get("schematic_nodes") or component.get("nodes") or []]


def node_set(component: dict[str, Any]) -> set[str]:
    return {node.lower() for node in component_nodes(component)}


def is_ground(node: str) -> bool:
    lower = node.lower()
    return lower in {"0", "gnd", "agnd", "dgnd", "pgnd"} or lower.endswith("gnd")


def is_power(node: str) -> bool:
    lower = node.lower()
    return lower.startswith(("vin", "vcc", "vdd", "vbat", "vsup")) or lower.endswith(("_vcc", "_vdd"))


def interface_nodes(payload: dict[str, Any]) -> tuple[str, str]:
    interfaces = payload.get("interfaces", {}) if isinstance(payload.get("interfaces"), dict) else {}
    io = payload.get("io_inference", {}) if isinstance(payload.get("io_inference"), dict) else {}
    return (
        str(interfaces.get("input_node") or io.get("input_node") or ""),
        str(interfaces.get("output_node") or io.get("output_node") or ""),
    )


def detect_ldo(payload: dict[str, Any]) -> dict[str, Any] | None:
    components = [comp for comp in payload.get("components", []) if isinstance(comp, dict)]
    input_node, output_node = interface_nodes(payload)
    input_lower = input_node.lower()
    output_lower = output_node.lower()
    if not output_lower:
        return None

    pass_device: dict[str, Any] | None = None
    for comp in components:
        if str(comp.get("type") or "").lower() != "mosfet":
            continue
        nodes = component_nodes(comp)
        if len(nodes) < 4:
            continue
        drain, gate, source, bulk = [node.lower() for node in nodes[:4]]
        source_is_supply = source == input_lower or is_power(source)
        if drain == output_lower and source_is_supply and bulk == source:
            pass_device = comp
            break
    if pass_device is None:
        return None

    gate_node = component_nodes(pass_device)[1]
    feedback_nodes = {
        node
        for comp in components
        if str(comp.get("type") or "").lower() == "resistor"
        for node in component_nodes(comp)
        if node.lower() not in {output_lower, input_lower} and not is_ground(node)
    }
    has_feedback = any(output_lower in node_set(comp) and node.lower() in node_set(comp)
                       for node in feedback_nodes for comp in components)
    if not has_feedback and "fb" not in {node.lower() for node in feedback_nodes}:
        return None

    return {
        "profile": "ldo_regulator",
        "pass_device": str(pass_device.get("name") or ""),
        "gate_nodes": [gate_node],
        "feedback_nodes": sorted(feedback_nodes),
    }


def cell_for_component(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    modules = payload.get("modules", {}) if isinstance(payload.get("modules"), dict) else {}
    module = next(iter(modules.values()), {}) if modules else {}
    cells = module.get("cells", {}) if isinstance(module, dict) else {}
    return cells if isinstance(cells, dict) else {}


def add_cell_hint(cells: dict[str, dict[str, Any]], name: str, x: float, y: float, role: str) -> bool:
    cell = cells.get(name)
    if not isinstance(cell, dict):
        return False
    attrs = cell.setdefault("attributes", {})
    if not isinstance(attrs, dict):
        attrs = {}
        cell["attributes"] = attrs
    attrs["org.eclipse.elk.x"] = x
    attrs["org.eclipse.elk.y"] = y
    attrs["org.eclipse.elk.layered.priority.direction"] = 100
    attrs["actoviq.schematic.role"] = role
    return True


def apply_ldo_hints(payload: dict[str, Any], detection: dict[str, Any]) -> dict[str, Any]:
    components = [comp for comp in payload.get("components", []) if isinstance(comp, dict)]
    cells = cell_for_component(payload)
    input_node, output_node = interface_nodes(payload)
    gate_nodes = {str(node).lower() for node in detection.get("gate_nodes", [])}
    placed = 0

    for comp in components:
        name = str(comp.get("name") or "")
        lower = name.lower()
        ctype = str(comp.get("type") or "").lower()
        nodes = node_set(comp)
        x_y_role: tuple[float, float, str] | None = None
        if name == detection.get("pass_device"):
            x_y_role = (430.0, 130.0, "ldo.pass_device")
        elif ctype == "mosfet" and {"fb", "vref"} & nodes:
            x_y_role = (250.0, 185.0, "ldo.error_amplifier")
        elif ctype == "mosfet" and gate_nodes & nodes:
            x_y_role = (300.0, 130.0, "ldo.error_load")
        elif lower.startswith(("rtop", "rfb1")) or (output_node.lower() in nodes and "fb" in nodes):
            x_y_role = (570.0, 230.0, "ldo.feedback_top")
        elif lower.startswith(("rbot", "rfb2")) or ("fb" in nodes and any(is_ground(node) for node in nodes)):
            x_y_role = (570.0, 315.0, "ldo.feedback_bottom")
        elif output_node.lower() in nodes and any(is_ground(node) for node in nodes) and ctype == "capacitor":
            x_y_role = (690.0, 315.0, "ldo.output_cap")
        elif output_node.lower() in nodes and any(is_ground(node) for node in nodes):
            x_y_role = (760.0, 315.0, "ldo.output_load")
        elif input_node.lower() in nodes and ctype.endswith("source"):
            x_y_role = (55.0, 185.0, "ldo.input_source")
        if x_y_role and add_cell_hint(cells, name, *x_y_role):
            placed += 1

    for name, cell in cells.items():
        if not isinstance(cell, dict):
            continue
        ctype = str(cell.get("type") or "")
        if ctype == "vcc" and add_cell_hint(cells, str(name), 250.0, 30.0, "rail.power"):
            placed += 1
        elif ctype == "gnd" and add_cell_hint(cells, str(name), 430.0, 430.0, "rail.ground"):
            placed += 1
        elif ctype == "$_outputExt_" and add_cell_hint(cells, str(name), 830.0, 215.0, "terminal.output"):
            placed += 1

    return {"profile": "ldo_regulator", "placed": placed}


def plan_payload(payload: dict[str, Any]) -> dict[str, Any]:
    intent = payload.setdefault("schematic_intent", {})
    if not isinstance(intent, dict):
        intent = {}
        payload["schematic_intent"] = intent

    report: dict[str, Any] = {"updated": False, "profile": intent.get("profile") or "generic", "passes": []}
    ldo = detect_ldo(payload)
    if ldo:
        intent["profile"] = "ldo_regulator"
        aliases = intent.setdefault("net_aliases", {})
        if isinstance(aliases, dict):
            aliases["ldo_gate"] = ldo["gate_nodes"]
            aliases["feedback"] = ldo["feedback_nodes"]
        hint_report = apply_ldo_hints(payload, ldo)
        report.update({"updated": True, "profile": "ldo_regulator"})
        report["passes"].append({"name": "ldo", **ldo, **hint_report})

    intent["analog_planner"] = report
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Annotate netlistsvg design JSON with analog schematic layout hints")
    parser.add_argument("--json-path", required=True)
    parser.add_argument("--out-json-path", default="")
    args = parser.parse_args()

    json_path = Path(args.json_path).resolve()
    out_path = Path(args.out_json_path).resolve() if args.out_json_path else json_path
    payload = json.loads(json_path.read_text(encoding="utf-8-sig"))
    report = plan_payload(payload)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "json_path": str(out_path), "planner": report}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
