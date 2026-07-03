#!/usr/bin/env python3
"""Render an SVG diagram by calling netlistsvg CLI."""

from __future__ import annotations

import argparse
import copy
import html
import json
import os
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

from check_svg_geometry import check_geometry
from schematic_planner import plan_payload

SVG_NS = "http://www.w3.org/2000/svg"
NETLISTSVG_NS = "https://github.com/nturley/netlistsvg"
TRANSLATE_RE = re.compile(r"translate\(\s*([-+]?\d*\.?\d+)\s*,\s*([-+]?\d*\.?\d+)\s*\)")


def local_name(name: str) -> str:
    return name.rsplit("}", 1)[-1]


def get_attr(elem: ET.Element, name: str) -> str | None:
    for key, value in elem.attrib.items():
        if local_name(key) == name:
            return value
    return None


def parse_float(text: str | None, default: float = 0.0) -> float:
    if text is None:
        return default
    try:
        return float(text)
    except ValueError:
        return default


def parse_translate(transform: str | None) -> tuple[float, float] | None:
    if not transform:
        return None
    match = TRANSLATE_RE.search(transform)
    if not match:
        return None
    return float(match.group(1)), float(match.group(2))


def format_num(value: float) -> str:
    rounded = round(value, 3)
    if abs(rounded - round(rounded)) < 1e-9:
        return str(int(round(rounded)))
    return f"{rounded:.3f}".rstrip("0").rstrip(".")


def nearly_equal(a: float, b: float, tol: float = 1e-6) -> bool:
    return abs(a - b) <= tol


def ns_attr(namespace: str, name: str) -> str:
    return f"{{{namespace}}}{name}"


def class_token(elem: ET.Element, prefix: str) -> str | None:
    classes = str(elem.get("class") or "").split()
    for token in classes:
        if token.startswith(prefix):
            return token
    return None


def find_terminal_anchor(group: ET.Element) -> tuple[float, float] | None:
    transform = parse_translate(group.get("transform"))
    if transform is None:
        return None
    tx, ty = transform
    for child in group:
        if local_name(child.tag) != "g":
            continue
        if get_attr(child, "pid") is None:
            continue
        px = parse_float(get_attr(child, "x"))
        py = parse_float(get_attr(child, "y"))
        return tx + px, ty + py
    return None


def move_terminal_and_edges(root: ET.Element, group: ET.Element, new_x: float) -> bool:
    transform = parse_translate(group.get("transform"))
    old_anchor = find_terminal_anchor(group)
    if transform is None or old_anchor is None:
        return False

    old_x, old_y = transform
    if nearly_equal(old_x, new_x):
        return False

    _, ty = transform
    group.set("transform", f"translate({format_num(new_x)},{format_num(ty)})")
    new_anchor = find_terminal_anchor(group)
    if new_anchor is None:
        return False

    old_ax, old_ay = old_anchor
    new_ax, new_ay = new_anchor
    additions: list[ET.Element] = []
    for elem in root.iter():
        if local_name(elem.tag) != "line":
            continue
        x1 = parse_float(elem.get("x1"))
        y1 = parse_float(elem.get("y1"))
        x2 = parse_float(elem.get("x2"))
        y2 = parse_float(elem.get("y2"))
        if nearly_equal(x1, old_ax) and nearly_equal(y1, old_ay):
            if nearly_equal(new_ay, y2) or nearly_equal(new_ax, x2):
                elem.set("x1", format_num(new_ax))
                elem.set("y1", format_num(new_ay))
            else:
                elem.set("x1", format_num(new_ax))
                elem.set("y1", format_num(new_ay))
                elem.set("x2", format_num(x2))
                elem.set("y2", format_num(new_ay))
                attrs = dict(elem.attrib)
                attrs["x1"] = format_num(x2)
                attrs["y1"] = format_num(new_ay)
                attrs["x2"] = format_num(x2)
                attrs["y2"] = format_num(y2)
                additions.append(ET.Element(elem.tag, attrs))
        if nearly_equal(x2, old_ax) and nearly_equal(y2, old_ay):
            if nearly_equal(new_ay, y1) or nearly_equal(new_ax, x1):
                elem.set("x2", format_num(new_ax))
                elem.set("y2", format_num(new_ay))
            else:
                elem.set("x1", format_num(x1))
                elem.set("y1", format_num(y1))
                elem.set("x2", format_num(new_ax))
                elem.set("y2", format_num(y1))
                attrs = dict(elem.attrib)
                attrs["x1"] = format_num(new_ax)
                attrs["y1"] = format_num(y1)
                attrs["x2"] = format_num(new_ax)
                attrs["y2"] = format_num(new_ay)
                additions.append(ET.Element(elem.tag, attrs))
    for elem in additions:
        root.append(elem)
    return True


def load_symbol_metadata(json_path: Path) -> tuple[dict[str, dict[str, object]], str]:
    payload = json.loads(json_path.read_text(encoding="utf-8-sig"))
    component_meta = {str(comp.get("name")): comp for comp in payload.get("components", [])}
    output_node = str(payload.get("interfaces", {}).get("output_node") or payload.get("io_inference", {}).get("output_node") or "")
    metadata: dict[str, dict[str, object]] = {}
    for module in payload.get("modules", {}).values():
        for cell_name, cell in module.get("cells", {}).items():
            attributes = cell.get("attributes", {})
            component = component_meta.get(cell_name, {})
            schematic_nodes = component.get("schematic_nodes") or component.get("nodes") or []
            first_node = str(schematic_nodes[0]) if schematic_nodes else ""
            metadata[str(cell_name)] = {
                "symbol_hint": str(attributes.get("symbol_hint") or ""),
                "active_low": bool(first_node.lower().endswith("_n")),
            }
    return metadata, output_node


def replace_generic_with_symbolic_shape(
    group: ET.Element,
    *,
    ref_label: str,
    comparator: bool,
    active_low: bool,
) -> bool:
    rects = [child for child in list(group) if local_name(child.tag) == "rect" and get_attr(child, "generic") == "body"]
    if not rects:
        return False

    cell_id = group.get("id", "")
    group.set(ns_attr(NETLISTSVG_NS, "type"), "opamp")
    group.set(ns_attr(NETLISTSVG_NS, "width"), "30")
    group.set(ns_attr(NETLISTSVG_NS, "height"), "60")
    for child in list(group):
        if local_name(child.tag) == "text" and get_attr(child, "attribute") == "ref":
            child.text = ref_label

    rect = rects[0]
    rect_index = list(group).index(rect)
    group.remove(rect)

    base_attrs = {"class": f"symbol {cell_id}"}
    detail_attrs = {"class": f"detail {cell_id}"}
    elements: list[ET.Element] = [
        ET.Element(f"{{{SVG_NS}}}path", {**base_attrs, "d": "M4,4 V56 L24,30 Z"}),
        ET.Element(
            f"{{{SVG_NS}}}path",
            {**base_attrs, "d": "M0,10 H4 M0,50 H4 M24,30 H30"},
        ),
        ET.Element(f"{{{SVG_NS}}}path", {**detail_attrs, "d": "m8,10 6,0"}),
        ET.Element(f"{{{SVG_NS}}}path", {**detail_attrs, "d": "m8,50 6,0 m-3,-3 0,6"}),
    ]
    if comparator:
        elements.append(
            ET.Element(
                f"{{{SVG_NS}}}text",
                {"x": "14", "y": "36", "class": f"nodelabel {cell_id}"},
            )
        )
        elements[-1].text = "CMP"
    if active_low:
        elements.append(
            ET.Element(
                f"{{{SVG_NS}}}circle",
                {"cx": "27", "cy": "30", "r": "3.5", "class": f"symbol {cell_id}"},
            )
        )

    for offset, element in enumerate(elements):
        group.insert(rect_index + offset, element)
    return True


def enhance_symbolic_cells(svg_path: Path, json_path: Path) -> dict[str, object]:
    if not svg_path.exists() or not json_path.exists():
        return {"updated": False, "reason": "missing_inputs"}

    metadata, output_node = load_symbol_metadata(json_path)
    ET.register_namespace("", SVG_NS)
    ET.register_namespace("s", NETLISTSVG_NS)
    tree = ET.parse(svg_path)
    root = tree.getroot()
    updated = False

    for elem in root.iter():
        if local_name(elem.tag) != "g":
            continue
        cell_id = elem.get("id", "")
        if cell_id == "cell_OUT" and output_node.lower().endswith("_n"):
            for child in elem:
                if local_name(child.tag) == "text" and get_attr(child, "attribute") == "ref":
                    if child.text != "OUT_N":
                        child.text = "OUT_N"
                        updated = True
            continue
        if not cell_id.startswith("cell_"):
            continue
        name = cell_id[5:]
        meta = metadata.get(name)
        if not meta:
            continue
        symbol_hint = str(meta.get("symbol_hint") or "").lower()
        if symbol_hint not in {"opamp", "comparator"}:
            continue
        updated = replace_generic_with_symbolic_shape(
            elem,
            ref_label=name,
            comparator=symbol_hint == "comparator",
            active_low=bool(meta.get("active_low")),
        ) or updated

    if updated:
        tree.write(svg_path, encoding="utf-8", xml_declaration=False)
    return {"updated": updated, "output_label": "OUT_N" if output_node.lower().endswith("_n") else "OUT"}


def component_nodes(component: dict[str, object]) -> list[str]:
    source = component.get("schematic_nodes") or component.get("nodes") or []
    return [str(node) for node in source]


def is_signal_chain_comparator_payload(payload: dict[str, object]) -> bool:
    components = payload.get("components", [])
    if not isinstance(components, list):
        return False
    hints = {str(comp.get("symbol_hint") or "").lower() for comp in components if isinstance(comp, dict)}
    nodes = {
        node.lower()
        for comp in components
        if isinstance(comp, dict)
        for node in component_nodes(comp)
    }
    return "opamp" in hints and "comparator" in hints and ("filt" in nodes or "vth" in nodes)


def is_rf_mixed_signal_payload(payload: dict[str, object]) -> bool:
    components = payload.get("components", [])
    if not isinstance(components, list):
        return False
    types = {str(comp.get("type") or "").lower() for comp in components if isinstance(comp, dict)}
    hints = {str(comp.get("symbol_hint") or "").lower() for comp in components if isinstance(comp, dict)}
    nodes = {
        node.lower()
        for comp in components
        if isinstance(comp, dict)
        for node in component_nodes(comp)
    }
    has_rf_frontend = "inductor" in types and ("mosfet" in types or "bjt" in types)
    has_detector = "diode" in types and any(node.startswith(("det", "env", "lpf", "adc")) for node in nodes)
    has_digitizer = "comparator" in hints or any(node.endswith("_n") for node in nodes)
    return has_rf_frontend and has_detector and has_digitizer


def output_node_from_payload(payload: dict[str, object]) -> str:
    interfaces = payload.get("interfaces", {}) if isinstance(payload.get("interfaces"), dict) else {}
    io = payload.get("io_inference", {}) if isinstance(payload.get("io_inference"), dict) else {}
    return str(interfaces.get("output_node") or io.get("output_node") or "")


SUPPORTED_FORMATTED_PROFILES = {
    "signal_chain_comparator",
    "rf_mixed_signal",
    "baseband_detail",
    "window_comparator_detail",
    "opamp_feedback",
    "ldo_regulator",
    "buck_converter",
    "cascode_amplifier",
    "ring_oscillator",
    "lna_common_emitter",
    "single_stage_amplifier",
    "opamp",
    "generic",
}


def schematic_profile(payload: dict[str, object]) -> str:
    intent = payload.get("schematic_intent", {})
    if isinstance(intent, dict):
        module_detail = str(intent.get("module_detail") or "").lower()
        if "baseband" in module_detail:
            return "baseband_detail"
        if "window" in module_detail or "comparator" in module_detail:
            return "window_comparator_detail"
        profile = str(intent.get("profile") or "").strip()
        if profile:
            return profile
    if is_rf_mixed_signal_payload(payload):
        return "rf_mixed_signal"
    if is_signal_chain_comparator_payload(payload):
        return "signal_chain_comparator"
    components = payload.get("components", [])
    if not isinstance(components, list):
        return "generic"
    types = {str(comp.get("type") or "").lower() for comp in components if isinstance(comp, dict)}
    hints = {str(comp.get("symbol_hint") or "").lower() for comp in components if isinstance(comp, dict)}
    names = {str(comp.get("name") or "").lower() for comp in components if isinstance(comp, dict)}
    nodes = {
        node.lower()
        for comp in components
        if isinstance(comp, dict)
        for node in component_nodes(comp)
    }
    if "mosfet" in types and sum(1 for name in names if name.startswith("m")) >= 4 and {"n1", "n2", "n3"} <= nodes:
        return "ring_oscillator"
    if "inductor" in types and "diode" in types and output_node_from_payload(payload):
        return "buck_converter"
    cascode_markers = {"nd", "no", "ns"}
    if "mosfet" in types and len([name for name in names if name.startswith("m")]) >= 2 and len(cascode_markers & nodes) >= 2:
        return "cascode_amplifier"
    if any(name.startswith(("mpass", "m_pass", "qpass", "q_pass")) for name in names) and {"fb", "gate"} & nodes:
        return "ldo_regulator"
    if "opamp" in hints and ({"vn", "fb"} & nodes or any(name.startswith(("r1f", "r2f", "rfb")) for name in names)):
        return "opamp_feedback"
    if ({"bjt", "mosfet"} & types) and {"in", "out"} & nodes:
        return "lna_common_emitter"
    if "opamp" in hints:
        return "opamp"
    return "generic"


def group_dimensions(group: ET.Element) -> tuple[float, float]:
    width = parse_float(get_attr(group, "width"), 40.0)
    height = parse_float(get_attr(group, "height"), 30.0)
    return width, height


def set_group_xy(group: ET.Element, x: float, y: float) -> None:
    group.set("transform", f"translate({format_num(x)},{format_num(y)})")


def set_group_center(group: ET.Element, cx: float, cy: float) -> None:
    width, height = group_dimensions(group)
    set_group_xy(group, cx - width / 2.0, cy - height / 2.0)


def find_cell_groups(root: ET.Element) -> dict[str, ET.Element]:
    groups: dict[str, ET.Element] = {}
    for elem in root.iter():
        if local_name(elem.tag) != "g":
            continue
        cell_id = elem.get("id", "")
        if cell_id.startswith("cell_"):
            groups[cell_id[5:]] = elem
    return groups


def has_node(component: dict[str, object], node: str) -> bool:
    return node.lower() in {item.lower() for item in component_nodes(component)}


def has_any_node(component: dict[str, object], *nodes: str) -> bool:
    node_set = {item.lower() for item in component_nodes(component)}
    return any(node.lower() in node_set for node in nodes)


def component_module_name(component: dict[str, object]) -> str:
    return str(component.get("module_name") or component.get("module") or "").strip().lower()


def nonrail_nodes(component: dict[str, object]) -> list[str]:
    return [node for node in component_nodes(component) if rail_symbol_for_format(node) is None]


def component_rail_kinds(component: dict[str, object]) -> set[str]:
    return {
        rail
        for rail in (rail_symbol_for_format(node) for node in component_nodes(component))
        if rail is not None
    }


def layout_node_rank(node: str, input_node: str, output_node: str) -> int:
    lower = node.strip().lower()
    if input_node and lower == input_node.lower():
        return 0
    if output_node and lower == output_node.lower():
        return 1000
    exact = {
        "src": -20,
        "in": 0,
        "rf_in": 0,
        "match": 100,
        "match_out": 140,
        "rf_b": 180,
        "gate": 180,
        "vgate": 180,
        "rf_c": 320,
        "drain": 320,
        "collector": 320,
        "rf_out": 380,
        "rf_amp": 380,
        "rf_amp_out": 380,
        "det_in": 430,
        "det": 500,
        "env": 500,
        "det_out": 520,
        "bb_b1": 600,
        "bb_b2": 620,
        "bb_sk1": 700,
        "bb_sk2": 760,
        "bb_out": 820,
        "filter_out": 850,
        "alarm_n": 1000,
        "out": 1000,
        "output": 1000,
    }
    if lower in exact:
        return exact[lower]
    if lower.startswith(("src", "in", "rf_in")):
        return 0
    if lower.startswith(("match", "rf_b", "gate", "base")):
        return 150
    if lower.startswith(("rf_c", "rf_out", "rf_amp", "collector", "drain")):
        return 360
    if lower.startswith(("det", "env")):
        return 520
    if lower.startswith(("bb_", "op_", "amp", "filt", "lpf")):
        return 720
    if lower.startswith(("comp_", "cmp", "alarm")) or lower.endswith("_n") or "out" in lower:
        return 900
    return 500


def module_label(name: str) -> str:
    cleaned = name.replace("_", " ").replace("-", " ").strip().upper()
    aliases = {
        "RF FRONTEND": "RF FRONTEND",
        "INPUT MATCHING NETWORK": "RF INPUT/MATCH",
        "ENVELOPE DETECTOR": "DETECTOR",
        "BASEBAND CONDITIONING": "BASEBAND",
        "WINDOW COMPARATOR": "WINDOW CMP",
    }
    return aliases.get(cleaned, cleaned or "MODULE")


def collect_module_blocks(payload: dict[str, object]) -> list[dict[str, object]]:
    components = payload.get("components", [])
    if not isinstance(components, list):
        return []

    payload_blocks = payload.get("schematic_blocks", [])
    blocks: list[dict[str, object]] = []
    if isinstance(payload_blocks, list):
        for item in payload_blocks:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip().lower()
            if not name or name == "global":
                continue
            blocks.append(
                {
                    "name": name,
                    "label": str(item.get("label") or module_label(name)),
                    "order": int(item.get("order") or 999),
                    "component_names": item.get("component_names", []),
                    "nodes": item.get("nodes", []),
                }
            )

    if not blocks:
        seen: dict[str, int] = {}
        for comp in components:
            if not isinstance(comp, dict):
                continue
            name = component_module_name(comp)
            if not name or name == "global":
                continue
            order = int(comp.get("module_order") or 999)
            seen[name] = min(order, seen.get(name, order))
        blocks = [
            {"name": name, "label": module_label(name), "order": order}
            for name, order in seen.items()
        ]

    blocks = sorted(blocks, key=lambda item: (int(item["order"]), str(item["name"])))
    if len(blocks) < 2:
        return []

    counts: dict[str, int] = defaultdict(int)
    for comp in components:
        if isinstance(comp, dict):
            counts[component_module_name(comp)] += 1

    x = 20.0
    for block in blocks:
        name = str(block["name"])
        count = counts.get(name, 1)
        if "baseband" in name:
            width = 580.0
        elif "comparator" in name or "window" in name:
            width = 430.0
        elif "frontend" in name or "matching" in name or name.startswith("rf"):
            width = 380.0
        elif "detector" in name:
            width = 300.0
        else:
            width = max(230.0, min(390.0, 120.0 + count * 28.0))
        block.update({"x": x, "y": 70.0, "w": width, "h": 360.0})
        x += width + 28.0
    return blocks


def evenly_spaced_slots(count: int, left: float, right: float) -> list[float]:
    if count <= 0:
        return []
    if count == 1:
        return [(left + right) / 2.0]
    step = (right - left) / float(count - 1)
    return [left + step * index for index in range(count)]


def node_positions_for_block(
    module_components: list[dict[str, object]],
    block: dict[str, object],
    input_node: str,
    output_node: str,
) -> dict[str, float]:
    x = float(block["x"])
    w = float(block["w"])
    first_seen: dict[str, int] = {}
    for comp in module_components:
        line_no = int(comp.get("line_no") or 999999)
        for node in nonrail_nodes(comp):
            first_seen[node] = min(line_no, first_seen.get(node, line_no))
    ordered = sorted(
        first_seen,
        key=lambda node: (layout_node_rank(node, input_node, output_node), first_seen[node], node),
    )
    slots = evenly_spaced_slots(len(ordered), x + 36.0, x + w - 36.0)
    positions = {node: slots[index] for index, node in enumerate(ordered)}
    for node in ordered:
        lower = node.lower()
        if input_node and lower == input_node.lower():
            positions[node] = x + 26.0
        elif output_node and lower == output_node.lower():
            positions[node] = x + w - 26.0
    return positions


def preferred_component_x(component: dict[str, object], node_x: dict[str, float], fallback_x: float) -> float:
    xs = [node_x[node] for node in nonrail_nodes(component) if node in node_x]
    if not xs:
        return fallback_x
    return sum(xs) / len(xs)


def reserve_lane_x(cx: float, occupied: list[float], left: float, right: float, min_gap: float = 58.0) -> float:
    candidate = max(left, min(right, cx))
    if all(abs(candidate - other) >= min_gap for other in occupied):
        occupied.append(candidate)
        return candidate

    for step in range(1, 10):
        for direction in (1, -1):
            shifted = candidate + direction * step * min_gap
            if shifted < left or shifted > right:
                continue
            if all(abs(shifted - other) >= min_gap for other in occupied):
                occupied.append(shifted)
                return shifted
    occupied.append(candidate)
    return candidate


def place_module_components(
    root: ET.Element,
    payload: dict[str, object],
    block: dict[str, object],
    module_components: list[dict[str, object]],
) -> int:
    groups = find_cell_groups(root)
    interfaces = payload.get("interfaces", {}) if isinstance(payload.get("interfaces"), dict) else {}
    io = payload.get("io_inference", {}) if isinstance(payload.get("io_inference"), dict) else {}
    input_node = str(interfaces.get("input_node") or io.get("input_node") or "")
    output_node = str(interfaces.get("output_node") or io.get("output_node") or "")

    x = float(block["x"])
    y = float(block["y"])
    w = float(block["w"])
    signal_y = y + 148.0
    top_y = y + 62.0
    bottom_y = y + 260.0
    node_x = node_positions_for_block(module_components, block, input_node, output_node)

    active_components = [
        comp
        for comp in module_components
        if component_type(comp) in {"bjt", "mosfet"} or str(comp.get("symbol_hint") or "").lower() in {"opamp", "comparator"}
    ]
    active_slots = evenly_spaced_slots(len(active_components), x + w * 0.35, x + w * 0.75)
    active_index = 0
    top_index = 0
    bottom_index = 0
    series_index = 0
    misc_index = 0
    top_occupied: list[float] = []
    bottom_occupied: list[float] = []
    series_occupied: list[float] = []
    placed = 0

    for component in sorted(module_components, key=lambda comp: int(comp.get("line_no") or 999999)):
        name = str(component.get("name") or "")
        group = groups.get(name)
        if group is None:
            continue
        lower_name = name.lower()
        ctype = component_type(component)
        rails = component_rail_kinds(component)
        nonrails = nonrail_nodes(component)
        fallback_x = x + 52.0 + (misc_index % 5) * 44.0
        cx = preferred_component_x(component, node_x, fallback_x)
        cy = signal_y
        module_name = component_module_name(component)
        module_has_active = bool(active_components)

        if ctype in {"bjt", "mosfet"} or str(component.get("symbol_hint") or "").lower() in {"opamp", "comparator"}:
            cx = active_slots[min(active_index, len(active_slots) - 1)] if active_slots else x + w / 2.0
            cy = signal_y
            if "comparator" in module_name or "window" in module_name:
                cy = signal_y + (active_index % 2) * 44.0
            active_index += 1
        elif lower_name.startswith(("rload", "rl")) and output_node and any(node.lower() == output_node.lower() for node in nonrails):
            cx = x + w - 36.0
            cy = bottom_y
            bottom_occupied.append(cx)
        elif lower_name.startswith(("rdiv", "rth")):
            cx = reserve_lane_x(preferred_component_x(component, node_x, x + 55.0 + top_index * 58.0), top_occupied, x + 42.0, x + w - 42.0)
            cy = top_y + 20.0 + (top_index % 2) * 48.0
            top_index += 1
        elif lower_name.startswith(("rref", "vref")) and len(nonrails) >= 2:
            cx = reserve_lane_x(preferred_component_x(component, node_x, x + 55.0 + bottom_index * 58.0), bottom_occupied, x + 42.0, x + w - 42.0)
            cy = bottom_y - 40.0
            bottom_index += 1
        elif rails == {"vcc"} or ("vcc" in rails and nonrails):
            if lower_name in {"r1", "r2"} and ("comparator" in module_name or "window" in module_name):
                cx = x + w * (0.70 if lower_name == "r1" else 0.84)
                top_occupied.append(cx)
            else:
                cx = reserve_lane_x(preferred_component_x(component, node_x, x + 55.0 + top_index * 58.0), top_occupied, x + 42.0, x + w - 42.0)
            cy = top_y
            top_index += 1
        elif rails == {"vee"} or ("vee" in rails and nonrails):
            cx = reserve_lane_x(preferred_component_x(component, node_x, x + 55.0 + bottom_index * 58.0), bottom_occupied, x + 42.0, x + w - 42.0)
            cy = bottom_y + 40.0
            bottom_index += 1
        elif "gnd" in rails:
            cx = reserve_lane_x(preferred_component_x(component, node_x, x + 55.0 + bottom_index * 58.0), bottom_occupied, x + 42.0, x + w - 42.0)
            cy = bottom_y
            bottom_index += 1
        elif lower_name.startswith(("rf", "rfeedback", "rfb")) and len(nonrails) >= 2:
            cx = reserve_lane_x(preferred_component_x(component, node_x, x + w / 2.0), top_occupied, x + 42.0, x + w - 42.0)
            cy = top_y
            top_index += 1
        elif ctype == "diode":
            cx = reserve_lane_x(preferred_component_x(component, node_x, x + 70.0 + series_index * 68.0), series_occupied, x + 42.0, x + w - 42.0, 68.0)
            cy = signal_y
            series_index += 1
        elif len(nonrails) >= 2:
            cx = reserve_lane_x(preferred_component_x(component, node_x, x + 60.0 + series_index * 68.0), series_occupied, x + 42.0, x + w - 42.0, 68.0)
            shift_passive_lane = module_has_active and (
                "baseband" in module_name or "comparator" in module_name or "window" in module_name
            )
            cy = signal_y + (52.0 if shift_passive_lane and ctype in {"resistor", "capacitor", "inductor"} else 0.0)
            series_index += 1
        else:
            misc_index += 1

        cx = max(x + 28.0, min(x + w - 28.0, cx))
        set_group_center(group, cx, cy)
        placed += 1

    return placed


