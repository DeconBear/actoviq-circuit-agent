#!/usr/bin/env python3
"""Check SVG schematic geometry against the design JSON connectivity.

The checker verifies the final rendered SVG, not the abstract netlist:
- every connected cell pin has a same-net wire segment touching its exact pin anchor;
- different-net horizontal/vertical wires do not cross away from a pin or junction;
- component bounding boxes do not overlap.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any


NETLISTSVG_NS = "https://github.com/nturley/netlistsvg"
TRANSLATE_RE = re.compile(r"translate\(\s*([-+]?\d*\.?\d+)\s*,\s*([-+]?\d*\.?\d+)\s*\)")


def local_name(name: str) -> str:
    return name.rsplit("}", 1)[-1]


def get_attr(elem: ET.Element, name: str) -> str | None:
    for key, value in elem.attrib.items():
        if local_name(key) == name:
            return value
    return None


def parse_float(value: str | None, default: float = 0.0) -> float:
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        return default


def parse_translate(transform: str | None) -> tuple[float, float] | None:
    if not transform:
        return None
    match = TRANSLATE_RE.search(transform)
    if not match:
        return None
    return float(match.group(1)), float(match.group(2))


def class_tokens(elem: ET.Element) -> list[str]:
    return str(elem.get("class") or "").split()


def net_class(elem: ET.Element) -> str | None:
    for token in class_tokens(elem):
        if token.startswith("net_"):
            return token
    return None


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def first_module(payload: dict[str, Any]) -> dict[str, Any]:
    modules = payload.get("modules", {})
    if not isinstance(modules, dict) or not modules:
        return {}
    module = next(iter(modules.values()))
    return module if isinstance(module, dict) else {}


def find_cell_groups(root: ET.Element) -> dict[str, ET.Element]:
    groups: dict[str, ET.Element] = {}
    for elem in root.iter():
        if local_name(elem.tag) != "g":
            continue
        cell_id = elem.get("id", "")
        if cell_id.startswith("cell_"):
            groups[cell_id[5:]] = elem
    return groups


def group_pin_points(group: ET.Element) -> dict[str, tuple[float, float]]:
    transform = parse_translate(group.get("transform"))
    if transform is None:
        return {}
    gx, gy = transform
    pins: dict[str, tuple[float, float]] = {}
    for child in group.iter():
        if child is group or local_name(child.tag) != "g":
            continue
        pid = get_attr(child, "pid")
        if not pid:
            continue
        pins[pid] = (gx + parse_float(get_attr(child, "x")), gy + parse_float(get_attr(child, "y")))
    return pins


def cell_pin_points(root: ET.Element) -> dict[str, dict[str, tuple[float, float]]]:
    return {name: group_pin_points(group) for name, group in find_cell_groups(root).items()}


def cell_boxes(root: ET.Element) -> dict[str, tuple[float, float, float, float]]:
    boxes: dict[str, tuple[float, float, float, float]] = {}
    for name, group in find_cell_groups(root).items():
        transform = parse_translate(group.get("transform"))
        if transform is None:
            continue
        x, y = transform
        width = parse_float(get_attr(group, "width"))
        height = parse_float(get_attr(group, "height"))
        boxes[name] = (x, y, x + width, y + height)
    return boxes


def module_overview_boxes(root: ET.Element) -> dict[str, tuple[float, float, float, float]]:
    boxes: dict[str, tuple[float, float, float, float]] = {}
    for elem in root.iter():
        if local_name(elem.tag) != "rect":
            continue
        box_id = elem.get("id", "")
        if not box_id.startswith("module_"):
            continue
        x = parse_float(elem.get("x"))
        y = parse_float(elem.get("y"))
        width = parse_float(elem.get("width"))
        height = parse_float(elem.get("height"))
        boxes[box_id] = (x, y, x + width, y + height)
    return boxes


def is_overview_like(root: ET.Element) -> bool:
    return root.get("data-actoviq-view") in {"module-overview", "partitioned-netlistsvg-sheet"}


def bit_to_node_name(payload: dict[str, Any]) -> dict[int, str]:
    mapping: dict[int, str] = {}
    module = first_module(payload)
    netnames = module.get("netnames", {}) if isinstance(module, dict) else {}
    if not isinstance(netnames, dict):
        return mapping
    for node, record in netnames.items():
        bits = record.get("bits", []) if isinstance(record, dict) else []
        for bit in bits:
            if isinstance(bit, int):
                mapping[bit] = str(node)
    return mapping


def cell_net_classes(payload: dict[str, Any]) -> dict[str, set[str]]:
    mapping: dict[str, set[str]] = {}
    module = first_module(payload)
    cells = module.get("cells", {}) if isinstance(module, dict) else {}
    if not isinstance(cells, dict):
        return mapping
    for cell_name, cell in cells.items():
        if not isinstance(cell, dict):
            continue
        classes: set[str] = set()
        connections = cell.get("connections", {})
        if not isinstance(connections, dict):
            continue
        for bits in connections.values():
            if not isinstance(bits, list):
                continue
            for bit in bits:
                if isinstance(bit, int):
                    classes.add(f"net_{bit}")
        mapping[str(cell_name)] = classes
    return mapping


def terminal_net_classes(payload: dict[str, Any]) -> dict[str, set[str]]:
    classes = cell_net_classes(payload)
    node_to_class = {node: f"net_{bit}" for bit, node in bit_to_node_name(payload).items()}
    interfaces = payload.get("interfaces", {}) if isinstance(payload.get("interfaces"), dict) else {}
    io = payload.get("io_inference", {}) if isinstance(payload.get("io_inference"), dict) else {}
    input_node = str(interfaces.get("input_node") or io.get("input_node") or "")
    output_node = str(interfaces.get("output_node") or io.get("output_node") or "")
    if input_node and input_node in node_to_class:
        classes.setdefault("IN", set()).add(node_to_class[input_node])
    if output_node and output_node in node_to_class:
        classes.setdefault("OUT", set()).add(node_to_class[output_node])
    return classes


def point_key(point: tuple[float, float], precision: int = 3) -> str:
    return f"{round(point[0], precision)},{round(point[1], precision)}"


def line_segments(root: ET.Element) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    for elem in root.iter():
        if local_name(elem.tag) != "line":
            continue
        cls = net_class(elem)
        if not cls:
            continue
        start = (parse_float(elem.get("x1")), parse_float(elem.get("y1")))
        end = (parse_float(elem.get("x2")), parse_float(elem.get("y2")))
        segments.append({"class": cls, "start": start, "end": end})
    return segments


def overview_signal_segments(root: ET.Element) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    for elem in root.iter():
        if local_name(elem.tag) != "line":
            continue
        classes = class_tokens(elem)
        if "signal-wire" not in classes and "rail-wire" not in classes:
            continue
        cls = " ".join(classes) or "wire"
        start = (parse_float(elem.get("x1")), parse_float(elem.get("y1")))
        end = (parse_float(elem.get("x2")), parse_float(elem.get("y2")))
        segments.append({"class": cls, "start": start, "end": end})
    return segments


def dist_point_to_segment(point: tuple[float, float], start: tuple[float, float], end: tuple[float, float]) -> float:
    px, py = point
    x1, y1 = start
    x2, y2 = end
    dx = x2 - x1
    dy = y2 - y1
    length_sq = dx * dx + dy * dy
    if length_sq <= 1e-12:
        return math.hypot(px - x1, py - y1)
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / length_sq))
    proj = (x1 + t * dx, y1 + t * dy)
    return math.hypot(px - proj[0], py - proj[1])


def segment_touches_point(segment: dict[str, Any], point: tuple[float, float], tolerance: float) -> bool:
    return dist_point_to_segment(point, segment["start"], segment["end"]) <= tolerance


def pin_connection_issues(
    payload: dict[str, Any],
    pins: dict[str, dict[str, tuple[float, float]]],
    segments: list[dict[str, Any]],
    tolerance: float,
) -> list[dict[str, Any]]:
    module = first_module(payload)
    cells = module.get("cells", {}) if isinstance(module, dict) else {}
    if not isinstance(cells, dict):
        return []

    pin_count_by_bit: dict[int, int] = {}
    for cell in cells.values():
        if not isinstance(cell, dict):
            continue
        connections = cell.get("connections", {})
        if not isinstance(connections, dict):
            continue
        for bits in connections.values():
            if not isinstance(bits, list):
                continue
            for bit in bits:
                if isinstance(bit, int):
                    pin_count_by_bit[bit] = pin_count_by_bit.get(bit, 0) + 1

    issues: list[dict[str, Any]] = []
    node_names = bit_to_node_name(payload)
    segments_by_class: dict[str, list[dict[str, Any]]] = {}
    for segment in segments:
        segments_by_class.setdefault(str(segment["class"]), []).append(segment)

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
                if not isinstance(bit, int) or pin_count_by_bit.get(bit, 0) < 2:
                    continue
                cls = f"net_{bit}"
                touching = any(segment_touches_point(segment, point, tolerance) for segment in segments_by_class.get(cls, []))
                if not touching:
                    issues.append(
                        {
                            "cell": str(cell_name),
                            "pin": str(pin_name),
                            "bit": bit,
                            "node": node_names.get(bit, f"net_{bit}"),
                            "point": [round(point[0], 3), round(point[1], 3)],
                            "reason": "no same-net line segment touches this pin anchor",
                        }
                    )
    return issues


def line_orientation(segment: dict[str, Any], tolerance: float) -> str:
    (x1, y1), (x2, y2) = segment["start"], segment["end"]
    if abs(y1 - y2) <= tolerance:
        return "h"
    if abs(x1 - x2) <= tolerance:
        return "v"
    return "other"


def line_crossings(
    segments: list[dict[str, Any]],
    pin_points: list[tuple[float, float]],
    boxes: dict[str, tuple[float, float, float, float]],
    tolerance: float,
) -> list[dict[str, Any]]:
    crossings: list[dict[str, Any]] = []
    pin_keys = {point_key(point) for point in pin_points}
    horizontal = [segment for segment in segments if line_orientation(segment, tolerance) == "h"]
    vertical = [segment for segment in segments if line_orientation(segment, tolerance) == "v"]
    for h in horizontal:
        hx1, hy = h["start"]
        hx2, _ = h["end"]
        hmin, hmax = sorted((hx1, hx2))
        for v in vertical:
            if h["class"] == v["class"]:
                continue
            vx, vy1 = v["start"]
            _, vy2 = v["end"]
            vmin, vmax = sorted((vy1, vy2))
            if hmin + tolerance < vx < hmax - tolerance and vmin + tolerance < hy < vmax - tolerance:
                key = point_key((vx, hy))
                if key in pin_keys:
                    continue
                crossings.append(
                    {
                        "point": [round(vx, 3), round(hy, 3)],
                        "horizontal_net": h["class"],
                        "vertical_net": v["class"],
                    }
                )
    return crossings


def box_overlap(a: tuple[float, float, float, float], b: tuple[float, float, float, float], margin: float) -> bool:
    return a[0] + margin < b[2] and b[0] + margin < a[2] and a[1] + margin < b[3] and b[1] + margin < a[3]


def component_overlap_issues(boxes: dict[str, tuple[float, float, float, float]], margin: float) -> list[dict[str, Any]]:
    names = sorted(boxes)
    issues: list[dict[str, Any]] = []
    ignored_prefixes = ("IN", "OUT", "gnd_", "vcc_", "vee_")
    for idx, left in enumerate(names):
        if left.startswith(ignored_prefixes):
            continue
        for right in names[idx + 1 :]:
            if right.startswith(ignored_prefixes):
                continue
            if box_overlap(boxes[left], boxes[right], margin):
                issues.append({"left": left, "right": right, "left_box": boxes[left], "right_box": boxes[right]})
    return issues


def ignored_cell_name(name: str) -> bool:
    return name.startswith(("IN", "OUT", "gnd_", "vcc_", "vdd_", "vee_", "vss_"))


def ignored_wire_intrusion_cell(name: str) -> bool:
    # IN/OUT terminals are real visible symbols. A legitimate wire should touch
    # only the pin edge, while unrelated wires must not pass through the port.
    if name in {"IN", "OUT"}:
        return False
    return ignored_cell_name(name)


def interval_overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    left = max(min(a_start, a_end), min(b_start, b_end))
    right = min(max(a_start, a_end), max(b_start, b_end))
    return max(0.0, right - left)


def wire_body_intrusion_issues(
    segments: list[dict[str, Any]],
    boxes: dict[str, tuple[float, float, float, float]],
    tolerance: float,
    terminal_net_classes: dict[str, set[str]] | None = None,
) -> list[dict[str, Any]]:
    terminal_net_classes = terminal_net_classes or {}
    issues: list[dict[str, Any]] = []
    for segment in segments:
        orientation = line_orientation(segment, tolerance)
        if orientation not in {"h", "v"}:
            continue
        (x1, y1), (x2, y2) = segment["start"], segment["end"]
        for name, box in boxes.items():
            if ignored_wire_intrusion_cell(name):
                continue
            if name in {"IN", "OUT"} and segment["class"] in terminal_net_classes.get(name, set()):
                continue
            # Shrink the box so wires ending exactly at edge pins are not flagged.
            left = box[0] + 1.5
            top = box[1] + 1.5
            right = box[2] - 1.5
            bottom = box[3] - 1.5
            if left >= right or top >= bottom:
                continue
            if orientation == "h" and top + tolerance < y1 < bottom - tolerance:
                overlap = interval_overlap(x1, x2, left, right)
                if overlap > tolerance:
                    issues.append(
                        {
                            "cell": name,
                            "net": segment["class"],
                            "segment": {
                                "start": [round(x1, 3), round(y1, 3)],
                                "end": [round(x2, 3), round(y2, 3)],
                            },
                            "reason": "wire passes through component body instead of entering only at a pin",
                        }
                    )
            elif orientation == "v" and left + tolerance < x1 < right - tolerance:
                overlap = interval_overlap(y1, y2, top, bottom)
                if overlap > tolerance:
                    issues.append(
                        {
                            "cell": name,
                            "net": segment["class"],
                            "segment": {
                                "start": [round(x1, 3), round(y1, 3)],
                                "end": [round(x2, 3), round(y2, 3)],
                            },
                            "reason": "wire passes through component body instead of entering only at a pin",
                        }
                    )
    return issues


def component_spacing_issues(
    boxes: dict[str, tuple[float, float, float, float]],
    *,
    min_gap: float,
) -> list[dict[str, Any]]:
    names = sorted(name for name in boxes if not ignored_cell_name(name))
    issues: list[dict[str, Any]] = []
    for idx, left_name in enumerate(names):
        left_box = boxes[left_name]
        for right_name in names[idx + 1 :]:
            right_box = boxes[right_name]
            x_overlap = interval_overlap(left_box[0], left_box[2], right_box[0], right_box[2])
            y_overlap = interval_overlap(left_box[1], left_box[3], right_box[1], right_box[3])
            x_gap = max(right_box[0] - left_box[2], left_box[0] - right_box[2], 0.0)
            y_gap = max(right_box[1] - left_box[3], left_box[1] - right_box[3], 0.0)
            if y_overlap > 1.0 and 0.0 < x_gap < min_gap:
                issues.append(
                    {
                        "left": left_name,
                        "right": right_name,
                        "gap": round(x_gap, 3),
                        "axis": "x",
                        "reason": "component symbols are visually too close",
                    }
                )
            elif x_overlap > 1.0 and 0.0 < y_gap < min_gap:
                issues.append(
                    {
                        "left": left_name,
                        "right": right_name,
                        "gap": round(y_gap, 3),
                        "axis": "y",
                        "reason": "component symbols are visually too close",
                    }
                )
    return issues


def segment_length(segment: dict[str, Any]) -> float:
    (x1, y1), (x2, y2) = segment["start"], segment["end"]
    return math.hypot(x2 - x1, y2 - y1)


def rail_name_kind(name: str) -> str | None:
    lower = name.lower()
    if lower.startswith("gnd_"):
        return "gnd"
    if lower.startswith("vcc_") or lower.startswith("vdd_"):
        return "vcc"
    if lower.startswith("vee_") or lower.startswith("vss_"):
        return "vee"
    return None


def rail_symbol_has_local_connection(
    box: tuple[float, float, float, float],
    segments: list[dict[str, Any]],
    kind: str,
    tolerance: float,
) -> bool:
    left, top, right, bottom = box
    for segment in segments:
        (x1, y1), (x2, y2) = segment["start"], segment["end"]
        if abs(x1 - x2) > tolerance:
            continue
        x = x1
        if x < left - tolerance or x > right + tolerance:
            continue
        seg_top = min(y1, y2)
        seg_bottom = max(y1, y2)
        if kind == "vcc" and seg_top <= bottom + tolerance and seg_bottom > bottom + tolerance:
            return True
        if kind == "vee" and seg_top < top - tolerance and seg_bottom >= top - tolerance:
            return True
    return False


def readability_report(
    payload: dict[str, Any],
    boxes: dict[str, tuple[float, float, float, float]],
    segments: list[dict[str, Any]],
    *,
    missing_pin_connections: list[dict[str, Any]],
    crossings: list[dict[str, Any]],
    overlaps: list[dict[str, Any]],
    wire_body_intrusions: list[dict[str, Any]],
    spacing_issues: list[dict[str, Any]],
    tolerance: float,
) -> dict[str, Any]:
    ignored_prefixes = ("IN", "OUT", "gnd_", "vcc_", "vdd_", "vee_", "vss_")
    main_boxes = {
        name: box
        for name, box in boxes.items()
        if not name.startswith(ignored_prefixes)
    }
    issues: list[dict[str, Any]] = []

    if main_boxes:
        min_main_x = min(box[0] for box in main_boxes.values())
        max_main_x = max(box[2] for box in main_boxes.values())
        min_main_y = min(box[1] for box in main_boxes.values())
        max_main_y = max(box[3] for box in main_boxes.values())

        in_box = boxes.get("IN")
        out_box = boxes.get("OUT")
        if in_box and in_box[2] > min_main_x + tolerance:
            issues.append(
                {
                    "kind": "io_side",
                    "message": "IN terminal is not fully left of the main schematic body",
                    "box": in_box,
                }
            )
        if out_box and out_box[0] < max_main_x - tolerance:
            issues.append(
                {
                    "kind": "io_side",
                    "message": "OUT terminal is not fully right of the main schematic body",
                    "box": out_box,
                }
            )

        for name, box in boxes.items():
            kind = rail_name_kind(name)
            if (
                kind in {"vcc", "vee"}
                and box[1] > min_main_y + tolerance
                and not rail_symbol_has_local_connection(box, segments, kind, tolerance)
            ):
                issues.append(
                    {
                        "kind": "rail_side",
                        "message": f"{name} is not above the main schematic body",
                        "box": box,
                    }
                )

    total_wire_length = sum(segment_length(segment) for segment in segments)
    non_orthogonal = [
        segment
        for segment in segments
        if line_orientation(segment, tolerance) == "other"
    ]
    long_segments = [
        {
            "class": segment["class"],
            "start": segment["start"],
            "end": segment["end"],
            "length": round(segment_length(segment), 3),
        }
        for segment in segments
        if segment_length(segment) > 360.0
    ]
    if non_orthogonal:
        issues.append({"kind": "routing", "message": "Non-orthogonal wire segments found", "count": len(non_orthogonal)})
    if len(long_segments) >= 3:
        issues.append({"kind": "routing", "message": "Several long wire segments may reduce readability", "count": len(long_segments)})
    if wire_body_intrusions:
        issues.append({"kind": "routing", "message": "Wires pass through component bodies", "count": len(wire_body_intrusions)})
    if spacing_issues:
        issues.append({"kind": "spacing", "message": "Some component symbols are too close for a publication schematic", "count": len(spacing_issues)})

    penalties = (
        28 * len(missing_pin_connections)
        + 22 * len(crossings)
        + 18 * len(overlaps)
        + 18 * len(wire_body_intrusions)
        + 4 * len(spacing_issues)
        + 8 * len([issue for issue in issues if issue["kind"] == "io_side"])
        + 6 * len([issue for issue in issues if issue["kind"] == "rail_side"])
        + 4 * len(non_orthogonal)
        + 2 * max(0, len(long_segments) - 2)
        + max(0, len(segments) - 70) // 5
    )
    score = max(0, min(100, 100 - penalties))
    intent = payload.get("schematic_intent", {}) if isinstance(payload.get("schematic_intent"), dict) else {}
    return {
        "score": score,
        "profile": intent.get("profile", "unknown"),
        "ok": score >= 85 and not missing_pin_connections and not crossings and not overlaps,
        "metrics": {
            "wire_length_total": round(total_wire_length, 3),
            "wire_segments": len(segments),
            "long_wire_segments": len(long_segments),
            "non_orthogonal_segments": len(non_orthogonal),
            "wire_body_intrusions": len(wire_body_intrusions),
            "tight_component_spacing": len(spacing_issues),
            "main_component_count": len(main_boxes),
        },
        "issues": issues,
        "long_segments": long_segments[:10],
        "wire_body_intrusions": wire_body_intrusions[:10],
        "tight_component_spacing": spacing_issues[:10],
    }


def check_geometry(svg_path: Path, json_path: Path, *, tolerance: float = 0.75) -> dict[str, Any]:
    payload = read_json(json_path)
    root = ET.parse(svg_path).getroot()
    if is_overview_like(root):
        segments = overview_signal_segments(root)
        boxes = module_overview_boxes(root)
        crossings = line_crossings(segments, [], boxes, tolerance)
        overlaps = component_overlap_issues(boxes, margin=6.0)
        is_module_overview = root.get("data-actoviq-view") == "module-overview"
        label_only_violation = is_module_overview and len(segments) > 0
        min_boxes = 2 if is_module_overview else 1
        ok = not crossings and not overlaps and not label_only_violation and len(boxes) >= min_boxes
        score = max(
            0,
            min(
                100,
                100 - 18 * len(crossings) - 20 * len(overlaps) - (35 if label_only_violation else 0),
            ),
        )
        return {
            "ok": ok,
            "svg_path": str(svg_path),
            "json_path": str(json_path),
            "tolerance": tolerance,
            "summary": {
                "pins_checked": 0,
                "net_segments": len(segments),
                "missing_pin_connections": 0,
                "wire_crossings": len(crossings),
                "component_overlaps": len(overlaps),
                "wire_body_intrusions": 0,
                "tight_component_spacing": 0,
                "readability_score": score,
            },
            "readability": {
                "score": score,
                "profile": root.get("data-actoviq-view") or "overview",
                "ok": ok,
                "metrics": {
                    "module_count": len(boxes),
                    "wire_segments": len(segments),
                    "wire_crossings": len(crossings),
                    "component_overlaps": len(overlaps),
                },
                "issues": [
                    *(
                        [{"kind": "routing", "message": "Overview wires cross", "count": len(crossings)}]
                        if crossings
                        else []
                    ),
                    *(
                        [
                            {
                                "kind": "partitioning",
                                "message": "Module overview must be label-only; remove cross-module wires",
                                "count": len(segments),
                            }
                        ]
                        if label_only_violation
                        else []
                    ),
                    *(
                        [{"kind": "spacing", "message": "Overview module boxes overlap", "count": len(overlaps)}]
                        if overlaps
                        else []
                    ),
                ],
                "long_segments": [],
                "wire_body_intrusions": [],
                "tight_component_spacing": [],
            },
            "missing_pin_connections": [],
            "wire_crossings": crossings,
            "component_overlaps": overlaps,
            "wire_body_intrusions": [],
            "tight_component_spacing": [],
        }

    pins = cell_pin_points(root)
    segments = line_segments(root)
    boxes = cell_boxes(root)
    all_pin_points = [point for cell_pins in pins.values() for point in cell_pins.values()]
    missing_pin_connections = pin_connection_issues(payload, pins, segments, tolerance)
    crossings = line_crossings(segments, all_pin_points, boxes, tolerance)
    overlaps = component_overlap_issues(boxes, margin=1.0)
    wire_body_intrusions = wire_body_intrusion_issues(
        segments,
        boxes,
        tolerance,
        terminal_net_classes=terminal_net_classes(payload),
    )
    spacing_issues = component_spacing_issues(boxes, min_gap=12.0)
    readability = readability_report(
        payload,
        boxes,
        segments,
        missing_pin_connections=missing_pin_connections,
        crossings=crossings,
        overlaps=overlaps,
        wire_body_intrusions=wire_body_intrusions,
        spacing_issues=spacing_issues,
        tolerance=tolerance,
    )
    ok = not missing_pin_connections and not crossings and not overlaps and not wire_body_intrusions
    return {
        "ok": ok,
        "svg_path": str(svg_path),
        "json_path": str(json_path),
        "tolerance": tolerance,
        "summary": {
            "pins_checked": sum(len(item) for item in pins.values()),
            "net_segments": len(segments),
            "missing_pin_connections": len(missing_pin_connections),
            "wire_crossings": len(crossings),
            "component_overlaps": len(overlaps),
            "wire_body_intrusions": len(wire_body_intrusions),
            "tight_component_spacing": len(spacing_issues),
            "readability_score": readability["score"],
        },
        "readability": readability,
        "missing_pin_connections": missing_pin_connections,
        "wire_crossings": crossings,
        "component_overlaps": overlaps,
        "wire_body_intrusions": wire_body_intrusions,
        "tight_component_spacing": spacing_issues,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Check rendered SVG schematic geometry")
    parser.add_argument("--svg-path", required=True)
    parser.add_argument("--json-path", required=True)
    parser.add_argument("--report-path", default="")
    parser.add_argument("--tolerance", type=float, default=0.75)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    report = check_geometry(Path(args.svg_path).resolve(), Path(args.json_path).resolve(), tolerance=args.tolerance)
    if args.report_path:
        report_path = Path(args.report_path).resolve()
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