def apply_blockwise_module_placements(root: ET.Element, payload: dict[str, object]) -> dict[str, object]:
    blocks = collect_module_blocks(payload)
    if not blocks:
        return {"updated": False, "reason": "no_module_blocks"}

    components = payload.get("components", [])
    if not isinstance(components, list):
        return {"updated": False, "reason": "missing_components"}

    components_by_module: dict[str, list[dict[str, object]]] = defaultdict(list)
    for comp in components:
        if not isinstance(comp, dict):
            continue
        module_name = component_module_name(comp)
        if not module_name or module_name == "global":
            continue
        components_by_module[module_name].append(comp)

    placed = 0
    for block in blocks:
        placed += place_module_components(root, payload, block, components_by_module.get(str(block["name"]), []))

    groups = find_cell_groups(root)
    if "IN" in groups and blocks:
        set_group_center(groups["IN"], float(blocks[0]["x"]) - 18.0, float(blocks[0]["y"]) + 148.0)
    if "OUT" in groups and blocks:
        last = blocks[-1]
        set_group_center(groups["OUT"], float(last["x"]) + float(last["w"]) + 28.0, float(last["y"]) + 148.0)

    return {"updated": placed > 0, "placed": placed, "blocks": blocks}



def placement_for_signal_chain_component(component: dict[str, object], input_node: str, output_node: str) -> tuple[float, float] | None:
    name = str(component.get("name") or "").lower()
    hint = str(component.get("symbol_hint") or "").lower()
    nodes = component_nodes(component)
    has_ground = any(rail_symbol_for_format(node) == "gnd" for node in nodes)
    has_power = any(rail_symbol_for_format(node) == "vcc" for node in nodes)

    if hint == "opamp":
        return 188.0, 170.0
    if hint == "comparator":
        return 480.0, 170.0
    if name.startswith("rin") or (has_node(component, input_node) and has_any_node(component, "vp", "inp", "vinp")):
        return 84.0, 195.0
    if name.startswith("rfb_top") or (has_any_node(component, "op_out", "opout") and has_any_node(component, "vn", "inn", "vinn")):
        return 188.0, 105.0
    if name.startswith("rfb_bot") or (has_any_node(component, "vn", "inn", "vinn") and has_ground):
        return 40.0, 250.0
    if name.startswith("rop") or (has_any_node(component, "op_raw") and has_any_node(component, "op_out", "opout")):
        return 300.0, 185.0
    if name.startswith("cop") or (has_any_node(component, "op_out", "opout") and has_ground):
        return 292.0, 258.0
    if name.startswith("rlp") or (has_any_node(component, "op_out", "opout") and has_any_node(component, "filt", "flt")):
        return 382.0, 195.0
    if name.startswith("clp") or (has_any_node(component, "filt", "flt") and has_ground):
        return 417.0, 258.0
    if name.startswith("rth1") or (has_any_node(component, "vth", "ref") and has_power):
        return 570.0, 82.0
    if name.startswith("rth2") or (has_any_node(component, "vth", "ref") and has_ground):
        # Align the divider midpoint exactly with Rth1's lower pin. A small
        # vertical mismatch here creates two visually parallel vth wires.
        return 570.0, 132.0
    if has_node(component, output_node):
        return 600.0, 185.0
    return None


def placement_for_rf_mixed_component(component: dict[str, object], input_node: str, output_node: str) -> tuple[float, float] | None:
    name = str(component.get("name") or "").lower()
    hint = str(component.get("symbol_hint") or "").lower()
    comp_type = str(component.get("type") or "").lower()
    nodes = component_nodes(component)
    has_ground = any(rail_symbol_for_format(node) == "gnd" for node in nodes)
    has_power = any(rail_symbol_for_format(node) == "vcc" for node in nodes)

    if has_node(component, input_node):
        return 92.0, 210.0
    if name.startswith(("cin", "crf", "cblock")):
        return 110.0, 210.0
    if name.startswith(("lmatch", "lin", "lseries")) or (comp_type == "inductor" and has_any_node(component, "match", "gate")):
        return 170.0, 220.0
    if name.startswith(("cmatch", "cshunt")) or (comp_type == "capacitor" and has_any_node(component, "match") and has_ground):
        return 127.0, 310.0
    if comp_type in {"mosfet", "bjt"}:
        return 340.0, 200.0
    if name.startswith(("rg_top", "rgtop", "rb_top")) or (has_any_node(component, "vgate", "vbias") and has_power):
        return 70.0, 96.0
    if name.startswith(("rg_bot", "rgbot", "rb_bot")) or (has_any_node(component, "vgate", "vbias") and has_ground):
        return 70.0, 324.0
    if name.startswith(("rgate", "riso", "rg_stop")):
        return 270.0, 170.0
    if name.startswith(("rs", "re")) and has_ground:
        return 340.0, 324.0
    if name.startswith(("lload", "ldrain", "lchoke")) or (comp_type == "inductor" and has_power):
        return 392.0, 96.0
    if name.startswith(("cdd", "cdec", "cvdd", "cbyp")) and has_power and has_ground:
        return 860.0, 324.0
    if name.startswith(("ccouple", "cout_rf")) or (comp_type == "capacitor" and has_any_node(component, "rf_amp", "det_in")):
        return 455.0, 185.0
    if comp_type == "diode" or name.startswith(("ddet", "drect")):
        return 535.0, 190.0
    if name.startswith(("rdet", "renv")) or (comp_type == "resistor" and has_any_node(component, "env", "det", "lpf") and has_ground):
        return 585.0, 324.0
    if name.startswith(("cdet", "cenv")) or (comp_type == "capacitor" and has_any_node(component, "env", "det") and has_ground):
        return 635.0, 324.0
    if name.startswith(("rlp", "radc")) or (comp_type == "resistor" and has_any_node(component, "env", "lpf", "adc")):
        return 700.0, 235.0
    if name.startswith(("clp", "cadc")) or (comp_type == "capacitor" and has_any_node(component, "lpf", "adc") and has_ground):
        return 735.0, 324.0
    if name.startswith(("rth1", "rref_top")) or (has_any_node(component, "vth", "ref") and has_power):
        return 930.0, 56.0
    if name.startswith(("rth2", "rref_bot")) or (has_any_node(component, "vth", "ref") and has_ground):
        return 930.0, 156.0
    if hint == "comparator":
        return 980.0, 210.0
    if has_node(component, output_node):
        return 980.0, 210.0
    return None


def component_stage(component: dict[str, object]) -> str:
    attributes_stage = str(component.get("stage") or "").lower()
    if attributes_stage:
        return attributes_stage
    return str(component.get("component_stage") or component.get("component_role") or "").lower()


def component_type(component: dict[str, object]) -> str:
    return str(component.get("type") or "").lower()


def placement_for_opamp_feedback_component(component: dict[str, object], input_node: str, output_node: str) -> tuple[float, float] | None:
    name = str(component.get("name") or "").lower()
    hint = str(component.get("symbol_hint") or "").lower()
    nodes = component_nodes(component)
    has_ground = any(rail_symbol_for_format(node) == "gnd" for node in nodes)

    if hint == "opamp":
        return 188.0, 170.0
    if name.startswith("rin") or (has_node(component, input_node) and has_any_node(component, "vp", "inp", "vinp")):
        return 84.0, 195.0
    if name.startswith(("r2f", "rfb_top")) or (has_any_node(component, output_node, "vout", "out") and has_any_node(component, "vn", "fb")):
        return 188.0, 105.0
    if name.startswith(("r1f", "rfb_bot")) or (has_any_node(component, "vn", "fb") and has_ground):
        return 20.0, 250.0
    if name.startswith(("rout", "rop")) or (has_any_node(component, "vout_int", "op_raw") and has_any_node(component, output_node, "vout", "out")):
        return 300.0, 185.0
    if name.startswith(("cload", "cout", "cop")) or (has_node(component, output_node) and has_ground):
        return 340.0, 258.0
    if has_node(component, output_node):
        return 430.0, 185.0
    return None


def placement_for_lna_component(component: dict[str, object], input_node: str, output_node: str) -> tuple[float, float] | None:
    name = str(component.get("name") or "").lower()
    ctype = component_type(component)
    nodes = component_nodes(component)
    has_ground = any(rail_symbol_for_format(node) == "gnd" for node in nodes)
    has_power = any(rail_symbol_for_format(node) == "vcc" for node in nodes)

    if has_node(component, input_node):
        return 78.0, 210.0
    if name.startswith(("cin", "cblock")):
        return 145.0, 210.0
    if name.startswith(("rb1", "rg_top", "rgtop")) or (has_any_node(component, "b", "base", "gate") and has_power):
        return 210.0, 96.0
    if name.startswith(("rb2", "rg_bot", "rgbot")) or (has_any_node(component, "b", "base", "gate") and has_ground):
        return 210.0, 324.0
    if ctype in {"bjt", "mosfet"}:
        return 320.0, 210.0
    if name.startswith(("rc", "rd", "lload", "ldrain")) or (has_any_node(component, "c", "collector", "drain") and has_power):
        return 340.0, 96.0
    if name.startswith(("re", "rs")) and has_ground:
        return 320.0, 324.0
    if name.startswith(("ce", "cs")) and has_ground:
        return 390.0, 324.0
    if name.startswith(("cout", "ccouple")) or (ctype == "capacitor" and has_any_node(component, "c", "collector", "drain", "out")):
        return 450.0, 210.0
    if name.startswith(("rload", "rl")) or (has_node(component, output_node) and has_ground):
        return 540.0, 324.0
    if has_node(component, output_node):
        return 610.0, 210.0
    return None


def placement_for_ldo_component(component: dict[str, object], input_node: str, output_node: str) -> tuple[float, float] | None:
    name = str(component.get("name") or "").lower()
    ctype = component_type(component)
    nodes = component_nodes(component)
    lower_nodes = [node.lower() for node in nodes]
    node_set = set(lower_nodes)
    has_ground = any(rail_symbol_for_format(node) == "gnd" for node in nodes)
    has_power_like = has_any_node(component, input_node, "vin", "vdd", "vcc")

    if ctype == "voltage_source" and has_any_node(component, input_node, "vin", "vdd", "vcc"):
        return 60.0, 185.0
    if ctype == "voltage_source" and has_any_node(component, "vref", "ref"):
        return 120.0, 300.0
    if ctype == "current_source" and has_ground:
        return 320.0, 330.0
    if ctype in {"bjt", "mosfet"} and len(lower_nodes) >= 3:
        drain, gate, source = lower_nodes[:3]
        if drain == output_node.lower() and (source == input_node.lower() or rail_symbol_for_format(source) == "vcc" or source.startswith("vin")):
            return 500.0, 128.0
        if gate in {"fb", "vn"} or "fb" in node_set:
            return 260.0, 215.0
        if gate in {"vref", "ref", "vp"} or "vref" in node_set:
            return 380.0, 215.0
        if drain == gate:
            return 260.0, 110.0
        if source == input_node.lower() or rail_symbol_for_format(source) == "vcc" or source.startswith("vin"):
            return 380.0, 110.0
    if name.startswith(("qerr", "merr")) or (ctype in {"bjt", "mosfet"} and has_any_node(component, "vref", "fb")):
        return 320.0, 215.0
    if name.startswith(("mpass", "m_pass", "qpass", "q_pass")) or (ctype == "mosfet" and has_any_node(component, "gate", "vin", "out")):
        return 500.0, 128.0
    if name.startswith(("rpu", "rgate")) or (has_any_node(component, "gate") and has_power_like):
        return 80.0, 105.0
    if name.startswith(("rfb1", "rtop")) or (has_any_node(component, output_node, "out") and has_any_node(component, "fb")):
        return 620.0, 220.0
    if name.startswith(("rfb2", "rbot")) or (has_any_node(component, "fb") and has_ground):
        return 620.0, 304.0
    if name.startswith(("cout", "ccomp")) or (has_node(component, output_node) and has_ground and ctype == "capacitor"):
        return 730.0, 304.0
    if name.startswith(("rload", "rl")) or (has_node(component, output_node) and has_ground and ctype == "resistor"):
        return 800.0, 304.0
    if has_node(component, input_node):
        return 60.0, 185.0
    if has_node(component, output_node):
        return 720.0, 210.0
    return None


def placement_for_single_stage_component(component: dict[str, object], input_node: str, output_node: str) -> tuple[float, float] | None:
    return placement_for_lna_component(component, input_node, output_node)


def component_model_text(component: dict[str, object]) -> str:
    values = [
        component.get("model"),
        component.get("value"),
        component.get("value_spice"),
        component.get("raw"),
    ]
    return " ".join(str(value or "") for value in values).lower()


def is_pmos_component(component: dict[str, object]) -> bool:
    text = component_model_text(component)
    return "pmos" in text or "p_mos" in text


def is_nmos_component(component: dict[str, object]) -> bool:
    text = component_model_text(component)
    return "nmos" in text or "n_mos" in text or (component_type(component) == "mosfet" and not is_pmos_component(component))


def apply_cmos_inverter_placements(
    groups: dict[str, ET.Element],
    pin_nodes_by_cell: dict[str, dict[str, str]],
    components: dict[str, dict[str, object]],
    input_node: str,
    output_node: str,
) -> bool:
    mosfets = [(name, comp) for name, comp in components.items() if component_type(comp) == "mosfet"]
    if len(mosfets) != 2 or not input_node or not output_node:
        return False
    pmos = next(((name, comp) for name, comp in mosfets if is_pmos_component(comp)), None)
    nmos = next(((name, comp) for name, comp in mosfets if is_nmos_component(comp)), None)
    if pmos is None or nmos is None:
        return False
    if not all(has_node(comp, input_node) and has_node(comp, output_node) for _, comp in mosfets):
        return False

    updated = False
    updated = place_component_node_pin(groups, pin_nodes_by_cell, pmos[0], output_node, (340.0, 150.0)) or updated
    updated = place_component_node_pin(groups, pin_nodes_by_cell, nmos[0], output_node, (340.0, 300.0)) or updated
    for name, comp in components.items():
        if component_type(comp) == "capacitor" and has_node(comp, output_node):
            updated = place_component_node_pin(groups, pin_nodes_by_cell, name, output_node, (510.0, 300.0)) or updated
    if "IN" in groups:
        set_group_anchor(groups["IN"], (110.0, 240.0))
        updated = True
    if "OUT" in groups:
        set_group_anchor(groups["OUT"], (640.0, 225.0))
        updated = True
    for name, group in groups.items():
        if name.startswith("vcc_"):
            set_group_anchor(group, (340.0, 82.0))
            updated = True
        elif name.startswith("gnd_"):
            set_group_anchor(group, (340.0, 384.0))
            updated = True
    return updated


def apply_mos_differential_pair_placements(
    groups: dict[str, ET.Element],
    pin_nodes_by_cell: dict[str, dict[str, str]],
    components: dict[str, dict[str, object]],
) -> bool:
    mosfets = [(name, comp) for name, comp in components.items() if component_type(comp) == "mosfet"]
    nodes = {node.lower() for comp in components.values() for node in component_nodes(comp)}
    if len(mosfets) < 2 or not {"inp", "inn", "tail"} <= nodes:
        return False
    left = next(((name, comp) for name, comp in mosfets if has_node(comp, "inp")), None)
    right = next(((name, comp) for name, comp in mosfets if has_node(comp, "inn")), None)
    if left is None or right is None:
        return False

    updated = False
    updated = place_component_node_pin(groups, pin_nodes_by_cell, left[0], "tail", (260.0, 340.0)) or updated
    updated = place_component_node_pin(groups, pin_nodes_by_cell, right[0], "tail", (460.0, 340.0)) or updated
    for name, comp in components.items():
        lower = name.lower()
        if component_type(comp) == "resistor" and has_node(comp, "outp"):
            updated = place_component_node_pin(groups, pin_nodes_by_cell, name, "outp", (260.0, 135.0)) or updated
        elif component_type(comp) == "resistor" and has_node(comp, "outn"):
            updated = place_component_node_pin(groups, pin_nodes_by_cell, name, "outn", (460.0, 135.0)) or updated
        elif component_type(comp) == "current_source" or lower.startswith(("itail", "i_tail")):
            updated = place_component_node_pin(groups, pin_nodes_by_cell, name, "tail", (360.0, 430.0)) or updated
    if "IN" in groups:
        set_group_anchor(groups["IN"], (80.0, 265.0))
        updated = True
    if "OUT" in groups:
        set_group_anchor(groups["OUT"], (640.0, 170.0))
        updated = True
    set_terminal_group_anchor(groups, ("ITAIL", "TAIL"), (360.0, 430.0))
    for name, group in groups.items():
        if name.startswith("vcc_"):
            set_group_anchor(group, (360.0, 55.0))
            updated = True
        elif name.startswith("gnd_"):
            set_group_anchor(group, (360.0, 510.0))
            updated = True
    return updated


def apply_current_mirror_placements(
    groups: dict[str, ET.Element],
    pin_nodes_by_cell: dict[str, dict[str, str]],
    components: dict[str, dict[str, object]],
    input_node: str,
    output_node: str,
) -> bool:
    mosfets = [(name, comp) for name, comp in components.items() if component_type(comp) == "mosfet"]
    if len(mosfets) != 2:
        return False
    parsed: list[tuple[str, dict[str, object], str, str, str]] = []
    for name, comp in mosfets:
        nodes = component_nodes(comp)
        if len(nodes) < 3:
            return False
        parsed.append((name, comp, nodes[0], nodes[1], nodes[2]))
    gate_nodes = {gate.lower() for _, _, _, gate, _ in parsed}
    if len(gate_nodes) != 1:
        return False
    reference = next(((name, comp, drain, gate, source) for name, comp, drain, gate, source in parsed if drain.lower() == gate.lower()), None)
    output = next(((name, comp, drain, gate, source) for name, comp, drain, gate, source in parsed if drain.lower() != gate.lower()), None)
    if reference is None or output is None:
        return False

    _ref_name, _ref_comp, ref_drain, ref_gate, _ref_source = reference
    out_name, _out_comp, out_drain, _out_gate, _out_source = output
    if output_node and out_drain.lower() != output_node.lower():
        return False

    updated = False
    updated = place_component_node_pin(groups, pin_nodes_by_cell, reference[0], ref_drain, (250.0, 190.0)) or updated
    updated = place_component_node_pin(groups, pin_nodes_by_cell, out_name, out_drain, (430.0, 190.0)) or updated
    for name, comp in components.items():
        ctype = component_type(comp)
        lower = name.lower()
        if ctype == "current_source" and (has_node(comp, ref_drain) or has_node(comp, ref_gate)):
            updated = place_component_node_pin(groups, pin_nodes_by_cell, name, ref_drain, (250.0, 95.0)) or updated
        elif ctype == "resistor" and has_node(comp, out_drain):
            updated = place_component_node_pin(groups, pin_nodes_by_cell, name, out_drain, (430.0, 95.0)) or updated
        elif lower.startswith(("i_ref", "iref")):
            updated = place_component_node_pin(groups, pin_nodes_by_cell, name, ref_drain, (250.0, 95.0)) or updated
    if "IN" in groups and input_node:
        set_group_anchor(groups["IN"], (95.0, 210.0))
        updated = True
    if "OUT" in groups:
        set_group_anchor(groups["OUT"], (610.0, 190.0))
        updated = True
    for name, group in groups.items():
        if name.startswith("vcc_"):
            set_group_anchor(group, (340.0, 38.0))
            updated = True
        elif name.startswith("gnd_"):
            set_group_anchor(group, (340.0, 335.0))
            updated = True
    return updated


def apply_mos_common_source_placements(
    groups: dict[str, ET.Element],
    pin_nodes_by_cell: dict[str, dict[str, str]],
    components: dict[str, dict[str, object]],
    input_node: str,
    output_node: str,
) -> bool:
    mosfets = [(name, comp) for name, comp in components.items() if component_type(comp) == "mosfet"]
    if len(mosfets) != 1:
        return False
    transistor_name, transistor = mosfets[0]
    nodes = component_nodes(transistor)
    if len(nodes) < 3:
        return False
    drain, gate, source = nodes[:3]

    updated = False
    updated = place_component_node_pin(groups, pin_nodes_by_cell, transistor_name, drain, (320.0, 185.0)) or updated
    for name, comp in components.items():
        ctype = component_type(comp)
        lower = name.lower()
        if name == transistor_name:
            continue
        if ctype == "resistor" and has_node(comp, gate):
            if any(rail_symbol_for_format(node) == "vcc" for node in component_nodes(comp)):
                updated = place_component_node_pin(groups, pin_nodes_by_cell, name, gate, (220.0, 140.0)) or updated
            elif any(rail_symbol_for_format(node) == "gnd" for node in component_nodes(comp)):
                updated = place_component_node_pin(groups, pin_nodes_by_cell, name, gate, (220.0, 305.0)) or updated
            else:
                updated = place_component_node_pin(groups, pin_nodes_by_cell, name, gate, (205.0, 210.0)) or updated
        elif ctype == "resistor" and has_node(comp, drain):
            updated = place_component_node_pin(groups, pin_nodes_by_cell, name, drain, (320.0, 135.0)) or updated
        elif ctype == "resistor" and has_node(comp, source):
            updated = place_component_node_pin(groups, pin_nodes_by_cell, name, source, (350.0, 315.0)) or updated
        elif ctype == "capacitor" and has_node(comp, source):
            updated = place_component_node_pin(groups, pin_nodes_by_cell, name, source, (430.0, 315.0)) or updated
        elif ctype == "capacitor" and has_node(comp, drain):
            updated = place_component_node_pin(groups, pin_nodes_by_cell, name, drain, (470.0, 210.0)) or updated
        elif lower.startswith(("rload", "rl")) or (output_node and has_node(comp, output_node)):
            updated = place_component_node_pin(groups, pin_nodes_by_cell, name, output_node, (610.0, 315.0)) or updated
    if "IN" in groups:
        set_group_anchor(groups["IN"], (80.0, 210.0))
        updated = True
    if "OUT" in groups:
        set_group_anchor(groups["OUT"], (690.0, 210.0))
        updated = True
    for name, group in groups.items():
        if name.startswith("vcc_"):
            set_group_anchor(group, (320.0, 60.0))
            updated = True
        elif name.startswith("gnd_"):
            if name == "gnd_0":
                set_group_anchor(group, (430.0, 300.0))
            else:
                set_group_anchor(group, (360.0, 405.0))
            updated = True
    return updated


def apply_bjt_reset_handshake_placements(
    groups: dict[str, ET.Element],
    pin_nodes_by_cell: dict[str, dict[str, str]],
    components: dict[str, dict[str, object]],
) -> bool:
    nodes = {node.lower() for comp in components.values() for node in component_nodes(comp)}
    if not {"rst", "dtr", "rts", "boot0"} <= nodes:
        return False
    updated = False
    placements = {
        "Q_BOOT": ("boot_node", (173.0, 282.0)),
        "Q_RST": ("rst_pull", (452.0, 165.0)),
        "D1": ("rst_pull", (325.0, 175.0)),
        "R50": ("rst_pull", (435.0, 105.0)),
        "R51": ("dtr_drive", (400.0, 170.0)),
        "R49": ("rts_drive", (285.0, 325.0)),
        "R52": ("boot_node", (205.0, 282.0)),
    }
    for name, (node, point) in placements.items():
        if name in components:
            updated = place_component_node_pin(groups, pin_nodes_by_cell, name, node, point) or updated
    terminal_anchors = {
        "RST": (245.0, 175.0),
        "DTR": (330.0, 140.0),
        "RTS": (720.0, 330.0),
        "BOOT0": (280.0, 287.0),
    }
    for name, point in terminal_anchors.items():
        group = groups.get(name)
        if group is not None:
            set_group_anchor(group, point)
            updated = True
    for name, group in groups.items():
        if name.startswith("vcc_"):
            target = (435.0, 25.0) if "local" in name else (172.0, 220.0)
            set_group_anchor(group, target)
            updated = True
    return updated


def apply_single_stage_topology_placements(root: ET.Element, payload: dict[str, object], input_node: str, output_node: str) -> bool:
    groups = find_cell_groups(root)
    pin_nodes_by_cell = cell_pin_node_map(payload)
    components = component_by_name(payload)
    if not components:
        return False
    return (
        apply_cmos_inverter_placements(groups, pin_nodes_by_cell, components, input_node, output_node)
        or apply_mos_differential_pair_placements(groups, pin_nodes_by_cell, components)
        or apply_current_mirror_placements(groups, pin_nodes_by_cell, components, input_node, output_node)
        or apply_bjt_reset_handshake_placements(groups, pin_nodes_by_cell, components)
        or apply_mos_common_source_placements(groups, pin_nodes_by_cell, components, input_node, output_node)
    )


def rail_symbol_for_format(node: str) -> str | None:
    lower = node.strip().lower()
    if lower in {"0", "gnd", "agnd", "dgnd", "pgnd"} or lower.endswith("gnd"):
        return "gnd"
    if lower.startswith(("vcc", "vdd")) or lower.endswith(("_vcc", "_vdd")):
        return "vcc"
    if lower.startswith(("vee", "vss")) or lower.endswith(("_vee", "_vss")):
        return "vee"
    return None


def group_pin_offsets(group: ET.Element) -> dict[str, tuple[float, float]]:
    offsets: dict[str, tuple[float, float]] = {}
    for child in group.iter():
        if child is group or local_name(child.tag) != "g":
            continue
        pid = get_attr(child, "pid")
        if not pid:
            continue
        offsets[pid] = (parse_float(get_attr(child, "x")), parse_float(get_attr(child, "y")))
    return offsets


def set_group_pin(group: ET.Element, pin: str, target: tuple[float, float]) -> bool:
    offsets = group_pin_offsets(group)
    offset = offsets.get(pin)
    if offset is None:
        return False
    set_group_xy(group, target[0] - offset[0], target[1] - offset[1])
    return True


def set_group_first_pin(group: ET.Element, target: tuple[float, float]) -> bool:
    offsets = group_pin_offsets(group)
    if not offsets:
        return False
    pin = next(iter(offsets))
    return set_group_pin(group, pin, target)


def cell_pin_node_map(payload: dict[str, object]) -> dict[str, dict[str, str]]:
    node_names = bit_to_node_name(payload)
    module = first_module_payload(payload)
    cells = module.get("cells", {}) if isinstance(module, dict) else {}
    if not isinstance(cells, dict):
        return {}
    mapping: dict[str, dict[str, str]] = {}
    for cell_name, cell in cells.items():
        if not isinstance(cell, dict):
            continue
        connections = cell.get("connections", {})
        if not isinstance(connections, dict):
            continue
        pin_nodes: dict[str, str] = {}
        for pin, bits in connections.items():
            if not isinstance(bits, list) or not bits:
                continue
            bit = bits[0]
            if isinstance(bit, int) and bit in node_names:
                pin_nodes[str(pin)] = node_names[bit]
        mapping[str(cell_name)] = pin_nodes
    return mapping


def pin_for_node(pin_nodes: dict[str, str], node: str) -> str | None:
    node_lower = node.lower()
    for pin, pin_node in pin_nodes.items():
        if pin_node.lower() == node_lower:
            return pin
    return None


def component_by_name(payload: dict[str, object]) -> dict[str, dict[str, object]]:
    components = payload.get("components", [])
    result: dict[str, dict[str, object]] = {}
    for comp in components if isinstance(components, list) else []:
        if not isinstance(comp, dict):
            continue
        result[str(comp.get("name") or "")] = comp
    return result


def place_component_node_pin(
    groups: dict[str, ET.Element],
    pin_nodes_by_cell: dict[str, dict[str, str]],
    component_name: str,
    node: str,
    target: tuple[float, float],
) -> bool:
    group = groups.get(component_name)
    if group is None:
        return False
    pin = pin_for_node(pin_nodes_by_cell.get(component_name, {}), node)
    if pin is None:
        return set_group_first_pin(group, target)
    return set_group_pin(group, pin, target)


def signal_pin_names(pin_nodes: dict[str, str]) -> list[tuple[str, str]]:
    return [(pin, node) for pin, node in pin_nodes.items() if rail_symbol_for_format(node) is None]


def generic_passive_components(payload: dict[str, object]) -> list[dict[str, object]]:
    components = payload.get("components", [])
    allowed = {"resistor", "capacitor", "inductor", "diode"}
    result: list[dict[str, object]] = []
    for comp in components if isinstance(components, list) else []:
        if not isinstance(comp, dict):
            continue
        if component_type(comp) not in allowed:
            return []
        result.append(comp)
    return result


def apply_generic_passive_placements(root: ET.Element, payload: dict[str, object]) -> bool:
    components = generic_passive_components(payload)
    if not components:
        return False

    groups = find_cell_groups(root)
    pin_nodes_by_cell = cell_pin_node_map(payload)
    main_y = 160.0
    branch_y = main_y + 50.0
    cursor_x = 90.0
    node_xs: dict[str, list[float]] = defaultdict(list)
    shunt_index: dict[str, int] = defaultdict(int)

    series_components: list[dict[str, object]] = []
    shunt_components: list[dict[str, object]] = []
    for comp in components:
        name = str(comp.get("name") or "")
        signal_pins = signal_pin_names(pin_nodes_by_cell.get(name, {}))
        if len(signal_pins) >= 2:
            series_components.append(comp)
        else:
            shunt_components.append(comp)

    for comp in series_components:
        name = str(comp.get("name") or "")
        group = groups.get(name)
        if group is None:
            continue
        signal_pins = signal_pin_names(pin_nodes_by_cell.get(name, {}))
        if len(signal_pins) < 2:
            continue
        first_pin, first_node = signal_pins[0]
        if not set_group_pin(group, first_pin, (cursor_x, main_y)):
            continue
        offsets = group_pin_offsets(group)
        transform = parse_translate(group.get("transform"))
        if transform is None:
            continue
        for pin, node in signal_pins[:2]:
            offset = offsets.get(pin)
            if offset is None:
                continue
            node_xs[node].append(transform[0] + offset[0])
        cursor_x = max((transform[0] + offset[0] for offset in offsets.values()), default=cursor_x) + 90.0
        node_xs.setdefault(first_node, [])

    if not series_components:
        seen_nodes: list[str] = []
        for comp in components:
            for node in component_nodes(comp):
                if rail_symbol_for_format(node) is None and node not in seen_nodes:
                    seen_nodes.append(node)
        for node in seen_nodes:
            node_xs[node].append(cursor_x)
            cursor_x += 90.0

    for comp in shunt_components:
        name = str(comp.get("name") or "")
        group = groups.get(name)
        if group is None:
            continue
        signal_pins = signal_pin_names(pin_nodes_by_cell.get(name, {}))
        if not signal_pins:
            continue
        pin, node = signal_pins[0]
        base_x = max(node_xs.get(node, [cursor_x]))
        branch_x = base_x + 56.0 * shunt_index[node]
        shunt_index[node] += 1
        if set_group_pin(group, pin, (branch_x, branch_y)):
            node_xs[node].append(branch_x)

    interfaces = payload.get("interfaces", {}) if isinstance(payload.get("interfaces"), dict) else {}
    io = payload.get("io_inference", {}) if isinstance(payload.get("io_inference"), dict) else {}
    input_node = str(interfaces.get("input_node") or io.get("input_node") or "")
    output_node = str(interfaces.get("output_node") or io.get("output_node") or "")
    if "IN" in groups and input_node in node_xs:
        set_group_anchor(groups["IN"], (min(node_xs[input_node]) - 70.0, main_y))
    if "OUT" in groups and output_node in node_xs:
        set_group_anchor(groups["OUT"], (max(node_xs[output_node]) + 90.0, main_y))

    return True


def apply_buck_converter_placements(root: ET.Element, payload: dict[str, object]) -> None:
    groups = find_cell_groups(root)
    pin_nodes_by_cell = cell_pin_node_map(payload)
    components = component_by_name(payload)

    for name, comp in components.items():
        ctype = component_type(comp)
        nodes = component_nodes(comp)
        lower = name.lower()
        if ctype == "mosfet":
            place_component_node_pin(groups, pin_nodes_by_cell, name, nodes[0], (180.0, 150.0))
        elif ctype == "diode" or lower.startswith("d"):
            nonrails = [node for node in nodes if rail_symbol_for_format(node) is None]
            if nonrails:
                place_component_node_pin(groups, pin_nodes_by_cell, name, nonrails[0], (235.0, 200.0))
        elif ctype == "inductor":
            place_component_node_pin(groups, pin_nodes_by_cell, name, nodes[0], (300.0, 200.0))
        elif ctype == "capacitor":
            nonrails = [node for node in nodes if rail_symbol_for_format(node) is None]
            if nonrails:
                place_component_node_pin(groups, pin_nodes_by_cell, name, nonrails[0], (410.0, 200.0))
        elif ctype == "resistor":
            nonrails = [node for node in nodes if rail_symbol_for_format(node) is None]
            if nonrails:
                place_component_node_pin(groups, pin_nodes_by_cell, name, nonrails[0], (470.0, 200.0))

    if "IN" in groups:
        set_group_anchor(groups["IN"], (80.0, 100.0))
    if "OUT" in groups:
        set_group_anchor(groups["OUT"], (580.0, 200.0))
    set_terminal_group_anchor(groups, ("GATE", "VGATE"), (92.0, 175.0))


def apply_cascode_amplifier_placements(root: ET.Element, payload: dict[str, object]) -> None:
    groups = find_cell_groups(root)
    pin_nodes_by_cell = cell_pin_node_map(payload)
    components = component_by_name(payload)
    interfaces = payload.get("interfaces", {}) if isinstance(payload.get("interfaces"), dict) else {}
    io = payload.get("io_inference", {}) if isinstance(payload.get("io_inference"), dict) else {}
    input_node = str(interfaces.get("input_node") or io.get("input_node") or "")
    output_node = str(interfaces.get("output_node") or io.get("output_node") or "")

    for name, comp in components.items():
        ctype = component_type(comp)
        nodes = component_nodes(comp)
        lower = name.lower()
        node_lowers = [node.lower() for node in nodes]
        if ctype == "mosfet" and len(nodes) >= 3:
            if input_node and nodes[1].lower() == input_node.lower():
                place_component_node_pin(groups, pin_nodes_by_cell, name, nodes[0], (300.0, 230.0))
            else:
                place_component_node_pin(groups, pin_nodes_by_cell, name, nodes[2], (300.0, 200.0))
        elif lower.startswith("rs") and "ns" in node_lowers:
            place_component_node_pin(groups, pin_nodes_by_cell, name, "ns", (300.0, 315.0))
        elif lower.startswith("rl") and "no" in node_lowers:
            place_component_node_pin(groups, pin_nodes_by_cell, name, "no", (300.0, 150.0))
        elif lower.startswith("cint") and "no" in node_lowers:
            place_component_node_pin(groups, pin_nodes_by_cell, name, "no", (360.0, 150.0))
        elif lower.startswith("ccomp") and "no" in node_lowers:
            place_component_node_pin(groups, pin_nodes_by_cell, name, "no", (190.0, 150.0))
        elif lower.startswith("rout") and "no" in node_lowers:
            place_component_node_pin(groups, pin_nodes_by_cell, name, "no", (430.0, 150.0))
        elif lower.startswith(("cload", "cout")) and output_node:
            place_component_node_pin(groups, pin_nodes_by_cell, name, output_node, (520.0, 150.0))

    if "IN" in groups:
        set_group_anchor(groups["IN"], (130.0, 255.0))
    if "OUT" in groups:
        set_group_anchor(groups["OUT"], (620.0, 150.0))
    set_terminal_group_anchor(groups, ("VB", "VBIAS"), (215.0, 220.0))


def apply_ring_oscillator_placements(root: ET.Element, payload: dict[str, object]) -> None:
    groups = find_cell_groups(root)
    pin_nodes_by_cell = cell_pin_node_map(payload)
    components = component_by_name(payload)
    stage_x = {"n1": 180.0, "n2": 360.0, "n3": 540.0}
    shunt_counts: dict[str, int] = defaultdict(int)

    for name, comp in components.items():
        ctype = component_type(comp)
        nodes = component_nodes(comp)
        lower = name.lower()
        if ctype == "mosfet" and len(nodes) >= 3:
            drain = nodes[0].lower()
            source = nodes[2]
            x = stage_x.get(drain, 180.0)
            drain_y = 110.0 if rail_symbol_for_format(source) == "vcc" else 230.0
            place_component_node_pin(groups, pin_nodes_by_cell, name, nodes[0], (x, drain_y))
            continue
        if ctype in {"capacitor", "resistor"}:
            nonrails = [node for node in nodes if rail_symbol_for_format(node) is None]
            if not nonrails:
                continue
            node = nonrails[0].lower()
            x = stage_x.get(node, 180.0) + 52.0 + 44.0 * shunt_counts[node]
            shunt_counts[node] += 1
            place_component_node_pin(groups, pin_nodes_by_cell, name, nonrails[0], (x, 310.0))

    if "IN" in groups:
        set_group_anchor(groups["IN"], (78.0, 330.0))
    if "OUT" in groups:
        set_group_anchor(groups["OUT"], (680.0, 330.0))
    for name, group in groups.items():
        if name.startswith("vcc_"):
            set_group_anchor(group, (96.0, 70.0))
        elif name.startswith("gnd_"):
            set_group_anchor(group, (96.0, 420.0))


def apply_signal_chain_placements(root: ET.Element, payload: dict[str, object]) -> None:
    groups = find_cell_groups(root)
    components = payload.get("components", [])
    interfaces = payload.get("interfaces", {}) if isinstance(payload.get("interfaces"), dict) else {}
    io = payload.get("io_inference", {}) if isinstance(payload.get("io_inference"), dict) else {}
    input_node = str(interfaces.get("input_node") or io.get("input_node") or "")
    output_node = str(interfaces.get("output_node") or io.get("output_node") or "")

    for component in components if isinstance(components, list) else []:
        if not isinstance(component, dict):
            continue
        name = str(component.get("name") or "")
        group = groups.get(name)
        if group is None:
            continue
        placement = placement_for_signal_chain_component(component, input_node, output_node)
        if placement is not None:
            set_group_xy(group, placement[0], placement[1])

    if "IN" in groups:
        set_group_xy(groups["IN"], 22.0, 190.0)
    if "OUT" in groups:
        set_group_xy(groups["OUT"], 680.0, 180.0)

    for name, group in groups.items():
        if name.startswith("vcc_"):
            set_group_xy(group, 536.0, 28.0)
        elif name.startswith("vee_"):
            set_group_xy(group, 468.0, 360.0)
        elif name.startswith("gnd_"):
            set_group_xy(group, 344.0, 394.0)


def apply_rf_mixed_signal_placements(root: ET.Element, payload: dict[str, object]) -> None:
    groups = find_cell_groups(root)
    components = payload.get("components", [])
    interfaces = payload.get("interfaces", {}) if isinstance(payload.get("interfaces"), dict) else {}
    io = payload.get("io_inference", {}) if isinstance(payload.get("io_inference"), dict) else {}
    input_node = str(interfaces.get("input_node") or io.get("input_node") or "")
    output_node = str(interfaces.get("output_node") or io.get("output_node") or "")

    for component in components if isinstance(components, list) else []:
        if not isinstance(component, dict):
            continue
        name = str(component.get("name") or "")
        group = groups.get(name)
        if group is None:
            continue
        placement = placement_for_rf_mixed_component(component, input_node, output_node)
        if placement is not None:
            set_group_xy(group, placement[0], placement[1])

    if "IN" in groups:
        set_group_xy(groups["IN"], 24.0, 210.0)
    if "OUT" in groups:
        set_group_xy(groups["OUT"], 1130.0, 210.0)

    for name, group in groups.items():
        if name.startswith("vcc_"):
            set_group_xy(group, 930.0, 26.0)
        elif name.startswith("vee_"):
            set_group_xy(group, 805.0, 420.0)
        elif name.startswith("gnd_"):
            set_group_xy(group, 590.0, 430.0)


def apply_opamp_feedback_placements(root: ET.Element, payload: dict[str, object]) -> None:
    groups = find_cell_groups(root)
    components = payload.get("components", [])
    interfaces = payload.get("interfaces", {}) if isinstance(payload.get("interfaces"), dict) else {}
    io = payload.get("io_inference", {}) if isinstance(payload.get("io_inference"), dict) else {}
    input_node = str(interfaces.get("input_node") or io.get("input_node") or "")
    output_node = str(interfaces.get("output_node") or io.get("output_node") or "")

    for component in components if isinstance(components, list) else []:
        if not isinstance(component, dict):
            continue
        group = groups.get(str(component.get("name") or ""))
        if group is None:
            continue
        placement = placement_for_opamp_feedback_component(component, input_node, output_node)
        if placement is not None:
            set_group_xy(group, placement[0], placement[1])

    if "IN" in groups:
        set_group_xy(groups["IN"], 22.0, 190.0)
    if "OUT" in groups:
        set_group_xy(groups["OUT"], 500.0, 190.0)

    for name, group in groups.items():
        if name.startswith("vcc_"):
            set_group_xy(group, 300.0, 28.0)
        elif name.startswith("vee_"):
            set_group_xy(group, 300.0, 360.0)
        elif name.startswith("gnd_"):
            set_group_xy(group, 246.0, 394.0)


def apply_lna_placements(root: ET.Element, payload: dict[str, object]) -> None:
    groups = find_cell_groups(root)
    components = payload.get("components", [])
    interfaces = payload.get("interfaces", {}) if isinstance(payload.get("interfaces"), dict) else {}
    io = payload.get("io_inference", {}) if isinstance(payload.get("io_inference"), dict) else {}
    input_node = str(interfaces.get("input_node") or io.get("input_node") or "")
    output_node = str(interfaces.get("output_node") or io.get("output_node") or "")

    if apply_single_stage_topology_placements(root, payload, input_node, output_node):
        return

    for component in components if isinstance(components, list) else []:
        if not isinstance(component, dict):
            continue
        group = groups.get(str(component.get("name") or ""))
        if group is None:
            continue
        placement = placement_for_lna_component(component, input_node, output_node)
        if placement is not None:
            set_group_xy(group, placement[0], placement[1])

    if "IN" in groups:
        set_group_xy(groups["IN"], 24.0, 210.0)
    if "OUT" in groups:
        set_group_xy(groups["OUT"], 650.0, 210.0)

    for name, group in groups.items():
        if name.startswith("vcc_"):
            set_group_xy(group, 340.0, 26.0)
        elif name.startswith("vee_"):
            set_group_xy(group, 320.0, 420.0)
        elif name.startswith("gnd_"):
            set_group_xy(group, 360.0, 430.0)


def apply_ldo_placements(root: ET.Element, payload: dict[str, object]) -> None:
    groups = find_cell_groups(root)
    components = payload.get("components", [])
    interfaces = payload.get("interfaces", {}) if isinstance(payload.get("interfaces"), dict) else {}
    io = payload.get("io_inference", {}) if isinstance(payload.get("io_inference"), dict) else {}
    input_node = str(interfaces.get("input_node") or io.get("input_node") or "")
    output_node = str(interfaces.get("output_node") or io.get("output_node") or "")

    for component in components if isinstance(components, list) else []:
        if not isinstance(component, dict):
            continue
        group = groups.get(str(component.get("name") or ""))
        if group is None:
            continue
        placement = placement_for_ldo_component(component, input_node, output_node)
        if placement is not None:
            set_group_xy(group, placement[0], placement[1])

    if "IN" in groups:
        set_group_xy(groups["IN"], 24.0, 185.0)
    if "OUT" in groups:
        set_group_xy(groups["OUT"], 880.0, 210.0)
    vref_anchor = (360.0, 240.0)
    for component in components if isinstance(components, list) else []:
        if isinstance(component, dict) and component_type(component) == "bjt" and has_any_node(component, "vref", "ref"):
            vref_anchor = (220.0, 240.0)
            break
    set_terminal_group_anchor(groups, ("VREF", "REF"), vref_anchor)
    set_terminal_group_anchor(groups, ("ITAIL", "TAIL", "IBIAS"), (330.0, 315.0))

    for name, group in groups.items():
        if name.startswith("vcc_"):
            set_group_xy(group, 115.0, 28.0)
        elif name.startswith("vee_"):
            set_group_xy(group, 360.0, 420.0)
        elif name.startswith("gnd_"):
            set_group_xy(group, 410.0, 430.0)


def apply_baseband_detail_placements(root: ET.Element, payload: dict[str, object]) -> None:
    groups = find_cell_groups(root)
    placements = {
        "Rdec": (70.0, 62.0),
        "Cdec": (130.0, 315.0),
        "Rin": (92.0, 210.0),
        "Rbias1": (182.0, 300.0),
        "Q2": (245.0, 138.0),
        "Q3": (342.0, 138.0),
        "Re_tail": (285.0, 262.0),
        "Rf": (378.0, 70.0),
        "Rg": (386.0, 306.0),
        "Rsk1": (474.0, 210.0),
        "Csk1": (506.0, 318.0),
        "Rsk2": (594.0, 210.0),
        "Csk2": (628.0, 318.0),
        "Q4": (712.0, 160.0),
        "Rload_bb": (784.0, 306.0),
    }
    for name, xy in placements.items():
        group = groups.get(name)
        if group is not None:
            set_group_xy(group, xy[0], xy[1])

    for name, group in groups.items():
        if name.startswith("PORT_IN_"):
            set_group_xy(group, 18.0, 220.0)
        elif name.startswith("PORT_OUT_"):
            set_group_xy(group, 865.0, 220.0)
        elif name.startswith("vcc_") or name.startswith("vdd_"):
            if "bb_vdd" in name:
                set_group_xy(group, 230.0, 26.0)
            else:
                set_group_xy(group, 72.0, 26.0)
        elif name.startswith("vee_") or name.startswith("vss_"):
            set_group_xy(group, 480.0, 454.0)
        elif name.startswith("gnd_"):
            if "csk" in name.lower():
                set_group_xy(group, 604.0, 454.0)
            elif "cdec" in name.lower():
                set_group_xy(group, 134.0, 454.0)
            else:
                set_group_xy(group, 360.0, 454.0)


def apply_window_comparator_detail_placements(root: ET.Element, payload: dict[str, object]) -> None:
    groups = find_cell_groups(root)
    placements = {
        "Rdiv1": (170.0, 58.0),
        "Rdiv2": (170.0, 130.0),
        "Rdiv3": (170.0, 308.0),
        "Q5": (310.0, 180.0),
        "R1": (310.0, 62.0),
        "Rref1": (310.0, 312.0),
        "Q6": (475.0, 180.0),
        "R2": (475.0, 62.0),
        "D2": (620.0, 166.0),
        "D3": (620.0, 222.0),
        "Rpull": (706.0, 62.0),
    }
    for name, xy in placements.items():
        group = groups.get(name)
        if group is not None:
            set_group_xy(group, xy[0], xy[1])

    for name, group in groups.items():
        if name.startswith("PORT_IN_"):
            set_group_xy(group, 22.0, 220.0)
        elif name.startswith("PORT_OUT_"):
            set_group_xy(group, 820.0, 205.0)
        elif name.startswith("vcc_") or name.startswith("vdd_"):
            set_group_xy(group, 458.0, 26.0)
        elif name.startswith("vee_") or name.startswith("vss_"):
            set_group_xy(group, 450.0, 430.0)
        elif name.startswith("gnd_"):
            set_group_xy(group, 232.0, 430.0)


def apply_profile_placements(root: ET.Element, payload: dict[str, object], profile: str) -> bool:
    if profile == "generic":
        return apply_generic_passive_placements(root, payload)
    if profile == "signal_chain_comparator":
        apply_signal_chain_placements(root, payload)
        return True
    if profile == "rf_mixed_signal":
        apply_rf_mixed_signal_placements(root, payload)
        return True
    if profile == "baseband_detail":
        apply_baseband_detail_placements(root, payload)
        return True
    if profile == "window_comparator_detail":
        apply_window_comparator_detail_placements(root, payload)
        return True
    if profile in {"opamp_feedback", "opamp"}:
        apply_opamp_feedback_placements(root, payload)
        return True
    if profile == "buck_converter":
        apply_buck_converter_placements(root, payload)
        return True
    if profile == "cascode_amplifier":
        apply_cascode_amplifier_placements(root, payload)
        return True
    if profile == "ring_oscillator":
        apply_ring_oscillator_placements(root, payload)
        return True
    if profile in {"lna_common_emitter", "single_stage_amplifier"}:
        apply_lna_placements(root, payload)
        return True
    if profile == "ldo_regulator":
        apply_ldo_placements(root, payload)
        return True
    return False


def load_schematic_overrides(path_value: str) -> dict[str, object] | None:
    if not path_value.strip():
        return None
    path = Path(path_value).expanduser().resolve()
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if data.get("schema") != "actoviq.schematic-overrides.v1":
        raise ValueError(f"unsupported schematic overrides schema: {path}")
    if not isinstance(data.get("items"), dict):
        raise ValueError(f"schematic overrides items must be an object: {path}")
    return data


def apply_schematic_overrides(root: ET.Element, overrides: dict[str, object] | None) -> dict[str, object]:
    if not overrides:
        return {"updated": False, "reason": "no_overrides"}
    items = overrides.get("items")
    if not isinstance(items, dict) or not items:
        return {"updated": False, "reason": "empty_overrides"}

    groups = find_cell_groups(root)
    moved: list[str] = []
    skipped: list[str] = []
    for item_id, record in items.items():
        if not isinstance(record, dict):
            skipped.append(str(item_id))
            continue
        group = groups.get(str(item_id))
        if group is None:
            skipped.append(str(item_id))
            continue
        try:
            x = float(record["x"])
            y = float(record["y"])
        except (KeyError, TypeError, ValueError):
            skipped.append(str(item_id))
            continue
        set_group_xy(group, x, y)
        moved.append(str(item_id))

    return {
        "updated": bool(moved),
        "moved": moved,
        "skipped": skipped,
    }


def cell_pin_points(root: ET.Element) -> dict[str, dict[str, tuple[float, float]]]:
    result: dict[str, dict[str, tuple[float, float]]] = {}
    for name, group in find_cell_groups(root).items():
        transform = parse_translate(group.get("transform"))
        if transform is None:
            continue
        gx, gy = transform
        pins: dict[str, tuple[float, float]] = {}
        for child in group.iter():
            if child is group or local_name(child.tag) != "g":
                continue
            pid = get_attr(child, "pid")
            if not pid:
                continue
            x = parse_float(get_attr(child, "x"))
            y = parse_float(get_attr(child, "y"))
            pins[pid] = (gx + x, gy + y)
        result[name] = pins
    return result


def bit_to_node_name(payload: dict[str, object]) -> dict[int, str]:
    mapping: dict[int, str] = {}
    for module in payload.get("modules", {}).values() if isinstance(payload.get("modules"), dict) else []:
        netnames = module.get("netnames", {}) if isinstance(module, dict) else {}
        for node, record in netnames.items():
            bits = record.get("bits", []) if isinstance(record, dict) else []
            for bit in bits:
                if isinstance(bit, int):
                    mapping[bit] = str(node)
    return mapping


def net_trunk_orientation(node: str, points: list[tuple[float, float]], input_node: str, output_node: str) -> str:
    lower = node.lower()
    if rail_symbol_for_format(node) is not None:
        return "horizontal"
    if lower == "vth":
        return "vertical"
    if lower in {
        input_node.lower(),
        output_node.lower(),
        "vp",
        "vn",
        "op_raw",
        "op_out",
        "filt",
        "alarm_n",
        "rf_in",
        "match",
        "gate",
        "drain",
        "rf_amp",
        "det_in",
        "env",
        "lpf",
        "adc",
        "adc_in",
    }:
        return "horizontal"
    if lower in {"vgate", "vbias", "vth", "ref"}:
        return "vertical"
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return "horizontal" if max(xs) - min(xs) >= max(ys) - min(ys) else "vertical"


def snap(value: float, grid: float = 10.0) -> float:
    return round(value / grid) * grid


def append_net_line(parent: ET.Element, net_class: str, start: tuple[float, float], end: tuple[float, float]) -> None:
    if nearly_equal(start[0], end[0]) and nearly_equal(start[1], end[1]):
        return
    parent.append(
        ET.Element(
            f"{{{SVG_NS}}}line",
            {
                "x1": format_num(start[0]),
                "y1": format_num(start[1]),
                "x2": format_num(end[0]),
                "y2": format_num(end[1]),
                "class": net_class,
            },
        )
    )


def append_counted_net_line(parent: ET.Element, net_class: str, start: tuple[float, float], end: tuple[float, float]) -> int:
    if nearly_equal(start[0], end[0]) and nearly_equal(start[1], end[1]):
        return 0
    append_net_line(parent, net_class, start, end)
    return 1


def append_net_label(root: ET.Element, net_class: str, label: str, x: float, y: float) -> None:
    text = ET.Element(
        f"{{{SVG_NS}}}text",
        {
            "x": format_num(x),
            "y": format_num(y),
            "class": f"nodelabel net-label {net_class}",
            "style": "font-size:10px;font-family:Courier New,monospace;stroke:none;fill:#000",
        },
    )
    text.text = label
    root.append(text)


def add_inline_horizontal_net(
    root: ET.Element,
    net_class: str,
    raw_points: list[tuple[float, float]],
    junction_counts: dict[tuple[float, float, str], int],
    signal_y: float,
) -> int:
    """Route a multi-pin signal as one horizontal trunk plus short vertical taps."""
    line_count = 0
    bus_xs: set[float] = set()
    for point in raw_points:
        bus_point = (point[0], signal_y)
        if not nearly_equal(point[1], signal_y):
            line_count += append_counted_net_line(root, net_class, point, bus_point)
            junction_counts[(bus_point[0], bus_point[1], net_class)] += 1
        bus_xs.add(bus_point[0])
    for start_x, end_x in zip(sorted(bus_xs), sorted(bus_xs)[1:]):
        line_count += append_counted_net_line(root, net_class, (start_x, signal_y), (end_x, signal_y))
    return line_count


def remove_existing_net_artifacts(root: ET.Element) -> None:
    for child in list(root):
        tag = local_name(child.tag)
        if tag in {"line", "circle"} and class_token(child, "net_"):
            root.remove(child)
        elif tag in {"path", "text"} and class_token(child, "local-rail-"):
            root.remove(child)
        elif tag == "g" and str(child.get("id") or "").startswith(("cell_gnd_local_", "cell_vcc_local_", "cell_vee_local_")):
            root.remove(child)


def rail_symbol_anchors(root: ET.Element, prefix: str) -> list[tuple[float, float]]:
    anchors: list[tuple[float, float]] = []
    for name, group in find_cell_groups(root).items():
        if not name.startswith(prefix):
            continue
        anchor = find_terminal_anchor(group)
        if anchor is not None:
            anchors.append(anchor)
    return anchors


def is_existing_rail_anchor(point: tuple[float, float], anchors: list[tuple[float, float]], tolerance: float = 0.75) -> bool:
    return any(abs(point[0] - anchor[0]) <= tolerance and abs(point[1] - anchor[1]) <= tolerance for anchor in anchors)


def set_group_anchor(group: ET.Element, anchor: tuple[float, float]) -> bool:
    current_anchor = find_terminal_anchor(group)
    transform = parse_translate(group.get("transform"))
    if current_anchor is None or transform is None:
        return False
    dx = current_anchor[0] - transform[0]
    dy = current_anchor[1] - transform[1]
    set_group_xy(group, anchor[0] - dx, anchor[1] - dy)
    return True


def set_terminal_group_anchor(
    groups: dict[str, ET.Element],
    labels: tuple[str, ...],
    anchor: tuple[float, float],
) -> bool:
    normalized = tuple(label.upper() for label in labels)
    updated = False
    for name, group in groups.items():
        upper_name = name.upper()
        if upper_name in normalized or any(upper_name.startswith(f"{label}_") for label in normalized):
            updated = set_group_anchor(group, anchor) or updated
    return updated


def relabel_cloned_cell(group: ET.Element, old_cell_class: str, new_cell_class: str) -> None:
    for elem in group.iter():
        elem_id = elem.get("id")
        if elem_id:
            elem.set("id", elem_id.replace(old_cell_class, new_cell_class))
        classes = str(elem.get("class") or "")
        if classes:
            elem.set("class", classes.replace(old_cell_class, new_cell_class))


def clone_ground_symbol(root: ET.Element, template: ET.Element, index: int, anchor: tuple[float, float]) -> ET.Element:
    clone = copy.deepcopy(template)
    old_id = template.get("id", "cell_gnd_0")
    new_id = f"cell_gnd_local_{index}"
    clone.set("id", new_id)
    relabel_cloned_cell(clone, old_id, new_id)
    set_group_anchor(clone, anchor)
    root.append(clone)
    return clone


def clone_power_symbol(
    root: ET.Element,
    template: ET.Element,
    rail: str,
    index: int,
    anchor: tuple[float, float],
) -> ET.Element:
    clone = copy.deepcopy(template)
    old_id = template.get("id", f"cell_{rail}_0")
    new_id = f"cell_{rail}_local_{index}"
    clone.set("id", new_id)
    relabel_cloned_cell(clone, old_id, new_id)
    set_group_anchor(clone, anchor)
    root.append(clone)
    return clone


def append_side_ground_symbol(root: ET.Element, net_class: str, anchor: tuple[float, float], label: str = "0") -> None:
    x, y = anchor
    root.append(
        ET.Element(
            f"{{{SVG_NS}}}path",
            {
                "d": (
                    f"M{format_num(x)},{format_num(y)} H{format_num(x + 12)} "
                    f"M{format_num(x + 12)},{format_num(y - 10)} V{format_num(y + 10)} "
                    f"M{format_num(x + 17)},{format_num(y - 7)} V{format_num(y + 7)} "
                    f"M{format_num(x + 22)},{format_num(y - 4)} V{format_num(y + 4)}"
                ),
                "class": f"local-rail-symbol {net_class}",
                "style": "fill:none;stroke:#000;stroke-width:1.5;stroke-linecap:round",
            },
        )
    )
    text = ET.Element(
        f"{{{SVG_NS}}}text",
        {
            "x": format_num(x + 28),
            "y": format_num(y + 4),
            "class": f"nodelabel local-rail-label {net_class}",
            "style": "font-size:10px;font-family:Courier New,monospace;stroke:none;fill:#000",
        },
    )
    text.text = label
    root.append(text)


def dedupe_local_ground_points(points: list[tuple[float, float]], min_gap: float = 14.0) -> list[tuple[float, float]]:
    deduped: list[tuple[float, float]] = []
    for point in sorted(points):
        if any(abs(point[0] - other[0]) <= min_gap and abs(point[1] - other[1]) <= min_gap for other in deduped):
            continue
        deduped.append(point)
    return deduped


def add_local_ground_net(
    root: ET.Element,
    net_class: str,
    raw_points: list[tuple[float, float]],
    junction_counts: dict[tuple[float, float, str], int],
) -> int:
    groups = find_cell_groups(root)
    template_name = next((name for name in sorted(groups) if name.startswith("gnd_")), "")
    template = groups.get(template_name)
    if template is None:
        return 0

    existing_anchors = rail_symbol_anchors(root, "gnd_")
    ground_points = [
        point
        for point in raw_points
        if not is_existing_rail_anchor(point, existing_anchors)
    ]
    ground_points = dedupe_local_ground_points(ground_points)
    if not ground_points:
        return 0

    line_count = 0
    standard_symbol_count = 0
    for point in sorted(ground_points, key=lambda item: (item[0] > 540.0 and item[1] < 230.0, item[0], item[1])):
        if point[0] > 540.0 and point[1] < 230.0:
            # A threshold-divider ground pin can sit just above the output
            # terminal. Use a side-facing local ground symbol in the short
            # whitespace above the output wire instead of a downward stem.
            anchor = (point[0] + 80.0, point[1])
            append_side_ground_symbol(root, net_class, anchor)
            route = [(point, anchor)]
        elif point[1] < 170.0:
            anchor = (point[0], point[1] - 28.0)
            route = [(point, anchor)]
            if standard_symbol_count == 0:
                set_group_anchor(template, anchor)
            else:
                clone_ground_symbol(root, template, standard_symbol_count, anchor)
            standard_symbol_count += 1
        else:
            anchor = (point[0], point[1] + 28.0)
            route = [(point, anchor)]
            if standard_symbol_count == 0:
                set_group_anchor(template, anchor)
            else:
                clone_ground_symbol(root, template, standard_symbol_count, anchor)
            standard_symbol_count += 1
        if point[0] <= 540.0 or point[1] >= 230.0:
            pass
        elif standard_symbol_count == 0:
            # Keep the original JSON-backed ground cell reachable if a design
            # contains only side-ground cases. This is rare, but avoids leaving
            # a stale global ground marker in the middle of the drawing.
            set_group_anchor(template, anchor)
        for start, end in route:
            line_count += append_counted_net_line(root, net_class, start, end)
    return line_count


def add_local_power_net(
    root: ET.Element,
    node: str,
    net_class: str,
    raw_points: list[tuple[float, float]],
    junction_counts: dict[tuple[float, float, str], int],
) -> int:
    rail = rail_symbol_for_format(node)
    if rail not in {"vcc", "vee"}:
        return 0
    groups = find_cell_groups(root)
    preferred_name = f"{rail}_{re.sub(r'[^A-Za-z0-9_]+', '_', node).strip('_') or 'rail'}"
    template_name = preferred_name if preferred_name in groups else next((name for name in sorted(groups) if name.startswith(f"{rail}_")), "")
    template = groups.get(template_name)
    if template is None:
        return 0

    existing_anchors = rail_symbol_anchors(root, f"{rail}_")
    power_points = [
        point
        for point in sorted(raw_points)
        if not is_existing_rail_anchor(point, existing_anchors)
    ]
    if not power_points:
        return 0

    line_count = 0
    clone_count = 0
    for point in power_points:
        anchor = (point[0], point[1] - 30.0 if rail == "vcc" else point[1] + 30.0)
        if clone_count == 0:
            set_group_anchor(template, anchor)
        else:
            clone_power_symbol(root, template, rail, clone_count, anchor)
        clone_count += 1
        line_count += append_counted_net_line(root, net_class, point, anchor)
        junction_counts[(point[0], point[1], net_class)] += 1
    return line_count


def add_rf_mixed_custom_net(
    root: ET.Element,
    node: str,
    net_class: str,
    raw_points: list[tuple[float, float]],
    junction_counts: dict[tuple[float, float, str], int],
) -> int | None:
    lower = node.lower()
    line_count = 0
    if rail_symbol_for_format(lower) == "gnd":
        bus_y = max(point[1] for point in raw_points)
        detour_x = 1160.0
        bus_xs: set[float] = set()
        for point in raw_points:
            # The reference divider ground pin sits above the LPF input line.
            # Drop it through a left-side corridor instead of drawing a
            # vertical ground branch through the comparator input trace.
            if point[0] > 880.0 and point[1] < bus_y - 80.0:
                elbow = (detour_x, point[1])
                drop = (detour_x, bus_y)
                line_count += append_counted_net_line(root, net_class, point, elbow)
                line_count += append_counted_net_line(root, net_class, elbow, drop)
                junction_counts[(drop[0], drop[1], net_class)] += 1
                bus_xs.add(drop[0])
            else:
                bus_point = (point[0], bus_y)
                if not nearly_equal(point[1], bus_y):
                    line_count += append_counted_net_line(root, net_class, point, bus_point)
                    junction_counts[(bus_point[0], bus_point[1], net_class)] += 1
                bus_xs.add(bus_point[0])
        for start_x, end_x in zip(sorted(bus_xs), sorted(bus_xs)[1:]):
            line_count += append_counted_net_line(root, net_class, (start_x, bus_y), (end_x, bus_y))
        return line_count

    if lower in {"vgate", "vbias"}:
        # Keep the RF gate-bias ladder on a side bus so it does not cut through
        # the input matching network or the gate signal path.
        bus_x = max(12.0, min(point[0] for point in raw_points) - 60.0)
        ys = sorted(set(point[1] for point in raw_points))
        for point in raw_points:
            bus_point = (bus_x, point[1])
            line_count += append_counted_net_line(root, net_class, point, bus_point)
            junction_counts[(bus_point[0], bus_point[1], net_class)] += 1
        for start_y, end_y in zip(ys, ys[1:]):
            line_count += append_counted_net_line(root, net_class, (bus_x, start_y), (bus_x, end_y))
        return line_count

    if lower in {"vth", "ref"} and len(raw_points) >= 3:
        # Route the threshold reference on a side bus between the divider and
        # the comparator. The divider stays compact near VDD, while the bus
        # stops above the LPF input line so the two comparator inputs do not
        # cross each other.
        divider_x = min(point[0] for point in raw_points)
        bus_x = divider_x - 30.0
        bus_ys = sorted(set(point[1] for point in raw_points))
        for start_y, end_y in zip(bus_ys, bus_ys[1:]):
            line_count += append_counted_net_line(root, net_class, (bus_x, start_y), (bus_x, end_y))
        for point in raw_points:
            bus_point = (bus_x, point[1])
            if not nearly_equal(point[0], bus_x):
                line_count += append_counted_net_line(root, net_class, point, bus_point)
            junction_counts[(bus_point[0], bus_point[1], net_class)] += 1
        return line_count

    if lower in {"rf_in", "match", "gate", "drain", "rf_amp", "det_in"} and len(raw_points) >= 2:
        # RF front-end horizontal two-terminal parts should sit directly on
        # the signal lane; shunt/load branches tap vertically from that lane.
        signal_candidates = [point[1] for point in raw_points if point[1] < 300.0]
        signal_y = max(signal_candidates) if signal_candidates else min(point[1] for point in raw_points)
        return add_inline_horizontal_net(root, net_class, raw_points, junction_counts, signal_y)

    if lower in {"env", "det", "det_out", "rect", "rect_out"} and len(raw_points) >= 3:
        # Envelope detector output is a left-to-right signal rail. Keep the
        # horizontal LPF resistor inline; detector storage parts hang below.
        signal_candidates = [point[1] for point in raw_points if point[1] < 300.0]
        signal_y = max(signal_candidates) if signal_candidates else min(point[1] for point in raw_points)
        return add_inline_horizontal_net(root, net_class, raw_points, junction_counts, signal_y)

    if lower in {"lpf", "lpf_out", "adc", "adc_in"} and len(raw_points) >= 3:
        # The post-LPF node should run directly from the resistor output into
        # the comparator input. The shunt capacitor is only a vertical tap.
        signal_candidates = [point[1] for point in raw_points if point[1] < 300.0]
        signal_y = max(signal_candidates) if signal_candidates else min(point[1] for point in raw_points)
        return add_inline_horizontal_net(root, net_class, raw_points, junction_counts, signal_y)

    return None


def add_side_ground_symbols_net(
    root: ET.Element,
    net_class: str,
    raw_points: list[tuple[float, float]],
) -> int:
    line_count = 0
    used: set[tuple[float, float]] = set()
    for point in sorted(raw_points):
        anchor = (point[0] + 30.0, point[1])
        if anchor in used:
            anchor = (anchor[0] + 18.0, anchor[1])
        used.add(anchor)
        line_count += append_counted_net_line(root, net_class, point, anchor)
        append_side_ground_symbol(root, net_class, anchor)
    return line_count


def add_vertical_bus_net(
    root: ET.Element,
    net_class: str,
    raw_points: list[tuple[float, float]],
    junction_counts: dict[tuple[float, float, str], int],
    bus_x: float,
) -> int:
    line_count = 0
    bus_points: list[tuple[float, float]] = []
    for point in raw_points:
        bus_point = (bus_x, point[1])
        if not nearly_equal(point[0], bus_x):
            line_count += append_counted_net_line(root, net_class, point, bus_point)
        junction_counts[(bus_point[0], bus_point[1], net_class)] += 1
        bus_points.append(bus_point)
    ys = sorted(set(point[1] for point in bus_points))
    for start_y, end_y in zip(ys, ys[1:]):
        line_count += append_counted_net_line(root, net_class, (bus_x, start_y), (bus_x, end_y))
    return line_count


def add_buck_custom_net(
    root: ET.Element,
    node: str,
    net_class: str,
    raw_points: list[tuple[float, float]],
    junction_counts: dict[tuple[float, float, str], int],
    *,
    input_node: str,
    output_node: str,
) -> int | None:
    lower = node.lower()
    if rail_symbol_for_format(lower) == "gnd":
        return add_side_ground_symbols_net(root, net_class, raw_points)
    if lower in {input_node.lower(), "vin"}:
        return add_inline_horizontal_net(root, net_class, raw_points, junction_counts, 100.0)
    if lower in {"gate", "vgate"}:
        return add_inline_horizontal_net(root, net_class, raw_points, junction_counts, 175.0)
    if lower in {output_node.lower(), "out", "vout", "sw"}:
        return add_inline_horizontal_net(root, net_class, raw_points, junction_counts, 200.0)
    return None


def add_cascode_custom_net(
    root: ET.Element,
    node: str,
    net_class: str,
    raw_points: list[tuple[float, float]],
    junction_counts: dict[tuple[float, float, str], int],
    *,
    input_node: str,
    output_node: str,
) -> int | None:
    lower = node.lower()
    if rail_symbol_for_format(lower) == "gnd":
        return add_side_ground_symbols_net(root, net_class, raw_points)
    if lower in {input_node.lower(), "in"}:
        return add_inline_horizontal_net(root, net_class, raw_points, junction_counts, 255.0)
    if lower in {output_node.lower(), "out", "no"}:
        return add_inline_horizontal_net(root, net_class, raw_points, junction_counts, 150.0)
    if lower in {"nd", "ns"}:
        bus_x = raw_points[0][0]
        return add_vertical_bus_net(root, net_class, raw_points, junction_counts, bus_x)
    return None


def add_side_power_label_net(
    root: ET.Element,
    node: str,
    net_class: str,
    raw_points: list[tuple[float, float]],
) -> int:
    line_count = 0
    label = node.upper()
    used: set[tuple[float, float]] = set()
    for point in sorted(raw_points):
        end = (point[0] + 28.0, point[1])
        if end in used:
            end = (end[0] + 18.0, end[1])
        used.add(end)
        line_count += append_counted_net_line(root, net_class, point, end)
        append_net_label(root, net_class, label, end[0] + 4.0, end[1] - 4.0)
    return line_count


def ring_stub_endpoint(point: tuple[float, float]) -> tuple[float, float]:
    x, y = point
    if x < 120.0:
        return (x - 28.0, y)
    if x > 640.0:
        return (x + 28.0, y)
    if y < 100.0:
        return (x - 28.0, y)
    if y <= 150.0:
        return (x + 28.0, y)
    if 220.0 <= y <= 240.0:
        return (x, y - 26.0)
    if 245.0 <= y <= 285.0:
        return (x - 28.0, y)
    return (x + 28.0, y)


def add_ring_oscillator_custom_net(
    root: ET.Element,
    node: str,
    net_class: str,
    raw_points: list[tuple[float, float]],
) -> int | None:
    rail = rail_symbol_for_format(node)
    if rail == "gnd":
        return add_side_ground_symbols_net(root, net_class, raw_points)
    if rail in {"vcc", "vee"}:
        return add_side_power_label_net(root, node, net_class, raw_points)

    line_count = 0
    for point in sorted(raw_points):
        end = ring_stub_endpoint(point)
        line_count += append_counted_net_line(root, net_class, point, end)
        label_x = end[0] + (4.0 if end[0] >= point[0] else -24.0)
        append_net_label(root, net_class, node, label_x, end[1] - 4.0)
    return line_count


def add_linear_chain_custom_net(
    root: ET.Element,
    profile: str,
    node: str,
    net_class: str,
    raw_points: list[tuple[float, float]],
    junction_counts: dict[tuple[float, float, str], int],
) -> int | None:
    lower = node.lower()
    line_count = 0

    if profile == "single_stage_amplifier" and lower in {"outp", "outn"} and len(raw_points) >= 3:
        bus_y = snap(max(35.0, min(point[1] for point in raw_points) - 95.0))
        bus_points: list[tuple[float, float]] = []
        leftmost_x = min(point[0] for point in raw_points)
        for point in raw_points:
            if nearly_equal(point[0], leftmost_x):
                entry_point = (point[0] + 25.0, point[1])
                bus_point = (entry_point[0], bus_y)
                line_count += append_counted_net_line(root, net_class, point, entry_point)
                junction_counts[(entry_point[0], entry_point[1], net_class)] += 1
                if not nearly_equal(entry_point[1], bus_y):
                    line_count += append_counted_net_line(root, net_class, entry_point, bus_point)
                    junction_counts[(bus_point[0], bus_point[1], net_class)] += 1
            else:
                bus_point = (point[0], bus_y)
                if not nearly_equal(point[1], bus_y):
                    line_count += append_counted_net_line(root, net_class, point, bus_point)
                    junction_counts[(bus_point[0], bus_point[1], net_class)] += 1
            bus_points.append(bus_point)
        xs = sorted(set(point[0] for point in bus_points))
        for start_x, end_x in zip(xs, xs[1:]):
            line_count += append_counted_net_line(root, net_class, (start_x, bus_y), (end_x, bus_y))
        return line_count

    if profile == "single_stage_amplifier" and lower == "dtr" and len(raw_points) == 2:
        upper, lower_point = sorted(raw_points, key=lambda point: point[1])
        detour_x = snap(max(20.0, min(point[0] for point in raw_points) - 130.0))
        detour_y = snap(max(point[1] for point in raw_points) + 30.0)
        upper_elbow = (detour_x, upper[1])
        lower_elbow = (detour_x, detour_y)
        lower_bus = (lower_point[0], detour_y)
        line_count += append_counted_net_line(root, net_class, upper, upper_elbow)
        line_count += append_counted_net_line(root, net_class, upper_elbow, lower_elbow)
        line_count += append_counted_net_line(root, net_class, lower_elbow, lower_bus)
        line_count += append_counted_net_line(root, net_class, lower_bus, lower_point)
        junction_counts[(upper_elbow[0], upper_elbow[1], net_class)] += 1
        junction_counts[(lower_elbow[0], lower_elbow[1], net_class)] += 1
        junction_counts[(lower_bus[0], lower_bus[1], net_class)] += 1
        return line_count

    if profile in {"lna_common_emitter", "single_stage_amplifier"} and lower == "source" and len(raw_points) >= 2:
        bus_x = snap(min(point[0] for point in raw_points) - 12.0)
        bus_points: list[tuple[float, float]] = []
        for point in raw_points:
            bus_point = (bus_x, point[1])
            line_count += append_counted_net_line(root, net_class, point, bus_point)
            junction_counts[(bus_point[0], bus_point[1], net_class)] += 1
            bus_points.append(bus_point)
        ys = sorted(set(point[1] for point in bus_points))
        for start_y, end_y in zip(ys, ys[1:]):
            line_count += append_counted_net_line(root, net_class, (bus_x, start_y), (bus_x, end_y))
        return line_count

    if profile == "single_stage_amplifier" and lower == "bias" and len(raw_points) >= 3:
        bus_y = snap(min(point[1] for point in raw_points) - 45.0)
        bus_points: list[tuple[float, float]] = []
        for point in raw_points:
            bus_point = (point[0], bus_y)
            line_count += append_counted_net_line(root, net_class, point, bus_point)
            junction_counts[(bus_point[0], bus_point[1], net_class)] += 1
            bus_points.append(bus_point)
        xs = sorted(set(point[0] for point in bus_points))
        for start_x, end_x in zip(xs, xs[1:]):
            line_count += append_counted_net_line(root, net_class, (start_x, bus_y), (end_x, bus_y))
        return line_count

    if profile == "signal_chain_comparator" and rail_symbol_for_format(lower) == "gnd":
        bus_y = max(point[1] for point in raw_points)
        detour_x = max(point[0] for point in raw_points) + 145.0
        bus_xs: set[float] = set()
        for point in raw_points:
            if point[0] > 540.0 and point[1] < bus_y - 120.0:
                # The threshold divider lower pin sits next to the comparator
                # output. Escape above the output terminal before dropping to
                # the ground bus so GND never cuts through the OUT_N symbol.
                shoulder_x = min(detour_x - 65.0, point[0] + 80.0)
                escape_y = point[1] - 10.0
                shoulder = (shoulder_x, point[1])
                raised = (shoulder_x, escape_y)
                elbow = (detour_x, escape_y)
                drop = (detour_x, bus_y)
                line_count += append_counted_net_line(root, net_class, point, shoulder)
                line_count += append_counted_net_line(root, net_class, shoulder, raised)
                line_count += append_counted_net_line(root, net_class, raised, elbow)
                line_count += append_counted_net_line(root, net_class, elbow, drop)
                junction_counts[(drop[0], drop[1], net_class)] += 1
                bus_xs.add(drop[0])
            else:
                bus_point = (point[0], bus_y)
                if not nearly_equal(point[1], bus_y):
                    line_count += append_counted_net_line(root, net_class, point, bus_point)
                    junction_counts[(bus_point[0], bus_point[1], net_class)] += 1
                bus_xs.add(bus_point[0])
        ordered_xs = sorted(bus_xs)
        for start_x, end_x in zip(ordered_xs, ordered_xs[1:]):
            line_count += append_counted_net_line(root, net_class, (start_x, bus_y), (end_x, bus_y))
        return line_count

    if profile in {"signal_chain_comparator", "opamp_feedback", "opamp"} and lower in {"vn", "fb"} and len(raw_points) >= 3:
        # Keep the inverting-input feedback ladder on a left-side bus. Routing
        # the divider straight down from the op-amp pin would cut through the
        # non-inverting input trace; routing it at x=45 cuts through the IN port.
        bus_x = max(12.0, min(point[0] for point in raw_points) - 25.0)
        bus_points: list[tuple[float, float]] = []
        for point in raw_points:
            bus_point = (bus_x, point[1])
            line_count += append_counted_net_line(root, net_class, point, bus_point)
            junction_counts[(bus_point[0], bus_point[1], net_class)] += 1
            bus_points.append(bus_point)
        ys = sorted(set(point[1] for point in bus_points))
        for start_y, end_y in zip(ys, ys[1:]):
            line_count += append_counted_net_line(root, net_class, (bus_x, start_y), (bus_x, end_y))
        return line_count

    if lower in {"op_out", "vout"}:
        bus_y = 200.0 if profile == "signal_chain_comparator" or lower == "vout" else 205.0
        bus_points: list[tuple[float, float]] = []
        for point in raw_points:
            if point[1] < bus_y - 70.0:
                elbow_x = max(point[0] + 42.0, 350.0)
                elbow = (elbow_x, point[1])
                bus_point = (elbow_x, bus_y)
                line_count += append_counted_net_line(root, net_class, point, elbow)
                line_count += append_counted_net_line(root, net_class, elbow, bus_point)
            else:
                bus_point = (point[0], bus_y)
                if not nearly_equal(point[1], bus_y):
                    line_count += append_counted_net_line(root, net_class, point, bus_point)
            junction_counts[(bus_point[0], bus_point[1], net_class)] += 1
            bus_points.append(bus_point)
        xs = sorted(set(point[0] for point in bus_points))
        for start_x, end_x in zip(xs, xs[1:]):
            line_count += append_counted_net_line(root, net_class, (start_x, bus_y), (end_x, bus_y))
        return line_count

    if profile == "signal_chain_comparator" and lower in {"filt", "flt"} and len(raw_points) >= 3:
        # Keep the RC output node on the main signal line: Rlp -> comparator
        # is horizontal, while Clp drops as a short shunt branch.
        signal_y = min(point[1] for point in raw_points)
        bus_points: list[tuple[float, float]] = []
        for point in raw_points:
            bus_point = (point[0], signal_y)
            if not nearly_equal(point[1], signal_y):
                line_count += append_counted_net_line(root, net_class, point, bus_point)
            junction_counts[(bus_point[0], bus_point[1], net_class)] += 1
            bus_points.append(bus_point)
        xs = sorted(set(point[0] for point in bus_points))
        for start_x, end_x in zip(xs, xs[1:]):
            line_count += append_counted_net_line(root, net_class, (start_x, signal_y), (end_x, signal_y))
        return line_count

    if profile == "signal_chain_comparator" and lower in {"vth", "ref"} and len(raw_points) >= 3:
        comparator_x = min(point[0] for point in raw_points)
        bus_x = comparator_x
        divider_points = [point for point in raw_points if point[0] > comparator_x + 1.0]
        comparator_points = [point for point in raw_points if point[0] <= comparator_x + 1.0]
        entry_y = min((point[1] for point in divider_points), default=min(point[1] for point in raw_points))
        bus_ys = sorted({entry_y, *[point[1] for point in divider_points if not nearly_equal(point[1], entry_y)]})
        divider_entry_points: set[tuple[float, float]] = set()
        for point in divider_points:
            entry_point = (point[0], entry_y)
            if not nearly_equal(point[1], entry_y):
                line_count += append_counted_net_line(root, net_class, point, entry_point)
                junction_counts[(entry_point[0], entry_point[1], net_class)] += 1
            divider_entry_points.add(entry_point)
        for entry_point in sorted(divider_entry_points):
            bus_point = (bus_x, entry_y)
            line_count += append_counted_net_line(root, net_class, entry_point, bus_point)
            junction_counts[(bus_point[0], bus_point[1], net_class)] += 1
        for point in comparator_points:
            entry_point = (point[0], entry_y)
            bus_point = (bus_x, entry_y)
            line_count += append_counted_net_line(root, net_class, point, entry_point)
            line_count += append_counted_net_line(root, net_class, entry_point, bus_point)
            junction_counts[(entry_point[0], entry_point[1], net_class)] += 1
            junction_counts[(bus_point[0], bus_point[1], net_class)] += 1
        for start_y, end_y in zip(bus_ys, bus_ys[1:]):
            line_count += append_counted_net_line(root, net_class, (bus_x, start_y), (bus_x, end_y))
        return line_count

    return None


def add_ldo_custom_net(
    root: ET.Element,
    node: str,
    net_class: str,
    raw_points: list[tuple[float, float]],
    junction_counts: dict[tuple[float, float, str], int],
    *,
    input_node: str = "",
    output_node: str = "",
    gate_nodes: set[str] | None = None,
) -> int | None:
    lower = node.lower()
    gate_nodes = {item.lower() for item in (gate_nodes or set())}
    line_count = 0

    if lower == input_node.lower():
        bus_y = min(point[1] for point in raw_points) - 35.0
        bus_points: list[tuple[float, float]] = []
        for point in raw_points:
            bus_point = (point[0], bus_y)
            if not nearly_equal(point[1], bus_y):
                line_count += append_counted_net_line(root, net_class, point, bus_point)
            junction_counts[(bus_point[0], bus_point[1], net_class)] += 1
            bus_points.append(bus_point)
        xs = sorted(set(point[0] for point in bus_points))
        for start_x, end_x in zip(xs, xs[1:]):
            line_count += append_counted_net_line(root, net_class, (start_x, bus_y), (end_x, bus_y))
        return line_count

    if lower == "gate" or lower in gate_nodes:
        min_x = min(point[0] for point in raw_points)
        max_x = max(point[0] for point in raw_points)
        bus_x = max(min_x + 45.0, max_x - 45.0)
        bus_points: list[tuple[float, float]] = []
        for point in raw_points:
            bus_point = (bus_x, point[1])
            if not nearly_equal(point[0], bus_x):
                line_count += append_counted_net_line(root, net_class, point, bus_point)
            junction_counts[(bus_point[0], bus_point[1], net_class)] += 1
            bus_points.append(bus_point)
        ys = sorted(set(point[1] for point in bus_points))
        for start_y, end_y in zip(ys, ys[1:]):
            line_count += append_counted_net_line(root, net_class, (bus_x, start_y), (bus_x, end_y))
        return line_count

    if lower == "out" or lower == output_node.lower():
        bus_y = max(180.0, min(point[1] for point in raw_points) + 7.0)
        bus_points: list[tuple[float, float]] = []
        for point in raw_points:
            bus_point = (point[0], bus_y)
            if not nearly_equal(point[1], bus_y):
                line_count += append_counted_net_line(root, net_class, point, bus_point)
            junction_counts[(bus_point[0], bus_point[1], net_class)] += 1
            bus_points.append(bus_point)
        xs = sorted(set(point[0] for point in bus_points))
        for start_x, end_x in zip(xs, xs[1:]):
            line_count += append_counted_net_line(root, net_class, (start_x, bus_y), (end_x, bus_y))
        return line_count

    if lower == "fb":
        left_x = min(point[0] for point in raw_points) - 25.0
        right_x = max(point[0] for point in raw_points) - 35.0
        lower_y = max(point[1] for point in raw_points) + 130.0
        for point in raw_points:
            if point[0] < (left_x + right_x) / 2:
                side_point = (left_x, point[1])
            else:
                side_point = (right_x, point[1])
            lower_point = (side_point[0], lower_y)
            line_count += append_counted_net_line(root, net_class, point, side_point)
            line_count += append_counted_net_line(root, net_class, side_point, lower_point)
            junction_counts[(side_point[0], side_point[1], net_class)] += 1
        line_count += append_counted_net_line(root, net_class, (left_x, lower_y), (right_x, lower_y))
        return line_count

    if lower in {"vref", "ref"}:
        signal_y = sorted(point[1] for point in raw_points)[len(raw_points) // 2]
        return add_inline_horizontal_net(root, net_class, raw_points, junction_counts, signal_y)

    if lower == "tail":
        bus_y = min(max(point[1] for point in raw_points) + 20.0, 285.0)
        bus_points: list[tuple[float, float]] = []
        for point in raw_points:
            bus_point = (point[0], bus_y)
            if not nearly_equal(point[1], bus_y):
                line_count += append_counted_net_line(root, net_class, point, bus_point)
            junction_counts[(bus_point[0], bus_point[1], net_class)] += 1
            bus_points.append(bus_point)
        xs = sorted(set(point[0] for point in bus_points))
        for start_x, end_x in zip(xs, xs[1:]):
            line_count += append_counted_net_line(root, net_class, (start_x, bus_y), (end_x, bus_y))
        return line_count

    return None


def add_blockwise_custom_net(
    root: ET.Element,
    payload: dict[str, object],
    node: str,
    net_class: str,
    raw_points: list[tuple[float, float]],
    junction_counts: dict[tuple[float, float, str], int],
) -> int | None:
    blocks = collect_module_blocks(payload)
    if not blocks:
        return None

    interfaces = payload.get("interfaces", {}) if isinstance(payload.get("interfaces"), dict) else {}
    io = payload.get("io_inference", {}) if isinstance(payload.get("io_inference"), dict) else {}
    output_node = str(interfaces.get("output_node") or io.get("output_node") or "").lower()
    lower = node.lower()

    span_x = max(point[0] for point in raw_points) - min(point[0] for point in raw_points)
    line_count = 0

    if lower == output_node or lower.endswith("_n") or (len(raw_points) >= 4 and span_x > 520.0):
        # High-fanout/cross-module nets read better as local net labels than as
        # one long wire spanning every block. This matches hand-drawn analog
        # schematics and also exposes accidental output-net reuse without
        # turning the whole page into a bus.
        label = node.upper() if lower.endswith("_n") else node
        right_edge = max(float(block["x"]) + float(block["w"]) for block in blocks)
        for point in raw_points:
            if point[0] > right_edge:
                end = (point[0] - 24.0, point[1])
                line_count += append_counted_net_line(root, net_class, point, end)
                append_net_label(root, net_class, label, end[0] - 48.0, end[1] - 4.0)
            else:
                end = (point[0], point[1] - 20.0)
                line_count += append_counted_net_line(root, net_class, point, end)
                append_net_label(root, net_class, label, end[0] + 4.0, end[1] - 3.0)
        return line_count

    return None


def add_formatted_nets(root: ET.Element, payload: dict[str, object]) -> dict[str, object]:
    modules = payload.get("modules", {})
    if not isinstance(modules, dict) or not modules:
        return {"updated": False, "reason": "missing_modules"}
    module = next(iter(modules.values()))
    if not isinstance(module, dict):
        return {"updated": False, "reason": "invalid_module"}

    pins = cell_pin_points(root)
    points_by_bit: dict[int, list[tuple[float, float]]] = defaultdict(list)
    cells = module.get("cells", {})
    if not isinstance(cells, dict):
        return {"updated": False, "reason": "missing_cells"}
    for cell_name, cell in cells.items():
        if not isinstance(cell, dict):
            continue
        cell_pins = pins.get(str(cell_name), {})
        connections = cell.get("connections", {})
        if not isinstance(connections, dict):
            continue
        for pin_name, bits in connections.items():
            point = cell_pins.get(str(pin_name))
            if point is None or not isinstance(bits, list):
                continue
            for bit in bits:
                if isinstance(bit, int):
                    points_by_bit[bit].append(point)

    node_names = bit_to_node_name(payload)
    interfaces = payload.get("interfaces", {}) if isinstance(payload.get("interfaces"), dict) else {}
    io = payload.get("io_inference", {}) if isinstance(payload.get("io_inference"), dict) else {}
    input_node = str(interfaces.get("input_node") or io.get("input_node") or "")
    output_node = str(interfaces.get("output_node") or io.get("output_node") or "")
    intent = payload.get("schematic_intent", {}) if isinstance(payload.get("schematic_intent"), dict) else {}
    aliases = intent.get("net_aliases", {}) if isinstance(intent.get("net_aliases"), dict) else {}
    ldo_gate_nodes = {
        str(node)
        for node in aliases.get("ldo_gate", [])
        if isinstance(node, (str, int, float))
    }
    profile = schematic_profile(payload)

    remove_existing_net_artifacts(root)
    junction_counts: dict[tuple[float, float, str], int] = defaultdict(int)
    line_count = 0

    for bit, raw_points in sorted(points_by_bit.items()):
        if len(raw_points) < 2:
            continue
        node = node_names.get(bit, f"net_{bit}")
        net_class = f"net_{bit}"
        if profile == "buck_converter" and rail_symbol_for_format(node) == "gnd":
            custom_line_count = add_buck_custom_net(
                root,
                node,
                net_class,
                raw_points,
                junction_counts,
                input_node=input_node,
                output_node=output_node,
            )
            if custom_line_count is not None:
                line_count += custom_line_count
                continue
        if profile == "cascode_amplifier" and rail_symbol_for_format(node) == "gnd":
            custom_line_count = add_cascode_custom_net(
                root,
                node,
                net_class,
                raw_points,
                junction_counts,
                input_node=input_node,
                output_node=output_node,
            )
            if custom_line_count is not None:
                line_count += custom_line_count
                continue
        if profile == "ring_oscillator" and rail_symbol_for_format(node) is not None:
            custom_line_count = add_ring_oscillator_custom_net(root, node, net_class, raw_points)
            if custom_line_count is not None:
                line_count += custom_line_count
                continue
        if rail_symbol_for_format(node) == "gnd":
            line_count += add_local_ground_net(root, net_class, raw_points, junction_counts)
            continue
        if rail_symbol_for_format(node) in {"vcc", "vee"}:
            line_count += add_local_power_net(root, node, net_class, raw_points, junction_counts)
            continue
        blockwise_line_count = add_blockwise_custom_net(root, payload, node, net_class, raw_points, junction_counts)
        if blockwise_line_count is not None:
            line_count += blockwise_line_count
            continue
        if profile == "ldo_regulator":
            custom_line_count = add_ldo_custom_net(
                root,
                node,
                net_class,
                raw_points,
                junction_counts,
                input_node=input_node,
                output_node=output_node,
                gate_nodes=ldo_gate_nodes,
            )
            if custom_line_count is not None:
                line_count += custom_line_count
                continue
        if profile == "buck_converter":
            custom_line_count = add_buck_custom_net(
                root,
                node,
                net_class,
                raw_points,
                junction_counts,
                input_node=input_node,
                output_node=output_node,
            )
            if custom_line_count is not None:
                line_count += custom_line_count
                continue
        if profile == "cascode_amplifier":
            custom_line_count = add_cascode_custom_net(
                root,
                node,
                net_class,
                raw_points,
                junction_counts,
                input_node=input_node,
                output_node=output_node,
            )
            if custom_line_count is not None:
                line_count += custom_line_count
                continue
        if profile == "ring_oscillator":
            custom_line_count = add_ring_oscillator_custom_net(root, node, net_class, raw_points)
            if custom_line_count is not None:
                line_count += custom_line_count
                continue
        if profile in {"lna_common_emitter", "single_stage_amplifier"} and node.lower() in {"outp", "outn", "dtr", "source", "bias"}:
            custom_line_count = add_linear_chain_custom_net(root, profile, node, net_class, raw_points, junction_counts)
            if custom_line_count is not None:
                line_count += custom_line_count
                continue
        if profile in {"signal_chain_comparator", "opamp_feedback", "opamp"}:
            custom_line_count = add_linear_chain_custom_net(root, profile, node, net_class, raw_points, junction_counts)
            if custom_line_count is not None:
                line_count += custom_line_count
                continue
        if profile == "rf_mixed_signal":
            custom_line_count = add_rf_mixed_custom_net(root, node, net_class, raw_points, junction_counts)
            if custom_line_count is not None:
                line_count += custom_line_count
                continue
        orientation = net_trunk_orientation(node, raw_points, input_node, output_node)

        if orientation == "horizontal":
            y = snap(sum(point[1] for point in raw_points) / len(raw_points))
            if rail_symbol_for_format(node) == "gnd":
                y = max(point[1] for point in raw_points)
            elif rail_symbol_for_format(node) in {"vcc", "vee"}:
                y = min(point[1] for point in raw_points)
            xs = sorted(set([point[0] for point in raw_points]))
            for point in raw_points:
                if not nearly_equal(point[1], y):
                    append_net_line(root, net_class, point, (point[0], y))
                    junction_counts[(point[0], y, net_class)] += 1
                    line_count += 1
            for start, end in zip(xs, xs[1:]):
                append_net_line(root, net_class, (start, y), (end, y))
                line_count += 1
        else:
            x = snap(sum(point[0] for point in raw_points) / len(raw_points))
            ys = sorted(set([point[1] for point in raw_points]))
            for point in raw_points:
                if not nearly_equal(point[0], x):
                    append_net_line(root, net_class, point, (x, point[1]))
                    junction_counts[(x, point[1], net_class)] += 1
                    line_count += 1
            for start, end in zip(ys, ys[1:]):
                append_net_line(root, net_class, (x, start), (x, end))
                line_count += 1

    circle_count = 0
    for (x, y, net_class), count in junction_counts.items():
        if count < 1:
            continue
        root.append(
            ET.Element(
                f"{{{SVG_NS}}}circle",
                {
                    "cx": format_num(x),
                    "cy": format_num(y),
                    "r": "2",
                    "style": "fill:#000",
                    "class": net_class,
                },
            )
        )
        circle_count += 1
    return {"updated": True, "line_count": line_count, "junction_count": circle_count}


def resize_svg_to_cells(root: ET.Element, margin: float = 22.0) -> None:
    max_x = 0.0
    max_y = 0.0
    for group in find_cell_groups(root).values():
        transform = parse_translate(group.get("transform"))
        if transform is None:
            continue
        width, height = group_dimensions(group)
        max_x = max(max_x, transform[0] + width)
        max_y = max(max_y, transform[1] + height)
    for elem in root:
        if local_name(elem.tag) == "line":
            max_x = max(max_x, parse_float(elem.get("x1")), parse_float(elem.get("x2")))
            max_y = max(max_y, parse_float(elem.get("y1")), parse_float(elem.get("y2")))
    root.set("width", format_num(max_x + margin))
    root.set("height", format_num(max_y + margin))


def ensure_white_background(root: ET.Element) -> dict[str, object]:
    for child in list(root):
        if local_name(child.tag) == "rect" and str(child.get("class") or "") == "page-background":
            root.remove(child)
    background = ET.Element(
        f"{{{SVG_NS}}}rect",
        {
            "class": "page-background",
            "x": "0",
            "y": "0",
            "width": "100%",
            "height": "100%",
            "style": "fill:#fff;stroke:none",
        },
    )
    root.insert(0, background)
    return {"updated": True}


def profile_stage_annotations(profile: str) -> list[dict[str, object]]:
    if profile == "signal_chain_comparator":
        return [
            {"label": "INPUT", "x": 12, "y": 74, "w": 130, "h": 300},
            {"label": "OP-AMP GAIN", "x": 150, "y": 74, "w": 190, "h": 300},
            {"label": "RC FILTER", "x": 348, "y": 74, "w": 116, "h": 300},
            {"label": "THRESHOLD + CMP", "x": 474, "y": 58, "w": 180, "h": 316},
        ]
    if profile == "rf_mixed_signal":
        return [
            {"label": "RF INPUT/MATCH", "x": 12, "y": 68, "w": 250, "h": 330},
            {"label": "LNA", "x": 270, "y": 68, "w": 180, "h": 330},
            {"label": "DETECTOR", "x": 462, "y": 68, "w": 190, "h": 330},
            {"label": "BASEBAND + CMP", "x": 666, "y": 54, "w": 330, "h": 344},
        ]
    if profile == "opamp_feedback":
        return [
            {"label": "INPUT", "x": 12, "y": 78, "w": 120, "h": 270},
            {"label": "FEEDBACK OP-AMP", "x": 144, "y": 78, "w": 210, "h": 270},
            {"label": "OUTPUT LOAD", "x": 364, "y": 78, "w": 160, "h": 270},
        ]
    if profile in {"lna_common_emitter", "single_stage_amplifier"}:
        return [
            {"label": "INPUT MATCH", "x": 12, "y": 68, "w": 170, "h": 330},
            {"label": "BIAS + GAIN", "x": 194, "y": 68, "w": 250, "h": 330},
            {"label": "OUTPUT LOAD", "x": 456, "y": 68, "w": 210, "h": 330},
        ]
    if profile == "ldo_regulator":
        return [
            {"label": "INPUT / PASS", "x": 12, "y": 70, "w": 270, "h": 330},
            {"label": "ERROR + FEEDBACK", "x": 294, "y": 70, "w": 250, "h": 330},
            {"label": "OUTPUT", "x": 556, "y": 70, "w": 180, "h": 330},
        ]
    return []


def module_stage_annotations(payload: dict[str, object]) -> list[dict[str, object]]:
    annotations: list[dict[str, object]] = []
    for block in collect_module_blocks(payload):
        annotations.append(
            {
                "label": str(block.get("label") or module_label(str(block.get("name") or ""))),
                "x": float(block["x"]) - 8.0,
                "y": float(block["y"]) - 8.0,
                "w": float(block["w"]) + 16.0,
                "h": float(block["h"]),
            }
        )
    return annotations


def add_stage_annotations(root: ET.Element, profile: str, payload: dict[str, object] | None = None) -> dict[str, object]:
    annotations = module_stage_annotations(payload) if payload else []
    if not annotations:
        annotations = profile_stage_annotations(profile)
    if not annotations:
        return {"updated": False, "reason": "no_annotations_for_profile"}

    # Insert annotations below symbols but above the white page background.
    insert_at = 0
    for annotation in annotations:
        x = float(annotation["x"])
        y = float(annotation["y"])
        w = float(annotation["w"])
        h = float(annotation["h"])
        rect = ET.Element(
            f"{{{SVG_NS}}}rect",
            {
                "x": format_num(x),
                "y": format_num(y),
                "width": format_num(w),
                "height": format_num(h),
                "rx": "8",
                "class": "layout-stage",
                "style": "stroke:#b8b8b8;stroke-width:1;stroke-dasharray:6 5;fill:none",
            },
        )
        text = ET.Element(
            f"{{{SVG_NS}}}text",
            {
                "x": format_num(x + 8),
                "y": format_num(y + 14),
                "class": "layout-stage-label",
                "style": "font-size:11px;font-weight:bold;fill:#555;stroke:none;font-family:Courier New,monospace",
            },
        )
        text.text = str(annotation["label"])
        root.insert(insert_at, rect)
        root.insert(insert_at + 1, text)
        insert_at += 2
    return {"updated": True, "count": len(annotations)}


def format_signal_chain_schematic(
    svg_path: Path,
    json_path: Path,
    overrides: dict[str, object] | None = None,
) -> dict[str, object]:
    if not svg_path.exists() or not json_path.exists():
        return {"updated": False, "reason": "missing_inputs"}
    payload = json.loads(json_path.read_text(encoding="utf-8-sig"))
    profile = schematic_profile(payload)
    if profile not in SUPPORTED_FORMATTED_PROFILES:
        return {"updated": False, "reason": "profile_not_matched"}

    ET.register_namespace("", SVG_NS)
    ET.register_namespace("s", NETLISTSVG_NS)
    tree = ET.parse(svg_path)
    root = tree.getroot()
    blockwise = apply_blockwise_module_placements(root, payload)
    if not blockwise.get("updated") and not apply_profile_placements(root, payload, profile):
        return {"updated": False, "reason": "unsupported_profile", "profile": profile}
    schematic_overrides = apply_schematic_overrides(root, overrides)
    nets = add_formatted_nets(root, payload)
    resize_svg_to_cells(root)
    annotations = add_stage_annotations(root, profile, payload if blockwise.get("updated") else None)
    background = ensure_white_background(root)
    tree.write(svg_path, encoding="utf-8", xml_declaration=False)
    return {
        "updated": True,
        "profile": profile,
        "blockwise": blockwise,
        "schematic_overrides": schematic_overrides,
        "nets": nets,
        "annotations": annotations,
        "background": background,
    }


def merge_interval_segments(segments: list[tuple[float, float]]) -> list[tuple[float, float]]:
    if not segments:
        return []
    merged: list[tuple[float, float]] = []
    for start, end in sorted((min(a, b), max(a, b)) for a, b in segments):
        if nearly_equal(start, end):
            continue
        if not merged:
            merged.append((start, end))
            continue
        prev_start, prev_end = merged[-1]
        if start <= prev_end + 1e-6:
            merged[-1] = (prev_start, max(prev_end, end))
            continue
        merged.append((start, end))
    return merged


def simplify_net_segments(svg_path: Path) -> dict[str, object]:
    if not svg_path.exists():
        return {"updated": False, "reason": "missing_svg"}

    ET.register_namespace("", SVG_NS)
    ET.register_namespace("s", NETLISTSVG_NS)
    tree = ET.parse(svg_path)
    root = tree.getroot()
    children = list(root)
    preserved: list[ET.Element] = []
    grouped: dict[tuple[str, str, str], list[tuple[float, float, ET.Element]]] = {}
    deduped_circles: dict[tuple[str, str, str, str], ET.Element] = {}
    line_count_before = 0
    zero_length_removed = 0

    for child in children:
        tag = local_name(child.tag)
        net_class = class_token(child, "net_")
        if tag == "line" and net_class:
            line_count_before += 1
            x1 = parse_float(child.get("x1"))
            y1 = parse_float(child.get("y1"))
            x2 = parse_float(child.get("x2"))
            y2 = parse_float(child.get("y2"))
            if nearly_equal(x1, x2) and nearly_equal(y1, y2):
                zero_length_removed += 1
                continue
            if nearly_equal(y1, y2):
                key = (net_class, "h", format_num(y1))
                grouped.setdefault(key, []).append((x1, x2, child))
                continue
            if nearly_equal(x1, x2):
                key = (net_class, "v", format_num(x1))
                grouped.setdefault(key, []).append((y1, y2, child))
                continue
        if tag == "circle" and net_class:
            key = (
                net_class,
                format_num(parse_float(child.get("cx"))),
                format_num(parse_float(child.get("cy"))),
                format_num(parse_float(child.get("r"), 0.0)),
            )
            deduped_circles.setdefault(key, child)
            continue
        preserved.append(child)

    merged_lines: list[ET.Element] = []
    for (net_class, orientation, axis), segments in grouped.items():
        template = segments[0][2]
        merged = merge_interval_segments([(start, end) for start, end, _template in segments])
        for start, end in merged:
            attrs = dict(template.attrib)
            if orientation == "h":
                attrs["x1"] = format_num(start)
                attrs["x2"] = format_num(end)
                attrs["y1"] = axis
                attrs["y2"] = axis
            else:
                attrs["x1"] = axis
                attrs["x2"] = axis
                attrs["y1"] = format_num(start)
                attrs["y2"] = format_num(end)
            merged_lines.append(ET.Element(template.tag, attrs))

    if line_count_before == 0:
        return {"updated": False, "reason": "no_net_lines"}

    for child in list(root):
        root.remove(child)
    for child in preserved:
        root.append(child)
    for child in merged_lines:
        root.append(child)
    for child in deduped_circles.values():
        root.append(child)
    tree.write(svg_path, encoding="utf-8", xml_declaration=False)
    return {
        "updated": True,
        "line_count_before": line_count_before,
        "line_count_after": len(merged_lines),
        "zero_length_removed": zero_length_removed,
        "junction_count_after": len(deduped_circles),
    }


def enforce_io_terminal_sides(svg_path: Path, *, margin: float = 30.0) -> dict[str, object]:
    if not svg_path.exists():
        return {"updated": False, "reason": "missing_svg"}

    ET.register_namespace("", SVG_NS)
    ET.register_namespace("s", NETLISTSVG_NS)
    tree = ET.parse(svg_path)
    root = tree.getroot()

    groups: list[tuple[ET.Element, float, float, float]] = []
    input_group: ET.Element | None = None
    output_group: ET.Element | None = None
    for elem in root.iter():
        if local_name(elem.tag) != "g":
            continue
        cell_id = elem.get("id", "")
        if not cell_id.startswith("cell_"):
            continue
        transform = parse_translate(elem.get("transform"))
        if transform is None:
            continue
        width = parse_float(get_attr(elem, "width"))
        tx, ty = transform
        groups.append((elem, tx, ty, width))
        if cell_id == "cell_IN":
            input_group = elem
        elif cell_id == "cell_OUT":
            output_group = elem

    if not groups:
        return {"updated": False, "reason": "no_cells"}

    main_groups = [entry for entry in groups if entry[0] not in {input_group, output_group}]
    if not main_groups:
        return {"updated": False, "reason": "no_main_cells"}

    min_main_x = min(tx for _, tx, _, _ in main_groups)
    max_main_right = max(tx + width for _, tx, _, width in main_groups)
    updated = False

    if input_group is not None:
        input_width = next(width for elem, _, _, width in groups if elem is input_group)
        target_x = max(12.0, min_main_x - input_width - margin)
        updated = move_terminal_and_edges(root, input_group, target_x) or updated

    if output_group is not None:
        output_width = next(width for elem, _, _, width in groups if elem is output_group)
        target_x = max_main_right + margin
        updated = move_terminal_and_edges(root, output_group, target_x) or updated
        current_width = parse_float(root.get("width"))
        needed_width = target_x + output_width + margin
        if needed_width > current_width:
            root.set("width", format_num(needed_width))
            updated = True

    if updated:
        tree.write(svg_path, encoding="utf-8", xml_declaration=False)
    return {"updated": updated, "margin": margin}


def safe_svg_id(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_:-]+", "_", value.strip())
    return cleaned or "item"


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def component_count_by_module(payload: dict[str, object]) -> dict[str, int]:
    counts: dict[str, int] = defaultdict(int)
    components = payload.get("components", [])
    if not isinstance(components, list):
        return counts
    for comp in components:
        if isinstance(comp, dict):
            name = component_module_name(comp)
            if name and name != "global":
                counts[name] += 1
    return counts


def should_render_module_overview(payload: dict[str, object]) -> bool:
    blocks = collect_module_blocks(payload)
    component_count = len(payload.get("components", [])) if isinstance(payload.get("components"), list) else 0
    return len(blocks) >= 3 and component_count >= 28


def overview_interface_nets(
    blocks: list[dict[str, object]],
    input_node: str,
    output_node: str,
) -> tuple[list[str], dict[str, list[int]]]:
    appearances: dict[str, list[int]] = defaultdict(list)
    for index, block in enumerate(blocks):
        nodes = block.get("nodes", [])
        if not isinstance(nodes, list):
            continue
        for node in nodes:
            node_s = str(node)
            if rail_symbol_for_format(node_s) is not None:
                continue
            appearances[node_s].append(index)

    interface_nets = [
        node
        for node, seen in appearances.items()
        if len(set(seen)) >= 2 or node.lower() in {input_node.lower(), output_node.lower()}
    ]
    interface_nets = sorted(
        interface_nets,
        key=lambda node: (layout_node_rank(node, input_node, output_node), min(appearances[node]), node),
    )
    return interface_nets, appearances


def overview_net_class(node: str) -> str:
    lower = node.lower()
    if lower.endswith("_n") or lower.startswith(("alarm", "reset", "fault")):
        return " signal-active-low"
    if lower.startswith(("rf", "det", "bb", "comp", "cmp")):
        return " signal-domain"
    return ""


def overview_wire(parts: list[str], x1: float, y1: float, x2: float, y2: float, cls: str = "signal-wire") -> None:
    if nearly_equal(x1, x2) and nearly_equal(y1, y2):
        return
    parts.append(
        f'<line class="{cls}" x1="{format_num(x1)}" y1="{format_num(y1)}" '
        f'x2="{format_num(x2)}" y2="{format_num(y2)}" />'
    )


def overview_text(
    parts: list[str],
    x: float,
    y: float,
    text: object,
    cls: str,
    *,
    anchor: str = "middle",
) -> None:
    parts.append(
        f'<text class="{cls}" x="{format_num(x)}" y="{format_num(y)}" text-anchor="{anchor}">{esc(text)}</text>'
    )


def overview_net_tag(parts: list[str], x: float, y: float, label: str, side: str, cls: str = "") -> None:
    tag_w = max(62.0, min(118.0, 10.0 + len(label) * 7.0))
    tag_h = 22.0
    side = side.lower()
    class_name = f"net-tag{cls}"
    if side == "left":
        path_d = (
            f"M{format_num(x)},{format_num(y)} "
            f"L{format_num(x - 12)},{format_num(y - tag_h / 2)} "
            f"H{format_num(x - tag_w)} "
            f"V{format_num(y + tag_h / 2)} "
            f"H{format_num(x - 12)} Z"
        )
        text_x = x - tag_w + 8.0
        anchor = "start"
    elif side == "right":
        path_d = (
            f"M{format_num(x)},{format_num(y)} "
            f"L{format_num(x + 12)},{format_num(y - tag_h / 2)} "
            f"H{format_num(x + tag_w)} "
            f"V{format_num(y + tag_h / 2)} "
            f"H{format_num(x + 12)} Z"
        )
        text_x = x + tag_w - 8.0
        anchor = "end"
    elif side == "top":
        path_d = (
            f"M{format_num(x)},{format_num(y)} "
            f"L{format_num(x - tag_w / 2)},{format_num(y - 12)} "
            f"V{format_num(y - tag_h)} "
            f"H{format_num(x + tag_w / 2)} "
            f"V{format_num(y - 12)} Z"
        )
        text_x = x
        anchor = "middle"
    else:
        path_d = (
            f"M{format_num(x)},{format_num(y)} "
            f"L{format_num(x - tag_w / 2)},{format_num(y + 12)} "
            f"V{format_num(y + tag_h)} "
            f"H{format_num(x + tag_w / 2)} "
            f"V{format_num(y + 12)} Z"
        )
        text_x = x
        anchor = "middle"
    parts.append(f'<path class="{class_name}" d="{path_d}" />')
    text_y = y + 4.0 if side in {"left", "right"} else (y - 10.0 if side == "top" else y + 20.0)
    overview_text(parts, text_x, text_y, label, "net-tag-text", anchor=anchor)


def render_module_overview_svg(
    svg_path: Path,
    json_path: Path,
    *,
    flat_svg_path: Path | None = None,
    details_dir: Path | None = None,
) -> dict[str, object]:
    payload = json.loads(json_path.read_text(encoding="utf-8-sig"))
    blocks = collect_module_blocks(payload)
    if not should_render_module_overview(payload):
        return {"updated": False, "reason": "not_partitioned_or_too_small"}

    interfaces = payload.get("interfaces", {}) if isinstance(payload.get("interfaces"), dict) else {}
    io = payload.get("io_inference", {}) if isinstance(payload.get("io_inference"), dict) else {}
    input_node = str(interfaces.get("input_node") or io.get("input_node") or "in")
    output_node = str(interfaces.get("output_node") or io.get("output_node") or "out")
    interface_nets, appearances = overview_interface_nets(blocks, input_node, output_node)
    counts = component_count_by_module(payload)

    block_w = 270.0
    gap = 150.0
    block_x0 = 126.0
    block_y = 132.0
    port_step = 30.0
    block_h = max(250.0, 110.0 + max(1, len(interface_nets)) * port_step)
    legend_y = block_y + block_h + 74.0
    legend_rows = max(1, len(interface_nets))
    svg_w = block_x0 + len(blocks) * block_w + max(0, len(blocks) - 1) * gap + 170.0
    svg_h = legend_y + 62.0 + legend_rows * 18.0

    positioned: list[dict[str, object]] = []
    for index, block in enumerate(blocks):
        positioned.append(
            {
                **block,
                "x": block_x0 + index * (block_w + gap),
                "y": block_y,
                "w": block_w,
                "h": block_h,
                "index": index,
            }
        )

    lane_y: dict[str, float] = {}
    lane_top = block_y + 70.0
    for index, node in enumerate(interface_nets):
        lane_y[node] = lane_top + index * port_step

    parts: list[str] = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="{SVG_NS}" width="{format_num(svg_w)}" height="{format_num(svg_h)}" '
        'viewBox="0 0 '
        f'{format_num(svg_w)} {format_num(svg_h)}" data-actoviq-view="module-overview">',
        "<style>",
        ".page-bg{fill:#fff}",
        ".title{font:700 18px Georgia,serif;fill:#222}",
        ".subtitle{font:12px Courier New,monospace;fill:#666}",
        ".module-box{fill:#fff;stroke:#222;stroke-width:1.4}",
        ".module-label{font:700 13px Courier New,monospace;fill:#222}",
        ".module-meta{font:11px Courier New,monospace;fill:#666}",
        ".port-dot{fill:#111;stroke:none}",
        ".port-label{font:10px Courier New,monospace;fill:#333}",
        ".net-tag{fill:#fff;stroke:#111;stroke-width:1.2}",
        ".net-tag.signal-active-low{stroke-dasharray:5 3}",
        ".net-tag.signal-domain{stroke-width:1.5}",
        ".net-tag.rail{fill:#f8f8f8}",
        ".net-tag-text{font:700 10px Courier New,monospace;fill:#222}",
        ".connection-title{font:700 12px Courier New,monospace;fill:#222}",
        ".connection-row{font:11px Courier New,monospace;fill:#444}",
        ".terminal{fill:#fff;stroke:#111;stroke-width:1.4}",
        ".warning{font:11px Courier New,monospace;fill:#8a4b00}",
        "</style>",
        f'<rect class="page-bg" x="0" y="0" width="{format_num(svg_w)}" height="{format_num(svg_h)}" />',
    ]
    overview_text(parts, 28, 32, "Partitioned Circuit Overview", "title", anchor="start")
    overview_text(
        parts,
        28,
        52,
        "Label-only top sheet: modules are independent and connect only by identical net labels.",
        "subtitle",
        anchor="start",
    )

    for block in positioned:
        index = int(block["index"])
        x = float(block["x"])
        y = float(block["y"])
        w = float(block["w"])
        h = float(block["h"])
        name = str(block["name"])
        block_nodes = {str(node) for node in block.get("nodes", []) if isinstance(block.get("nodes"), list)}
        parts.append(
            f'<rect id="module_{safe_svg_id(name)}" class="module-box" x="{format_num(x)}" y="{format_num(y)}" '
            f'width="{format_num(w)}" height="{format_num(h)}" rx="10" />'
        )
        overview_text(parts, x + 14.0, y + 24.0, module_label(name), "module-label", anchor="start")
        overview_text(parts, x + 14.0, y + 44.0, f"{counts.get(name, 0)} primitives", "module-meta", anchor="start")

        if any(rail_symbol_for_format(node) == "vcc" for node in block_nodes):
            overview_net_tag(parts, x + w / 2.0, y, "vdd", "top", " rail")
        if any(rail_symbol_for_format(node) == "gnd" for node in block_nodes):
            overview_net_tag(parts, x + w / 2.0, y + h, "0", "bottom", " rail")

        for node in interface_nets:
            if node not in block_nodes:
                continue
            seen = appearances.get(node, [])
            has_left = node.lower() == input_node.lower() or any(other < index for other in seen)
            has_right = node.lower() == output_node.lower() or any(other > index for other in seen)
            y_port = lane_y[node]
            if has_left:
                overview_net_tag(parts, x, y_port, node, "left", overview_net_class(node))
            if has_right:
                overview_net_tag(parts, x + w, y_port, node, "right", overview_net_class(node))

    warnings: list[str] = []
    output_seen = sorted(set(appearances.get(output_node, [])))
    if len(output_seen) > 1 and output_seen[-1] != output_seen[0]:
        warnings.append(
            f"Output net {output_node} appears in multiple modules ({', '.join(str(i + 1) for i in output_seen)}); "
            "this often means the final output name was reused as an intermediate net."
        )

    first_input = next(iter(sorted(set(appearances.get(input_node, [])))), None)
    if first_input is not None:
        anchor_x = float(positioned[first_input]["x"]) - 112.0
        anchor_y = lane_y.get(input_node, block_y + 70.0)
        overview_net_tag(parts, anchor_x, anchor_y, "IN", "right", overview_net_class(input_node))

    last_output = next(
        iter(reversed(sorted(set(appearances.get(output_node, []))))),
        None,
    )
    if last_output is not None:
        anchor_x = float(positioned[last_output]["x"]) + float(positioned[last_output]["w"]) + 112.0
        anchor_y = lane_y.get(output_node, block_y + 70.0)
        overview_net_tag(
            parts,
            anchor_x,
            anchor_y,
            "OUT_N" if output_node.lower().endswith("_n") else "OUT",
            "left",
            overview_net_class(output_node),
        )

    overview_text(parts, 28.0, legend_y, "Net-label connections", "connection-title", anchor="start")
    for row_index, node in enumerate(interface_nets):
        seen = sorted(set(appearances.get(node, [])))
        module_names = [
            module_label(str(positioned[index]["name"]))
            for index in seen
            if 0 <= index < len(positioned)
        ]
        connection = " ; ".join(module_names) if module_names else "(external)"
        overview_text(
            parts,
            28.0,
            legend_y + 20.0 + row_index * 18.0,
            f"{node}: {connection}",
            "connection-row",
            anchor="start",
        )

    if warnings:
        warn_y = legend_y + 28.0 + legend_rows * 18.0
        for index, warning in enumerate(warnings[:3]):
            overview_text(parts, 28.0, warn_y + index * 16.0, f"Layout warning: {warning}", "warning", anchor="start")

    footer_items: list[str] = []
    if details_dir:
        footer_items.append(f"Module details: {details_dir.name}/")
    if flat_svg_path:
        footer_items.append(f"Flat debug: {flat_svg_path.name}")
    if footer_items:
        overview_text(parts, svg_w - 28.0, svg_h - 18.0, " | ".join(footer_items), "subtitle", anchor="end")

    parts.append("</svg>")
    svg_path.write_text("\n".join(parts), encoding="utf-8")
    return {
        "updated": True,
        "view": "module-overview",
        "blocks": len(blocks),
        "interface_nets": interface_nets,
        "label_only": True,
        "wire_segments": 0,
        "warnings": warnings,
        "flat_svg_path": str(flat_svg_path) if flat_svg_path else None,
        "details_dir": str(details_dir) if details_dir else None,
    }


def first_module_payload(payload: dict[str, object]) -> dict[str, object]:
    modules = payload.get("modules", {})
    if not isinstance(modules, dict) or not modules:
        return {}
    first = next(iter(modules.values()))
    return first if isinstance(first, dict) else {}


def terminal_cell(label: str, bit: int, *, direction: str, suffix: str = "") -> dict[str, object]:
    if direction == "input":
        return {
            "type": "$_inputExt_",
            "port_directions": {"Y": "output"},
            "connections": {"Y": [bit]},
            "attributes": {
                "ref": label,
                "org.eclipse.elk.layered.layerConstraint": "FIRST",
            },
        }
    return {
        "type": "$_outputExt_",
        "port_directions": {"A": "input"},
        "connections": {"A": [bit]},
        "attributes": {
            "ref": label if suffix == "" else f"{label}",
            "org.eclipse.elk.layered.layerConstraint": "LAST",
        },
    }


def cell_connection_bits(cell: dict[str, object]) -> set[int]:
    bits: set[int] = set()
    connections = cell.get("connections", {})
    if not isinstance(connections, dict):
        return bits
    for values in connections.values():
        if not isinstance(values, list):
            continue
        for bit in values:
            if isinstance(bit, int):
                bits.add(bit)
    return bits


def add_unique_cell(cells: dict[str, object], name: str, cell: dict[str, object]) -> None:
    candidate = safe_svg_id(name)
    base = candidate
    suffix = 2
    while candidate in cells:
        candidate = f"{base}_{suffix}"
        suffix += 1
    cells[candidate] = cell


def module_interface_summary(
    blocks: list[dict[str, object]],
    input_node: str,
    output_node: str,
) -> tuple[dict[str, list[int]], set[str]]:
    appearances: dict[str, list[int]] = defaultdict(list)
    for index, block in enumerate(blocks):
        nodes = block.get("nodes", [])
        if not isinstance(nodes, list):
            continue
        for node in nodes:
            node_s = str(node)
            if rail_symbol_for_format(node_s) is None:
                appearances[node_s].append(index)
    interface_nodes = {
        node
        for node, seen in appearances.items()
        if len(set(seen)) >= 2 or node.lower() in {input_node.lower(), output_node.lower()}
    }
    return appearances, interface_nodes


def block_io_nodes(
    block: dict[str, object],
    index: int,
    appearances: dict[str, list[int]],
    interface_nodes: set[str],
    input_node: str,
    output_node: str,
) -> tuple[list[str], list[str]]:
    nodes = block.get("nodes", [])
    if not isinstance(nodes, list):
        return [], []
    inputs: list[str] = []
    outputs: list[str] = []
    for raw_node in nodes:
        node = str(raw_node)
        if node not in interface_nodes:
            continue
        seen = appearances.get(node, [])
        lower = node.lower()
        if lower == input_node.lower() or any(other < index for other in seen):
            inputs.append(node)
        if lower == output_node.lower() or any(other > index for other in seen):
            outputs.append(node)
    inputs = sorted(dict.fromkeys(inputs), key=lambda item: (layout_node_rank(item, input_node, output_node), item))
    outputs = sorted(dict.fromkeys(outputs), key=lambda item: (layout_node_rank(item, input_node, output_node), item))
    return inputs, outputs


def should_emit_terminal_port(block: dict[str, object], node: str, global_input: str, global_output: str) -> bool:
    return bool(str(node).strip())


def build_module_detail_payload(
    payload: dict[str, object],
    block: dict[str, object],
    index: int,
    blocks: list[dict[str, object]],
) -> tuple[dict[str, object] | None, dict[str, object]]:
    module = first_module_payload(payload)
    full_cells = module.get("cells", {}) if isinstance(module, dict) else {}
    full_netnames = module.get("netnames", {}) if isinstance(module, dict) else {}
    if not isinstance(full_cells, dict) or not isinstance(full_netnames, dict):
        return None, {"reason": "invalid_netlistsvg_payload"}

    component_names = {
        str(name)
        for name in block.get("component_names", [])
        if str(name).strip()
    }
    if not component_names:
        return None, {"reason": "empty_module_components"}

    cells: dict[str, object] = {
        name: copy.deepcopy(cell)
        for name, cell in full_cells.items()
        if name in component_names and isinstance(cell, dict)
    }
    if not cells:
        return None, {"reason": "no_cells_for_module"}

    used_bits: set[int] = set()
    for cell in cells.values():
        if isinstance(cell, dict):
            used_bits.update(cell_connection_bits(cell))

    for name, cell in full_cells.items():
        if not isinstance(cell, dict) or name in cells:
            continue
        if not name.startswith(("gnd_", "vcc_", "vdd_", "vee_", "vss_")):
            continue
        if cell_connection_bits(cell) & used_bits:
            cells[name] = copy.deepcopy(cell)

    netnames: dict[str, object] = {}
    bit_to_node: dict[int, str] = {}
    for node, record in full_netnames.items():
        if not isinstance(record, dict):
            continue
        bits = record.get("bits", [])
        if not isinstance(bits, list):
            continue
        record_bits = {bit for bit in bits if isinstance(bit, int)}
        if used_bits & record_bits:
            netnames[str(node)] = copy.deepcopy(record)
            for bit in record_bits:
                bit_to_node[bit] = str(node)

    interfaces = payload.get("interfaces", {}) if isinstance(payload.get("interfaces"), dict) else {}
    io = payload.get("io_inference", {}) if isinstance(payload.get("io_inference"), dict) else {}
    global_input = str(interfaces.get("input_node") or io.get("input_node") or "")
    global_output = str(interfaces.get("output_node") or io.get("output_node") or "")
    appearances, interface_nodes = module_interface_summary(blocks, global_input, global_output)
    module_inputs, module_outputs = block_io_nodes(
        block,
        index,
        appearances,
        interface_nodes,
        global_input,
        global_output,
    )

    for node in [*module_inputs, *module_outputs]:
        record = netnames.get(node)
        if not isinstance(record, dict):
            continue
        bits = record.get("bits", [])
        if not isinstance(bits, list) or not bits or not isinstance(bits[0], int):
            continue
        record["hide_name"] = 0
        label = "OUT_N" if node.lower() == global_output.lower() and node.lower().endswith("_n") else node
        if not should_emit_terminal_port(block, node, global_input, global_output):
            continue
        if node in module_inputs:
            add_unique_cell(cells, f"PORT_IN_{node}", terminal_cell(label, bits[0], direction="input"))
        if node in module_outputs and node not in module_inputs:
            add_unique_cell(cells, f"PORT_OUT_{node}", terminal_cell(label, bits[0], direction="output"))

    detail_components = [
        copy.deepcopy(comp)
        for comp in payload.get("components", [])
        if isinstance(comp, dict) and str(comp.get("name") or "") in component_names
    ]
    detail_payload = copy.deepcopy(payload)
    detail_payload["creator"] = "actoviq module detail renderer"
    detail_payload["view"] = "module-detail"
    detail_payload["components"] = detail_components
    detail_payload["schematic_blocks"] = []
    detail_payload["interfaces"] = {
        "input_node": module_inputs[0] if module_inputs else "",
        "output_node": module_outputs[-1] if module_outputs else "",
        "power_nodes": [
            node for node in netnames if rail_symbol_for_format(node) in {"vcc", "vee"}
        ],
        "ground_nodes": [
            node for node in netnames if rail_symbol_for_format(node) == "gnd"
        ],
    }
    detail_payload["io_inference"] = {
        "input_node": module_inputs[0] if module_inputs else "",
        "output_node": module_outputs[-1] if module_outputs else "",
        "explicit_input_node": None,
        "explicit_output_node": None,
    }
    if isinstance(detail_payload.get("schematic_intent"), dict):
        detail_payload["schematic_intent"] = {
            **detail_payload["schematic_intent"],
            "profile": "",
            "module_detail": str(block.get("name") or ""),
        }
    detail_payload["modules"] = {
        safe_svg_id(str(block.get("name") or "module")): {
            "ports": {},
            "cells": cells,
            "netnames": netnames,
        }
    }
    return detail_payload, {
        "module": str(block.get("name") or ""),
        "input_nodes": module_inputs,
        "output_nodes": module_outputs,
        "component_count": len(detail_components),
        "net_count": len(netnames),
    }


DETAIL_LAYOUT_PRESETS: dict[str, dict[str, tuple[float, float]]] = {
    "rf_frontend": {
        "PORT_IN_in": (18, 230),
        "CIN": (82, 225),
        "RB1": (170, 88),
        "RB2": (170, 286),
        "Q1": (300, 224),
        "LCHOKE": (304, 94),
        "RE": (304, 310),
        "CE": (382, 314),
        "COUT": (430, 220),
        "RLOAD1": (512, 292),
        "PORT_OUT_rf_out": (590, 230),
        "vcc_vdd": (298, 22),
        "gnd_0": (306, 410),
    },
    "envelope_detector": {
        "PORT_IN_rf_out": (18, 150),
        "CCPL": (90, 145),
        "D1": (190, 142),
        "RLOAD2": (290, 186),
        "CLOAD": (352, 186),
        "PORT_OUT_det_out": (430, 150),
        "gnd_0": (320, 278),
    },
    "baseband_conditioning": {
        "PORT_IN_det_out": (18, 250),
        "Rin": (88, 245),
        "Rbias1": (168, 306),
        "Q2": (270, 210),
        "Q3": (386, 210),
        "Re_tail": (326, 312),
        "I_tail": (326, 382),
        "Rf": (376, 84),
        "Rg": (424, 306),
        "Rsk1": (540, 245),
        "Csk1": (616, 306),
        "Rsk2": (690, 245),
        "Csk2": (766, 306),
        "Q4": (870, 220),
        "Rload_bb": (948, 306),
        "PORT_OUT_bb_out": (1040, 250),
        "Rdec": (182, 80),
        "Cdec": (254, 118),
        "vcc_vdd": (182, 22),
        "vcc_bb_vdd": (300, 22),
        "gnd_0": (520, 432),
    },
    "window_comparator": {
        "PORT_IN_bb_out": (18, 260),
        "Rdiv1": (160, 86),
        "Rdiv2": (160, 186),
        "Rdiv3": (160, 306),
        "Q5": (360, 180),
        "Q6": (360, 330),
        "R1": (448, 108),
        "R2": (448, 258),
        "Rref1": (252, 380),
        "Rpull": (660, 104),
        "D2": (588, 180),
        "D3": (588, 330),
        "PORT_OUT_alarm_n": (760, 260),
        "vcc_vdd": (540, 28),
        "gnd_0": (300, 438),
    },
    "opamp_input_active_load": {
        "PORT_IN_amp_out": (18, 255),
        "Mog1": (178, 244),
        "Mog2": (338, 244),
        "Mog3": (258, 370),
        "Rog1": (82, 358),
        "Mog4": (178, 112),
        "Mog5": (338, 112),
        "PORT_OUT_og_ref": (520, 224),
        "PORT_OUT_og_d2": (520, 284),
        "PORT_OUT_og_bias": (520, 360),
        "vcc_vdd": (258, 24),
        "gnd_0": (258, 494),
    },
    "opamp_output_compensation": {
        "PORT_IN_og_d2": (18, 130),
        "PORT_IN_og_bias": (18, 230),
        "Mog7": (170, 92),
        "Mog6": (170, 238),
        "Cog1": (284, 170),
        "PORT_OUT_og_out": (390, 180),
        "vcc_vdd": (170, 24),
        "gnd_0": (170, 348),
    },
    "opamp_feedback_network": {
        "PORT_IN_og_out": (18, 92),
        "Rog4": (118, 92),
        "Rog3": (226, 92),
        "PORT_OUT_filt_in": (338, 92),
        "Rog2": (226, 188),
        "PORT_IN_og_ref": (18, 188),
        "gnd_0": (226, 270),
    },
    "threshold_high_trip_core": {
        "PORT_IN_filt_out": (18, 258),
        "PORT_IN_tc_vthh": (18, 338),
        "Mtc1": (176, 246),
        "Mtc2": (334, 246),
        "Mtc3": (256, 396),
        "Mtc4": (176, 108),
        "Mtc5": (334, 108),
        "Rtc5": (492, 96),
        "Mtc6": (492, 246),
        "Mtc7": (660, 280),
        "PORT_OUT_tc_out1": (790, 244),
        "PORT_OUT_alarm_int": (790, 328),
        "PORT_OUT_tc_bias": (790, 388),
        "PORT_OUT_tc_d2": (790, 448),
        "vcc_vdd": (336, 24),
        "gnd_0": (336, 520),
    },
    "threshold_low_trip_core": {
        "PORT_IN_tc_vthl": (18, 252),
        "PORT_IN_filt_out": (18, 336),
        "PORT_IN_tc_bias": (18, 420),
        "Mtc8": (176, 246),
        "Mtc9": (334, 246),
        "Mtc10": (256, 396),
        "Mtc11": (176, 108),
        "Mtc12": (334, 108),
        "Rtc6": (492, 96),
        "Mtc13": (492, 246),
        "Mtc14": (660, 280),
        "PORT_OUT_tc_out2": (790, 244),
        "PORT_OUT_alarm_int": (790, 328),
        "PORT_OUT_tc_bias": (790, 388),
        "PORT_OUT_tc_d4": (790, 448),
        "vcc_vdd": (336, 24),
        "gnd_0": (336, 520),
    },
    "output_driver": {
        "PORT_IN_alarm_int": (18, 184),
        "Mod1": (160, 184),
        "Rod1": (160, 304),
        "Mod2": (316, 184),
        "Rod2": (316, 74),
        "PORT_OUT_alarm_n": (460, 184),
        "vcc_vdd": (316, 20),
        "gnd_0": (160, 400),
    },
}


def apply_detail_layout_hints(detail_payload: dict[str, object], module_name: str) -> dict[str, object]:
    preset = DETAIL_LAYOUT_PRESETS.get(safe_svg_id(module_name))
    if not preset:
        return {"updated": False, "reason": "no_preset"}
    module = first_module_payload(detail_payload)
    cells = module.get("cells", {}) if isinstance(module, dict) else {}
    if not isinstance(cells, dict):
        return {"updated": False, "reason": "invalid_cells"}

    applied = 0
    for cell_name, position in preset.items():
        cell = cells.get(cell_name)
        if not isinstance(cell, dict):
            continue
        attributes = cell.setdefault("attributes", {})
        if not isinstance(attributes, dict):
            attributes = {}
            cell["attributes"] = attributes
        attributes["org.eclipse.elk.x"] = position[0]
        attributes["org.eclipse.elk.y"] = position[1]
        attributes["org.eclipse.elk.layered.priority.direction"] = 100
        applied += 1
    return {"updated": applied > 0, "module": module_name, "applied": applied}


def orthogonalize_nonorthogonal_lines(root: ET.Element) -> dict[str, object]:
    parent_by_child = {child: parent for parent in root.iter() for child in list(parent)}
    replacements = 0
    for elem in list(root.iter()):
        if local_name(elem.tag) != "line":
            continue
        x1 = parse_float(elem.get("x1"))
        y1 = parse_float(elem.get("y1"))
        x2 = parse_float(elem.get("x2"))
        y2 = parse_float(elem.get("y2"))
        if nearly_equal(x1, x2) or nearly_equal(y1, y2):
            continue

        parent = parent_by_child.get(elem)
        if parent is None:
            continue
        children = list(parent)
        try:
            index = children.index(elem)
        except ValueError:
            continue

        attrs_a = dict(elem.attrib)
        attrs_b = dict(elem.attrib)
        line_id = elem.get("id")
        if line_id:
            attrs_a["id"] = f"{line_id}_orth_a"
            attrs_b["id"] = f"{line_id}_orth_b"

        elbow_x = x1
        elbow_y = y2
        attrs_a.update({"x1": format_num(x1), "y1": format_num(y1), "x2": format_num(elbow_x), "y2": format_num(elbow_y)})
        attrs_b.update({"x1": format_num(elbow_x), "y1": format_num(elbow_y), "x2": format_num(x2), "y2": format_num(y2)})
        parent.remove(elem)
        parent.insert(index, ET.Element(f"{{{SVG_NS}}}line", attrs_b))
        parent.insert(index, ET.Element(f"{{{SVG_NS}}}line", attrs_a))
        replacements += 1
    return {"updated": replacements > 0, "replacements": replacements}


def rail_kind_for_cell_name(name: str) -> str | None:
    lower = name.lower()
    if lower.startswith(("vcc_", "vdd_")):
        return "vcc"
    if lower.startswith(("vee_", "vss_")):
        return "vee"
    if lower.startswith("gnd_"):
        return "gnd"
    return None


def move_cell_group_and_edges(root: ET.Element, group: ET.Element, new_x: float, new_y: float) -> bool:
    transform = parse_translate(group.get("transform"))
    old_anchor = find_terminal_anchor(group)
    if transform is None or old_anchor is None:
        return False

    old_x, old_y = transform
    if nearly_equal(old_x, new_x) and nearly_equal(old_y, new_y):
        return False

    set_group_xy(group, new_x, new_y)
    new_anchor = find_terminal_anchor(group)
    if new_anchor is None:
        return False

    old_ax, old_ay = old_anchor
    new_ax, new_ay = new_anchor
    for elem in root.iter():
        if local_name(elem.tag) != "line":
            continue
        x1 = parse_float(elem.get("x1"))
        y1 = parse_float(elem.get("y1"))
        x2 = parse_float(elem.get("x2"))
        y2 = parse_float(elem.get("y2"))
        if nearly_equal(x1, old_ax) and nearly_equal(y1, old_ay):
            elem.set("x1", format_num(new_ax))
            elem.set("y1", format_num(new_ay))
        if nearly_equal(x2, old_ax) and nearly_equal(y2, old_ay):
            elem.set("x2", format_num(new_ax))
            elem.set("y2", format_num(new_ay))
    return True


def align_detail_rail_symbols(root: ET.Element) -> dict[str, object]:
    groups = find_cell_groups(root)
    rails: dict[str, list[tuple[str, ET.Element]]] = {"vcc": [], "vee": [], "gnd": []}

    for name, group in groups.items():
        kind = rail_kind_for_cell_name(name)
        if kind is not None:
            rails[kind].append((name, group))

    def connected_points(anchor: tuple[float, float]) -> list[tuple[float, float]]:
        ax, ay = anchor
        points: list[tuple[float, float]] = []
        for elem in root.iter():
            if local_name(elem.tag) != "line":
                continue
            x1 = parse_float(elem.get("x1"))
            y1 = parse_float(elem.get("y1"))
            x2 = parse_float(elem.get("x2"))
            y2 = parse_float(elem.get("y2"))
            if nearly_equal(x1, ax) and nearly_equal(y1, ay):
                points.append((x2, y2))
            elif nearly_equal(x2, ax) and nearly_equal(y2, ay):
                points.append((x1, y1))
        return points

    moved = 0

    for _, group in [*rails["vcc"], *rails["vee"], *rails["gnd"]]:
        transform = parse_translate(group.get("transform"))
        anchor = find_terminal_anchor(group)
        if transform is None or anchor is None:
            continue
        local_anchor = (anchor[0] - transform[0], anchor[1] - transform[1])
        points = connected_points(anchor)
        if not points:
            continue
        cell_name = str(group.get("id") or "")[5:]
        kind = rail_kind_for_cell_name(cell_name)
        if kind in {"vcc", "vee"}:
            target_x, target_y = min(points, key=lambda point: (point[1], point[0]))
        elif kind == "gnd":
            target_x, target_y = max(points, key=lambda point: (point[1], point[0]))
        else:
            continue
        if move_cell_group_and_edges(root, group, target_x - local_anchor[0], target_y - local_anchor[1]):
            moved += 1
    return {"updated": moved > 0, "moved": moved}


def ensure_basic_svg_format(svg_path: Path) -> dict[str, object]:
    if not svg_path.exists():
        return {"updated": False, "reason": "missing_svg"}
    ET.register_namespace("", SVG_NS)
    ET.register_namespace("s", NETLISTSVG_NS)
    tree = ET.parse(svg_path)
    root = tree.getroot()
    resize_svg_to_cells(root)
    rails = align_detail_rail_symbols(root)
    orthogonalized = orthogonalize_nonorthogonal_lines(root)
    resize_svg_to_cells(root)
    background = ensure_white_background(root)
    tree.write(svg_path, encoding="utf-8", xml_declaration=False)
    return {"updated": True, "background": background, "rails": rails, "orthogonalized": orthogonalized}


RENDER_SUBPARTITIONS: dict[str, list[tuple[str, str, list[str]]]] = {
    "input_sensor_tia": [
        ("tia_sensor_bias", "TIA SENSOR + BIAS", ["Ipd", "Rbias1", "Rbias2", "Cbias"]),
        ("tia_transimpedance_core", "TIA TRANSIMPEDANCE CORE", ["Rtail", "M1a", "M1b", "M1c", "M1d", "Rout1"]),
        ("tia_feedback_decoupling", "TIA FEEDBACK + DECOUPLING", ["Rf", "Cf", "Cdec1"]),
    ],
    "active_lowpass_filter": [
        ("active_lpf_rc_network", "ACTIVE LPF RC NETWORK", ["Rsk1", "Rsk2", "Csk1", "Csk2"]),
        ("active_lpf_buffer_bias", "ACTIVE LPF BUFFER + BIAS", ["M2a", "R2src", "M2b", "R2tail", "Cdec2"]),
    ],
    "threshold_reference": [
        ("threshold_high_reference", "THRESHOLD HIGH REFERENCE", ["Rth1", "Rth2", "Rth3", "Cthh", "Cdec3"]),
        ("threshold_low_reference", "THRESHOLD LOW REFERENCE", ["Rth4", "Rth5", "Rth6", "Cthl"]),
    ],
    "comparator_hysteresis": [
        ("comparator_high_trip_core", "COMPARATOR HIGH TRIP CORE", ["Rtailh", "M4ha", "M4hb", "M4hc", "M4hd", "Rhysh", "Routh"]),
        ("comparator_low_trip_core", "COMPARATOR LOW TRIP CORE", ["Rtaill", "M4la", "M4lb", "M4lc", "M4ld", "Rhysl", "Routl"]),
        ("comparator_logic_output", "COMPARATOR LOGIC OUTPUT", ["D4h", "D4l", "R4pd", "Cdec4"]),
    ],
    "opamp_gain": [
        ("opamp_input_active_load", "OPAMP INPUT + ACTIVE LOAD", ["Iog1", "Rog1", "Mog1", "Mog2", "Mog3", "Mog4", "Mog5"]),
        ("opamp_output_compensation", "OPAMP OUTPUT + COMPENSATION", ["Mog6", "Mog7", "Cog1"]),
        ("opamp_feedback_network", "OPAMP FEEDBACK NETWORK", ["Rog2", "Rog3", "Rog4"]),
    ],
    "envelope_detector": [
        ("detector_coupling_rectifier", "DETECTOR COUPLING + DIODE", ["CCPL", "D1"]),
        ("detector_envelope_hold", "DETECTOR ENVELOPE HOLD", ["RLOAD2", "CLOAD"]),
    ],
    "baseband_conditioning": [
        ("baseband_input_bias", "BASEBAND INPUT + BIAS", ["Rdec", "Cdec", "Rin", "Rbias1"]),
        ("baseband_gain_pair", "BASEBAND GAIN PAIR", ["Q2", "Q3", "Re_tail", "I_tail"]),
        ("baseband_feedback", "BASEBAND FEEDBACK", ["Rf", "Rg"]),
        ("baseband_rc_filter", "BASEBAND RC FILTER", ["Rsk1", "Csk1", "Rsk2", "Csk2"]),
        ("baseband_buffer_out", "BASEBAND BUFFER OUT", ["Q4", "Rload_bb"]),
    ],
    "threshold_comparator": [
        ("threshold_reference_ladder", "THRESHOLD REFERENCE LADDER", ["Rtc1", "Rtc2", "Rtc3", "Rtc4"]),
        ("threshold_high_trip_core", "THRESHOLD HIGH TRIP CORE", ["Mtc1", "Mtc2", "Mtc3", "Mtc4", "Mtc5", "Mtc6", "Rtc5", "Mtc7"]),
        ("threshold_low_trip_core", "THRESHOLD LOW TRIP CORE", ["Mtc8", "Mtc9", "Mtc10", "Mtc11", "Mtc12", "Mtc13", "Rtc6", "Mtc14"]),
        ("threshold_bias_hysteresis", "THRESHOLD BIAS + HYSTERESIS", ["Itc1", "Rtc7", "Rtc8", "Rtc9"]),
    ],
    "window_comparator": [
        ("window_threshold", "WINDOW THRESHOLD", ["Rdiv1", "Rdiv2", "Rdiv3", "Rref1"]),
        ("window_compare_core", "WINDOW COMPARE CORE", ["Q5", "Q6", "R1", "R2", "I1"]),
        ("window_alarm_output", "WINDOW ALARM OUTPUT", ["Rpull", "D2", "D3"]),
    ],
}

DETAIL_MIN_READABILITY_SCORE = 90
DETAIL_MAX_REFINEMENT_PASSES = 3
MIN_FUNCTIONAL_REFINEMENT_COMPONENTS = 6


def component_lookup_by_name(payload: dict[str, object]) -> dict[str, dict[str, object]]:
    components = payload.get("components", [])
    if not isinstance(components, list):
        return {}
    return {
        str(comp.get("name") or ""): comp
        for comp in components
        if isinstance(comp, dict) and str(comp.get("name") or "").strip()
    }


def make_render_subblock(
    parent: dict[str, object],
    name: str,
    label: str,
    order: int,
    component_names: list[str],
    component_lookup: dict[str, dict[str, object]],
) -> dict[str, object] | None:
    existing_names = [component_name for component_name in component_names if component_name in component_lookup]
    if not existing_names:
        return None
    nodes = sorted(
        {
            str(node)
            for component_name in existing_names
            for node in (
                component_lookup[component_name].get("schematic_nodes")
                or component_lookup[component_name].get("nodes")
                or []
            )
        }
    )
    return {
        "name": name,
        "label": label,
        "order": order,
        "purpose": str(parent.get("purpose") or ""),
        "file": str(parent.get("file") or ""),
        "parent_module": str(parent.get("parent_module") or parent.get("name") or name),
        "parent_input_nets": list(parent.get("input_nets", [])) if isinstance(parent.get("input_nets"), list) else [],
        "parent_output_nets": list(parent.get("output_nets", [])) if isinstance(parent.get("output_nets"), list) else [],
        "partition_kind": "functional",
        "partition_depth": int(parent.get("partition_depth") or 0) + 1,
        "component_names": existing_names,
        "nodes": nodes,
    }


def known_block_component_names(
    block: dict[str, object],
    component_lookup: dict[str, dict[str, object]],
) -> list[str]:
    return [
        str(name)
        for name in block.get("component_names", [])
        if str(name).strip() and str(name) in component_lookup
    ]


def make_functional_render_subblocks(
    block: dict[str, object],
    specs: list[tuple[str, str, list[str]]],
    start_order: int,
    component_lookup: dict[str, dict[str, object]],
) -> list[dict[str, object]]:
    block_name = safe_svg_id(str(block.get("name") or "module"))
    block_label = str(block.get("label") or module_label(block_name))
    subblocks: list[dict[str, object]] = []
    consumed: set[str] = set()
    order = start_order

    for name, label, component_names in specs:
        subblock = make_render_subblock(block, name, label, order, component_names, component_lookup)
        if subblock is None:
            continue
        subblocks.append(subblock)
        consumed.update(str(component_name) for component_name in subblock.get("component_names", []))
        order += 1

    leftovers = [name for name in known_block_component_names(block, component_lookup) if name not in consumed]
    if leftovers:
        support = make_render_subblock(
            block,
            f"{block_name}_support",
            f"{block_label} SUPPORT",
            order,
            leftovers,
            component_lookup,
        )
        if support is not None:
            subblocks.append(support)

    return subblocks


def expand_render_blocks(payload: dict[str, object], blocks: list[dict[str, object]]) -> list[dict[str, object]]:
    component_lookup = component_lookup_by_name(payload)
    expanded: list[dict[str, object]] = []
    order = 1
    for block in blocks:
        block_name = safe_svg_id(str(block.get("name") or ""))
        subparts = RENDER_SUBPARTITIONS.get(block_name)
        component_names = known_block_component_names(block, component_lookup)
        if not subparts or len(component_names) < MIN_FUNCTIONAL_REFINEMENT_COMPONENTS:
            expanded.append({**block, "order": order})
            order += 1
            continue
        subblocks = make_functional_render_subblocks(block, subparts, order, component_lookup)
        if not subblocks:
            expanded.append({**block, "order": order})
            order += 1
            continue
        expanded.extend(subblocks)
        order += len(subblocks)
    return expanded


def clean_detail_directory(details_dir: Path) -> None:
    details_dir.mkdir(parents=True, exist_ok=True)
    for child in details_dir.iterdir():
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()


def detail_quality_needs_refinement(item: dict[str, object]) -> bool:
    geometry = item.get("geometry")
    if not isinstance(geometry, dict):
        return False
    crossings = int(geometry.get("wire_crossings") or 0)
    overlaps = int(geometry.get("component_overlaps") or 0)
    intrusions = int(geometry.get("wire_body_intrusions") or 0)
    score = int(geometry.get("readability_score") or 100)
    return crossings > 0 or overlaps > 0 or intrusions > 0 or score < DETAIL_MIN_READABILITY_SCORE


def split_block_to_functional_groups(
    block: dict[str, object],
    component_lookup: dict[str, dict[str, object]],
) -> list[dict[str, object]]:
    if int(block.get("partition_depth") or 0) >= 1:
        return []
    component_names = known_block_component_names(block, component_lookup)
    if len(component_names) < MIN_FUNCTIONAL_REFINEMENT_COMPONENTS:
        return []

    parent_name = str(block.get("parent_module") or block.get("name") or "module")
    block_name = safe_svg_id(str(block.get("name") or parent_name))
    subparts = RENDER_SUBPARTITIONS.get(block_name)
    if not subparts:
        return []
    return make_functional_render_subblocks(
        {**block, "parent_module": parent_name},
        subparts,
        1,
        component_lookup,
    )


def renumber_blocks(blocks: list[dict[str, object]]) -> list[dict[str, object]]:
    return [{**block, "order": index + 1} for index, block in enumerate(blocks)]


def refine_blocks_from_render_quality(
    blocks: list[dict[str, object]],
    rendered: list[dict[str, object]],
    failures: list[dict[str, object]],
    component_lookup: dict[str, dict[str, object]],
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    bad_modules = {
        str(item.get("module") or "")
        for item in rendered
        if isinstance(item, dict) and detail_quality_needs_refinement(item)
    }
    bad_modules.update(str(item.get("module") or "") for item in failures if isinstance(item, dict))
    if not bad_modules:
        return blocks, []

    refinements: list[dict[str, object]] = []
    next_blocks: list[dict[str, object]] = []
    for block in blocks:
        module_name = str(block.get("name") or "")
        if module_name not in bad_modules:
            next_blocks.append(block)
            continue
        split_blocks = split_block_to_functional_groups(block, component_lookup)
        if not split_blocks:
            next_blocks.append(block)
            continue
        next_blocks.extend(split_blocks)
        refinements.append(
            {
                "module": module_name,
                "parent_module": str(block.get("parent_module") or module_name),
                "reason": "direct_netlistsvg_quality_functional_split",
                "from_components": len(block.get("component_names", [])) if isinstance(block.get("component_names"), list) else 0,
                "to_partitions": len(split_blocks),
            }
        )
    return renumber_blocks(next_blocks), refinements


def render_detail_blocks_once(
    payload: dict[str, object],
    json_path: Path,
    svg_path: Path,
    blocks: list[dict[str, object]],
    *,
    details_dir: Path,
    resolved_bin: str,
    skin_path: str,
    timeout_sec: int,
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    rendered: list[dict[str, object]] = []
    failures: list[dict[str, object]] = []

    for index, block in enumerate(blocks):
        module_name = safe_svg_id(str(block.get("name") or f"module_{index + 1}"))
        detail_payload, summary = build_module_detail_payload(payload, block, index, blocks)
        if detail_payload is None:
            failures.append({"module": module_name, **summary})
            continue

        detail_json_path = details_dir / f"{index + 1:02d}_{module_name}.json"
        detail_svg_path = details_dir / f"{index + 1:02d}_{module_name}.svg"
        layout_hints = apply_detail_layout_hints(detail_payload, str(summary.get("module") or module_name))
        detail_json_path.write_text(json.dumps(detail_payload, ensure_ascii=False, indent=2), encoding="utf-8")
        cmd = [resolved_bin, str(detail_json_path), "-o", str(detail_svg_path)]
        if skin_path:
            cmd.extend(["--skin", skin_path])
        try:
            completed = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=max(1, timeout_sec),
                check=False,
            )
        except subprocess.TimeoutExpired:
            failures.append({"module": module_name, "reason": f"timeout after {timeout_sec}s"})
            continue

        if completed.returncode != 0 or not detail_svg_path.exists():
            failures.append(
                {
                    "module": module_name,
                    "reason": "netlistsvg_failed",
                    "stderr": completed.stderr.strip(),
                }
            )
            continue

        raw_svg_path = detail_svg_path.with_name(f"{detail_svg_path.stem}.raw.svg")
        shutil.copyfile(detail_svg_path, raw_svg_path)
        basic_format = ensure_basic_svg_format(detail_svg_path)
        detail_net_cleanup = simplify_net_segments(detail_svg_path)
        geometry = check_geometry(detail_svg_path, detail_json_path)
        geometry_path = detail_svg_path.with_suffix(".geometry.json")
        geometry_path.write_text(json.dumps(geometry, ensure_ascii=False, indent=2), encoding="utf-8")
        rendered.append(
            {
                **summary,
                "parent_module": str(block.get("parent_module") or block.get("name") or ""),
                "json_path": str(detail_json_path),
                "svg_path": str(detail_svg_path),
                "raw_svg_path": str(raw_svg_path),
                "geometry_path": str(geometry_path),
                "geometry": geometry.get("summary", {}),
                "rendering_mode": "netlistsvg-direct",
                "layout_hints": layout_hints,
                "basic_format": basic_format,
                "net_cleanup": detail_net_cleanup,
            }
        )
    return rendered, failures


def render_module_detail_sheets(
    json_path: Path,
    svg_path: Path,
    *,
    resolved_bin: str,
    skin_path: str,
    timeout_sec: int,
) -> dict[str, object]:
    payload = json.loads(json_path.read_text(encoding="utf-8-sig"))
    blocks = collect_module_blocks(payload)
    blocks = expand_render_blocks(payload, blocks)
    if not should_render_module_overview(payload):
        return {"updated": False, "reason": "not_partitioned_or_too_small"}

    details_dir = svg_path.with_name(f"{svg_path.stem}.details")
    component_lookup = component_lookup_by_name(payload)
    render_history: list[dict[str, object]] = []
    rendered: list[dict[str, object]] = []
    failures: list[dict[str, object]] = []

    for pass_index in range(1, DETAIL_MAX_REFINEMENT_PASSES + 1):
        clean_detail_directory(details_dir)
        rendered, failures = render_detail_blocks_once(
            payload,
            json_path,
            svg_path,
            blocks,
            details_dir=details_dir,
            resolved_bin=resolved_bin,
            skin_path=skin_path,
            timeout_sec=timeout_sec,
        )
        next_blocks, refinements = refine_blocks_from_render_quality(blocks, rendered, failures, component_lookup)
        render_history.append(
            {
                "pass": pass_index,
                "partition_count": len(blocks),
                "rendered_count": len(rendered),
                "failure_count": len(failures),
                "refinements": refinements,
            }
        )
        if not refinements:
            break
        blocks = next_blocks

    index_path = details_dir / "index.json"
    index_payload = {
        "ok": len(failures) == 0,
        "details_dir": str(details_dir),
        "strategy": "adaptive_direct_netlistsvg_partitions",
        "history": render_history,
        "rendered": rendered,
        "failures": failures,
    }
    index_path.write_text(json.dumps(index_payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "updated": bool(rendered),
        "details_dir": str(details_dir),
        "index_path": str(index_path),
        "strategy": "adaptive_direct_netlistsvg_partitions",
        "history": render_history,
        "rendered_count": len(rendered),
        "failure_count": len(failures),
        "rendered": rendered,
        "failures": failures,
    }


def svg_root_size(root: ET.Element) -> tuple[float, float]:
    width = parse_float(root.get("width"))
    height = parse_float(root.get("height"))
    if width > 0 and height > 0:
        return width, height
    view_box = str(root.get("viewBox") or "").strip()
    parts = re.split(r"[\s,]+", view_box)
    if len(parts) == 4:
        return parse_float(parts[2], 640.0), parse_float(parts[3], 420.0)
    return 640.0, 420.0


def prefix_svg_ids(elem: ET.Element, prefix: str) -> None:
    elem_id = elem.get("id")
    if elem_id:
        elem.set("id", f"{prefix}_{elem_id}")
    for attr_name, attr_value in list(elem.attrib.items()):
        if attr_value.startswith("url(#"):
            elem.set(attr_name, f"url(#{prefix}_{attr_value[5:]}")
        elif attr_value.startswith("#"):
            elem.set(attr_name, f"#{prefix}_{attr_value[1:]}")
    for child in list(elem):
        prefix_svg_ids(child, prefix)


def compose_partitioned_module_sheet(
    svg_path: Path,
    json_path: Path,
    detail_sheets_result: dict[str, object],
    *,
    flat_svg_path: Path | None = None,
) -> dict[str, object]:
    rendered = detail_sheets_result.get("rendered") if isinstance(detail_sheets_result, dict) else None
    if not isinstance(rendered, list) or not rendered:
        return {"updated": False, "reason": "no_module_detail_svgs"}

    modules: list[dict[str, object]] = []
    for index, item in enumerate(rendered):
        if not isinstance(item, dict):
            continue
        module_svg_path = Path(str(item.get("svg_path") or "")).resolve()
        if not module_svg_path.exists():
            continue
        try:
            module_root = ET.parse(module_svg_path).getroot()
        except ET.ParseError:
            continue
        width, height = svg_root_size(module_root)
        modules.append(
            {
                "index": index,
                "module": str(item.get("module") or module_svg_path.stem),
                "parent_module": str(item.get("parent_module") or item.get("module") or module_svg_path.stem),
                "svg_path": module_svg_path,
                "root": module_root,
                "width": width,
                "height": height,
                "input_nodes": item.get("input_nodes") if isinstance(item.get("input_nodes"), list) else [],
                "output_nodes": item.get("output_nodes") if isinstance(item.get("output_nodes"), list) else [],
                "component_count": item.get("component_count"),
                "geometry": item.get("geometry") if isinstance(item.get("geometry"), dict) else {},
            }
        )

    if not modules:
        return {"updated": False, "reason": "no_readable_module_svgs"}

    margin = 34.0
    group_gap_y = 58.0
    child_gap_x = 34.0
    child_gap_y = 42.0
    pad = 16.0
    child_header_h = 42.0
    child_footer_h = 22.0
    group_header_h = 38.0
    group_pad = 20.0
    max_group_content_width = 3300.0

    groups: list[dict[str, object]] = []
    group_by_name: dict[str, dict[str, object]] = {}
    for module in modules:
        parent_name = str(module.get("parent_module") or module.get("module") or "module")
        if parent_name not in group_by_name:
            group = {"name": parent_name, "modules": []}
            group_by_name[parent_name] = group
            groups.append(group)
        group_modules = group_by_name[parent_name]["modules"]
        if isinstance(group_modules, list):
            group_modules.append(module)

    current_y = 86.0
    sheet_w = 960.0
    positioned: list[dict[str, object]] = []
    positioned_groups: list[dict[str, object]] = []

    for group in groups:
        group_modules = group.get("modules")
        if not isinstance(group_modules, list) or not group_modules:
            continue

        rows: list[dict[str, object]] = []
        row_modules: list[dict[str, object]] = []
        row_w = 0.0
        row_h = 0.0
        for module in group_modules:
            frame_w = float(module["width"]) + pad * 2
            frame_h = float(module["height"]) + child_header_h + pad + child_footer_h
            next_w = frame_w if not row_modules else row_w + child_gap_x + frame_w
            if row_modules and next_w > max_group_content_width:
                rows.append({"modules": row_modules, "width": row_w, "height": row_h})
                row_modules = []
                row_w = 0.0
                row_h = 0.0
            row_modules.append({**module, "frame_w": frame_w, "frame_h": frame_h})
            row_w = frame_w if nearly_equal(row_w, 0.0) else row_w + child_gap_x + frame_w
            row_h = max(row_h, frame_h)
        if row_modules:
            rows.append({"modules": row_modules, "width": row_w, "height": row_h})

        content_w = max(float(row["width"]) for row in rows)
        content_h = sum(float(row["height"]) for row in rows) + child_gap_y * max(0, len(rows) - 1)
        group_w = content_w + group_pad * 2
        group_h = group_header_h + group_pad + content_h + group_pad
        group_x = margin
        group_y = current_y
        child_y = group_y + group_header_h + group_pad
        for row in rows:
            child_x = group_x + group_pad
            for module in row["modules"]:
                placed = {
                    **module,
                    "x": child_x,
                    "y": child_y,
                    "group": str(group.get("name") or ""),
                }
                positioned.append(placed)
                child_x += float(module["frame_w"]) + child_gap_x
            child_y += float(row["height"]) + child_gap_y
        positioned_groups.append(
            {
                "name": str(group.get("name") or ""),
                "x": group_x,
                "y": group_y,
                "w": group_w,
                "h": group_h,
                "count": len(group_modules),
            }
        )
        sheet_w = max(sheet_w, group_x + group_w + margin)
        current_y += group_h + group_gap_y

    svg_w = sheet_w
    legend_y = current_y + 10.0
    svg_h = legend_y + 92.0

    ET.register_namespace("", SVG_NS)
    ET.register_namespace("s", NETLISTSVG_NS)
    root = ET.Element(
        f"{{{SVG_NS}}}svg",
        {
            "width": format_num(svg_w),
            "height": format_num(svg_h),
            "viewBox": f"0 0 {format_num(svg_w)} {format_num(svg_h)}",
            "data-actoviq-view": "partitioned-netlistsvg-sheet",
        },
    )
    style = ET.SubElement(root, "style")
    style.text = """
.page-bg{fill:#fff}
.sheet-title{font:700 20px Georgia,serif;fill:#202020;stroke:none}
.sheet-subtitle{font:12px Courier New,monospace;fill:#666;stroke:none}
.module-group-frame{fill:#fbfbfb;stroke:#b8b8b8;stroke-width:1.15;stroke-dasharray:8 5}
.module-group-title{font:700 14px Courier New,monospace;fill:#202020;stroke:none}
.module-group-meta{font:11px Courier New,monospace;fill:#666;stroke:none}
.partition-frame{fill:#fff;stroke:#222;stroke-width:1.25}
.partition-title{font:700 13px Courier New,monospace;fill:#222;stroke:none}
.partition-meta{font:11px Courier New,monospace;fill:#666;stroke:none}
.partition-net{font:700 10px Courier New,monospace;fill:#222;stroke:none}
.connection-title{font:700 12px Courier New,monospace;fill:#222;stroke:none}
.connection-row{font:11px Courier New,monospace;fill:#444;stroke:none}
"""
    ET.SubElement(root, "rect", {"class": "page-bg", "x": "0", "y": "0", "width": format_num(svg_w), "height": format_num(svg_h)})
    ET.SubElement(root, "text", {"class": "sheet-title", "x": "28", "y": "34"}).text = "Partitioned netlistsvg schematic sheet"
    ET.SubElement(root, "text", {"class": "sheet-subtitle", "x": "28", "y": "56"}).text = (
        "Each partition embeds the direct netlistsvg module schematic; modules connect by matching net labels only."
    )

    for group in positioned_groups:
        x0 = float(group["x"])
        y0 = float(group["y"])
        group_w = float(group["w"])
        group_h = float(group["h"])
        ET.SubElement(
            root,
            "rect",
            {
                "id": f"group_{safe_svg_id(str(group['name']))}",
                "class": "module-group-frame",
                "x": format_num(x0),
                "y": format_num(y0),
                "width": format_num(group_w),
                "height": format_num(group_h),
                "rx": "14",
            },
        )
        ET.SubElement(root, "text", {"class": "module-group-title", "x": format_num(x0 + 16), "y": format_num(y0 + 24)}).text = module_label(str(group["name"]))
        ET.SubElement(
            root,
            "text",
            {"class": "module-group-meta", "x": format_num(x0 + group_w - 16), "y": format_num(y0 + 24), "text-anchor": "end"},
        ).text = f"{group['count']} direct netlistsvg partition(s)"

    connection_rows: list[str] = []
    for module in positioned:
        x0 = float(module["x"])
        y0 = float(module["y"])
        frame_w = float(module["frame_w"])
        frame_h = float(module["frame_h"])
        module_name = str(module["module"])
        module_id = safe_svg_id(module_name)
        ET.SubElement(
            root,
            "rect",
            {
                "id": f"module_{module_id}",
                "class": "partition-frame",
                "x": format_num(x0),
                "y": format_num(y0),
                "width": format_num(frame_w),
                "height": format_num(frame_h),
                "rx": "10",
            },
        )
        ET.SubElement(root, "text", {"class": "partition-title", "x": format_num(x0 + 14), "y": format_num(y0 + 24)}).text = module_label(module_name)
        meta = f"{module.get('component_count') or '?'} primitives"
        ET.SubElement(root, "text", {"class": "partition-meta", "x": format_num(x0 + frame_w - 14), "y": format_num(y0 + 24), "text-anchor": "end"}).text = meta
        input_nodes = [str(node) for node in module.get("input_nodes", [])]
        output_nodes = [str(node) for node in module.get("output_nodes", [])]
        io_text = f"IN: {', '.join(input_nodes) or '-'}    OUT: {', '.join(output_nodes) or '-'}"
        ET.SubElement(root, "text", {"class": "partition-net", "x": format_num(x0 + 14), "y": format_num(y0 + 39)}).text = io_text
        if input_nodes or output_nodes:
            connection_rows.append(f"{module_label(module_name)}: IN {', '.join(input_nodes) or '-'} -> OUT {', '.join(output_nodes) or '-'}")

        viewport = ET.SubElement(
            root,
            "svg",
            {
                "class": "embedded-netlistsvg-module",
                "x": format_num(x0 + pad),
                "y": format_num(y0 + child_header_h),
                "width": format_num(float(module["width"])),
                "height": format_num(float(module["height"])),
                "viewBox": f"0 0 {format_num(float(module['width']))} {format_num(float(module['height']))}",
            },
        )
        for child in list(module["root"]):
            copied = copy.deepcopy(child)
            prefix_svg_ids(copied, f"m{int(module['index']) + 1}_{module_id}")
            viewport.append(copied)

    ET.SubElement(root, "text", {"class": "connection-title", "x": "28", "y": format_num(legend_y)}).text = "Partition net-label contract"
    for index, row in enumerate(connection_rows):
        ET.SubElement(
            root,
            "text",
            {"class": "connection-row", "x": "28", "y": format_num(legend_y + 20 + index * 18)},
        ).text = row
    footer = []
    details_dir = detail_sheets_result.get("details_dir")
    if details_dir:
        footer.append(f"Module SVGs: {Path(str(details_dir)).name}/")
    if flat_svg_path:
        footer.append(f"Flat debug: {flat_svg_path.name}")
    if footer:
        ET.SubElement(
            root,
            "text",
            {"class": "sheet-subtitle", "x": format_num(svg_w - 28), "y": format_num(svg_h - 18), "text-anchor": "end"},
        ).text = " | ".join(footer)

    tree = ET.ElementTree(root)
    tree.write(svg_path, encoding="utf-8", xml_declaration=True)
    return {
        "updated": True,
        "view": "partitioned-netlistsvg-sheet",
        "composition": "embedded_direct_netlistsvg_modules",
        "modules": [
            {
                "module": str(item["module"]),
                "parent_module": str(item.get("parent_module") or item["module"]),
                "svg_path": str(item["svg_path"]),
                "width": item["width"],
                "height": item["height"],
                "input_nodes": item["input_nodes"],
                "output_nodes": item["output_nodes"],
            }
            for item in positioned
        ],
        "groups": [
            {
                "module": str(item["name"]),
                "partition_count": item["count"],
                "width": item["w"],
                "height": item["h"],
            }
            for item in positioned_groups
        ],
        "flat_svg_path": str(flat_svg_path) if flat_svg_path else None,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Render schematic SVG with netlistsvg")
    parser.add_argument("--json-path", required=True, help="Input JSON path")
    parser.add_argument("--svg-path", required=True, help="Output SVG path")
    parser.add_argument("--netlistsvg-bin", default="netlistsvg", help="netlistsvg executable")
    parser.add_argument(
        "--skin-profile",
        default="analog",
        choices=["analog", "default", "none"],
        help="Skin profile to use; analog is recommended for SPICE circuits",
    )
    parser.add_argument("--skin-path", default="", help="Explicit netlistsvg skin path")
    parser.add_argument("--timeout-sec", type=int, default=30, help="Process timeout")
    parser.add_argument(
        "--overrides-path",
        default="",
        help="Optional schematic.overrides.json with locked cell positions",
    )
    return parser


def write_netlistsvg_reports(
    svg_path: Path,
    json_path: Path,
    *,
    payload: dict[str, object],
    skin_path: str,
    hierarchy_result: dict[str, object],
    detail_sheets_result: dict[str, object],
    flat_geometry_check: dict[str, object] | None = None,
    flat_geometry_report_path: Path | None = None,
) -> dict[str, object]:
    geometry_report_path = svg_path.with_suffix(".geometry.json")
    geometry_check = check_geometry(svg_path, json_path)
    geometry_report_path.write_text(json.dumps(geometry_check, ensure_ascii=False, indent=2), encoding="utf-8")
    if flat_geometry_check is None:
        flat_geometry_check = geometry_check

    layout_report_path = svg_path.with_suffix(".layout.json")
    layout_report = {
        "ok": bool(geometry_check["ok"]) and bool(geometry_check.get("readability", {}).get("ok")),
        "svg_path": str(svg_path),
        "json_path": str(json_path),
        "renderer": "netlistsvg",
        "skin_path": skin_path,
        "schematic_intent": payload.get("schematic_intent", {}),
        "passes": {
            "partitioned_sheet": hierarchy_result,
            "hierarchical_overview": hierarchy_result,
            "module_detail_sheets": detail_sheets_result,
        },
        "geometry": geometry_check["summary"],
        "flat_geometry": flat_geometry_check["summary"],
        "flat_geometry_report": str(flat_geometry_report_path) if flat_geometry_report_path else None,
        "readability": geometry_check.get("readability", {}),
    }
    layout_report_path.write_text(json.dumps(layout_report, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "geometry_check": {
            "ok": geometry_check["ok"],
            "report_path": str(geometry_report_path),
            "summary": geometry_check["summary"],
        },
        "layout_report": {
            "ok": layout_report["ok"],
            "report_path": str(layout_report_path),
            "readability_score": geometry_check.get("readability", {}).get("score"),
        },
    }


def render_partitioned_fallback_after_timeout(
    *,
    json_path: Path,
    svg_path: Path,
    resolved_bin: str,
    skin_path: str,
    timeout_sec: int,
    timeout_message: str,
) -> dict[str, object]:
    payload = json.loads(json_path.read_text(encoding="utf-8-sig"))
    if not should_render_module_overview(payload):
        return {"ok": False, "stderr": timeout_message, "reason": "not_partitioned_or_too_small"}

    detail_sheets_result = render_module_detail_sheets(
        json_path,
        svg_path,
        resolved_bin=resolved_bin,
        skin_path=skin_path,
        timeout_sec=timeout_sec,
    )
    hierarchy_result = compose_partitioned_module_sheet(svg_path, json_path, detail_sheets_result)
    if not hierarchy_result.get("updated"):
        details_dir_value = detail_sheets_result.get("details_dir") if isinstance(detail_sheets_result, dict) else None
        hierarchy_result = render_module_overview_svg(
            svg_path,
            json_path,
            details_dir=Path(str(details_dir_value)) if details_dir_value else None,
        )

    if not hierarchy_result.get("updated") or not svg_path.exists():
        return {
            "ok": False,
            "stderr": timeout_message,
            "reason": "partitioned_fallback_failed",
            "partitioned_sheet": hierarchy_result,
            "module_detail_sheets": detail_sheets_result,
        }

    reports = write_netlistsvg_reports(
        svg_path,
        json_path,
        payload=payload,
        skin_path=skin_path,
        hierarchy_result=hierarchy_result,
        detail_sheets_result=detail_sheets_result,
    )
    return {
        "ok": True,
        "stderr": timeout_message,
        "fallback": "partitioned_netlistsvg_after_full_timeout",
        "partitioned_sheet": hierarchy_result,
        "hierarchical_overview": hierarchy_result,
        "module_detail_sheets": detail_sheets_result,
        **reports,
    }


def resolve_skin_path(resolved_bin: str, skin_profile: str, skin_path: str) -> str:
    explicit = (skin_path or "").strip()
    if explicit:
        p = Path(explicit).expanduser().resolve()
        return str(p) if p.exists() else ""
    if skin_profile == "none":
        return ""

    skin_file = f"{skin_profile}.svg"
    bin_dir = Path(resolved_bin).resolve().parent
    skill_root = Path(__file__).resolve().parents[1]
    candidates = [
        skill_root / "assets" / "skins" / skin_file,
        skill_root / skin_file,
        bin_dir / "node_modules" / "netlistsvg" / "lib" / skin_file,
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate.resolve())
    return ""


def main() -> int:
    args = build_parser().parse_args()
    json_path = Path(args.json_path).resolve()
    svg_path = Path(args.svg_path).resolve()
    result = {"ok": False, "svg_path": str(svg_path), "skin_path": "", "stderr": ""}
    schematic_overrides: dict[str, object] | None = None

    if not json_path.exists():
        result["stderr"] = f"json not found: {json_path}"
        print(json.dumps(result, ensure_ascii=False))
        return 1
    try:
        schematic_overrides = load_schematic_overrides(str(args.overrides_path))
    except Exception as exc:
        result["stderr"] = str(exc)
        print(json.dumps(result, ensure_ascii=False))
        return 1

    try:
        payload = json.loads(json_path.read_text(encoding="utf-8-sig"))
        result["planner"] = plan_payload(payload)
        json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except Exception as exc:
        result["planner"] = {"updated": False, "error": str(exc)}

    resolved_bin = shutil.which(args.netlistsvg_bin)
    if resolved_bin is None and os.name == "nt":
        # npm on Windows usually exposes a .cmd shim.
        resolved_bin = shutil.which(f"{args.netlistsvg_bin}.cmd")

    if resolved_bin is None:
        result["stderr"] = f"netlistsvg not found in PATH: {args.netlistsvg_bin}"
        print(json.dumps(result, ensure_ascii=False))
        return 1

    skin_path = resolve_skin_path(resolved_bin, args.skin_profile, args.skin_path)
    if args.skin_profile != "none" and not skin_path:
        result["stderr"] = (
            f"skin not found for profile={args.skin_profile}. "
            "Pass --skin-path explicitly or use --skin-profile none."
        )
        print(json.dumps(result, ensure_ascii=False))
        return 1

    svg_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [resolved_bin, str(json_path), "-o", str(svg_path)]
    if skin_path:
        cmd.extend(["--skin", skin_path])

    try:
        completed = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=max(1, args.timeout_sec),
            check=False,
        )
    except FileNotFoundError as exc:
        result["stderr"] = f"netlistsvg executable error: {exc}"
        print(json.dumps(result, ensure_ascii=False))
        return 1
    except subprocess.TimeoutExpired:
        timeout_message = f"netlistsvg timeout after {args.timeout_sec}s"
        fallback_result = render_partitioned_fallback_after_timeout(
            json_path=json_path,
            svg_path=svg_path,
            resolved_bin=resolved_bin,
            skin_path=skin_path,
            timeout_sec=args.timeout_sec,
            timeout_message=timeout_message,
        )
        result.update(fallback_result)
        result["skin_path"] = skin_path
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result["ok"] else 1

    result["ok"] = completed.returncode == 0 and svg_path.exists()
    result["skin_path"] = skin_path
    result["stderr"] = completed.stderr.strip()
    if result["ok"]:
        initial_io_terminal_layout = enforce_io_terminal_sides(svg_path)
        result["symbolic_cells"] = enhance_symbolic_cells(svg_path, json_path)
        result["formatted_layout"] = format_signal_chain_schematic(svg_path, json_path, schematic_overrides)
        result["net_cleanup"] = simplify_net_segments(svg_path)
        final_io_terminal_layout = enforce_io_terminal_sides(svg_path)
        if final_io_terminal_layout.get("updated"):
            result["net_cleanup"] = simplify_net_segments(svg_path)
        result["io_terminal_layout"] = final_io_terminal_layout
        payload = json.loads(json_path.read_text(encoding="utf-8-sig"))
        flat_geometry_check = check_geometry(svg_path, json_path)
        hierarchy_result: dict[str, object] = {"updated": False, "reason": "not_needed"}
        detail_sheets_result: dict[str, object] = {"updated": False, "reason": "not_needed"}
        flat_geometry_report_path: Path | None = None
        if should_render_module_overview(payload):
            flat_svg_path = svg_path.with_name(f"{svg_path.stem}.flat{svg_path.suffix}")
            flat_geometry_report_path = svg_path.with_name(f"{svg_path.stem}.flat.geometry.json")
            shutil.copyfile(svg_path, flat_svg_path)
            flat_geometry_check = check_geometry(flat_svg_path, json_path)
            flat_geometry_report_path.write_text(
                json.dumps(flat_geometry_check, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            detail_sheets_result = render_module_detail_sheets(
                json_path,
                svg_path,
                resolved_bin=resolved_bin,
                skin_path=skin_path,
                timeout_sec=args.timeout_sec,
            )
            hierarchy_result = compose_partitioned_module_sheet(
                svg_path,
                json_path,
                detail_sheets_result,
                flat_svg_path=flat_svg_path,
            )
            if not hierarchy_result.get("updated"):
                details_dir_value = detail_sheets_result.get("details_dir") if isinstance(detail_sheets_result, dict) else None
                hierarchy_result = render_module_overview_svg(
                    svg_path,
                    json_path,
                    flat_svg_path=flat_svg_path,
                    details_dir=Path(str(details_dir_value)) if details_dir_value else None,
                )
        geometry_report_path = svg_path.with_suffix(".geometry.json")
        geometry_check = check_geometry(svg_path, json_path)
        geometry_report_path.write_text(json.dumps(geometry_check, ensure_ascii=False, indent=2), encoding="utf-8")
        layout_report_path = svg_path.with_suffix(".layout.json")
        layout_report = {
            "ok": bool(geometry_check["ok"]) and bool(geometry_check.get("readability", {}).get("ok")),
            "svg_path": str(svg_path),
            "json_path": str(json_path),
            "renderer": "netlistsvg",
            "skin_path": skin_path,
            "schematic_intent": payload.get("schematic_intent", {}),
            "passes": {
                "io_terminal_layout": result["io_terminal_layout"],
                "io_terminal_layout_initial": initial_io_terminal_layout,
                "io_terminal_layout_final": final_io_terminal_layout,
                "symbolic_cells": result["symbolic_cells"],
                "formatted_layout": result["formatted_layout"],
                "net_cleanup": result["net_cleanup"],
                "partitioned_sheet": hierarchy_result,
                "hierarchical_overview": hierarchy_result,
                "module_detail_sheets": detail_sheets_result,
            },
            "geometry": geometry_check["summary"],
            "flat_geometry": flat_geometry_check["summary"],
            "flat_geometry_report": str(flat_geometry_report_path) if flat_geometry_report_path else None,
            "readability": geometry_check.get("readability", {}),
        }
        layout_report_path.write_text(json.dumps(layout_report, ensure_ascii=False, indent=2), encoding="utf-8")
        result["hierarchical_overview"] = hierarchy_result
        result["partitioned_sheet"] = hierarchy_result
        result["module_detail_sheets"] = detail_sheets_result
        result["geometry_check"] = {
            "ok": geometry_check["ok"],
            "report_path": str(geometry_report_path),
            "summary": geometry_check["summary"],
        }
        result["layout_report"] = {
            "ok": layout_report["ok"],
            "report_path": str(layout_report_path),
            "readability_score": geometry_check.get("readability", {}).get("score"),
        }
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
