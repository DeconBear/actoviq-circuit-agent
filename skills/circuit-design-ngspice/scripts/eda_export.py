#!/usr/bin/env python3
"""Deterministic EDA IR, layout quality, and editable schematic exporters."""

from __future__ import annotations

import hashlib
import heapq
import json
import math
import os
import re
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


EDA_IR_SCHEMA = "actoviq.eda-ir.v1"
QUALITY_SCHEMA = "actoviq.layout-quality.v1"
PATCH_SCHEMA = "actoviq.layout-patch.v1"
SYMBOL_MAP_SCHEMA = "actoviq.eda-symbol-map.v1"
MANIFEST_SCHEMA = "actoviq.eda-export-manifest.v1"
GRID = 20.0
MM_PER_UNIT = 0.127
TARGETS = ("kicad", "altium", "orcad", "virtuoso")
ROTATIONS = {0, 90, 180, 270}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _safe_name(value: str, fallback: str = "design") -> str:
    result = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(value).strip()).strip("._")
    return result or fallback


def _write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(content)
        temporary = Path(handle.name)
    os.replace(temporary, path)


def _write_json(path: Path, value: Any) -> None:
    _write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


class _UnionFind:
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
            self.parent[max(left_root, right_root)] = min(left_root, right_root)


def _project_net_aliases(project: dict[str, Any], modules: dict[str, dict[str, Any]]) -> dict[str, str]:
    union = _UnionFind()
    endpoint_to_local: dict[str, str] = {}
    for module_id, module in modules.items():
        for port in module.get("ports", []):
            endpoint = f"{module_id}:{port.get('id', '')}"
            local = f"{module_id}:{port.get('net', '')}"
            endpoint_to_local[endpoint] = local
            union.union(endpoint, local)
    for connection in project.get("connections", []):
        left = connection.get("from") or {}
        right = connection.get("to") or {}
        left_key = f"{left.get('module_id', '')}:{left.get('port_id', '')}"
        right_key = f"{right.get('module_id', '')}:{right.get('port_id', '')}"
        union.union(left_key, right_key)
    groups: dict[str, list[str]] = {}
    for key in list(union.parent):
        groups.setdefault(union.find(key), []).append(key)
    aliases: dict[str, str] = {}
    for values in groups.values():
        network_names = sorted({
            str(connection.get("network"))
            for connection in project.get("connections", [])
            if connection.get("network") and any(
                f"{endpoint.get('module_id', '')}:{endpoint.get('port_id', '')}" in values
                for endpoint in (connection.get("from") or {}, connection.get("to") or {})
            )
        })
        local_names = sorted(value for value in values if value in endpoint_to_local.values())
        canonical = network_names[0] if network_names else (local_names[0] if local_names else sorted(values)[0])
        for value in values:
            if value in endpoint_to_local.values():
                aliases[value] = canonical
    return aliases


def _included_component(component: dict[str, Any], view: str) -> bool:
    if view == "simulation":
        return True
    return str(component.get("mount_policy", "")) != "testbench_exclude"


def _project_module_view(module: dict[str, Any], view: str) -> dict[str, Any]:
    projected = json.loads(json.dumps(module))
    if view != "design":
        return projected
    existing_nets = {str(port.get("net", "")) for port in projected.get("ports", [])}
    promoted_nets = {
        str(pin.get("net", ""))
        for component in module.get("components", [])
        if not _included_component(component, view)
        for pin in component.get("pins", [])
        if pin.get("net")
    }
    remaining_pin_nets = {
        str(pin.get("net", ""))
        for component in module.get("components", [])
        if _included_component(component, view)
        for pin in component.get("pins", [])
        if pin.get("net")
    }
    if any(net.lower() in {"0", "gnd"} for net in remaining_pin_nets):
        promoted_nets.update(net for net in remaining_pin_nets if net.lower() in {"0", "gnd"})
    for net in sorted(promoted_nets - existing_nets):
        ground = net.lower() in {"0", "gnd"}
        projected.setdefault("ports", []).append({
            "id": f"export_{_safe_name(net)}",
            "name": "GND" if ground else net,
            "direction": "bidirectional",
            "signal_type": "ground" if ground else "analog",
            "net": net,
            "export_promoted": True,
        })
    return projected


def _component_size(component: dict[str, Any]) -> tuple[float, float]:
    if component.get("type") == "BLOCK":
        block = component.get("block") or {}
        return float(block.get("width", 120)), float(block.get("height", 80))
    if component.get("type") in {"M", "Q", "E"}:
        width, height = 90.0, 90.0
    elif component.get("type") in {"V", "I"}:
        width, height = 70.0, 100.0
    else:
        width, height = 100.0, 50.0
    if int(round(float(component.get("rotation", 0)))) % 180 == 90:
        return height, width
    return width, height


def _component_bounds(component: dict[str, Any]) -> dict[str, float]:
    width, height = _component_size(component)
    position = component.get("position") or {}
    x, y = float(position.get("x", 0)), float(position.get("y", 0))
    return {"min_x": x - width / 2, "min_y": y - height / 2, "max_x": x + width / 2, "max_y": y + height / 2}


def _rotate_point(x: float, y: float, rotation: int) -> tuple[float, float]:
    rotation %= 360
    if rotation == 90:
        return -y, x
    if rotation == 180:
        return -x, -y
    if rotation == 270:
        return y, -x
    return x, y


def _pin_position(component: dict[str, Any], pin: dict[str, Any], index: int) -> dict[str, float]:
    pins = component.get("pins") or []
    width, height = _component_size({**component, "rotation": 0})
    side = pin.get("side")
    if not side:
        if len(pins) == 2:
            side = "left" if index == 0 else "right"
        elif component.get("type") == "M":
            side = ("right", "left", "bottom", "top")[min(index, 3)]
        elif component.get("type") == "Q":
            side = ("top", "left", "bottom")[min(index, 2)]
        else:
            side = "left" if index < math.ceil(len(pins) / 2) else "right"
    side_pins = [entry for entry in pins if (entry.get("side") or side) == side]
    side_index = side_pins.index(pin) if pin in side_pins else index
    offset = (side_index - (len(side_pins) - 1) / 2) * GRID
    if side == "left":
        local = (-width / 2, offset)
    elif side == "right":
        local = (width / 2, offset)
    elif side == "top":
        local = (offset, -height / 2)
    else:
        local = (offset, height / 2)
    dx, dy = _rotate_point(*local, int(round(float(component.get("rotation", 0)))))
    position = component.get("position") or {}
    return {"x": float(position.get("x", 0)) + dx, "y": float(position.get("y", 0)) + dy}


def _snap(value: float) -> float:
    return round(value / GRID) * GRID


def _port_positions(module: dict[str, Any], components: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    bounds = [_component_bounds(component) for component in components]
    min_x = min((item["min_x"] for item in bounds), default=0) - 3 * GRID
    max_x = max((item["max_x"] for item in bounds), default=12 * GRID) + 3 * GRID
    min_y = min((item["min_y"] for item in bounds), default=0) - 3 * GRID
    max_y = max((item["max_y"] for item in bounds), default=8 * GRID) + 3 * GRID
    result: dict[str, dict[str, float]] = {}
    counters = {"left": 0, "right": 0, "top": 0, "bottom": 0}
    for port in sorted(module.get("ports", []), key=lambda item: str(item.get("id", ""))):
        stored = port.get("position")
        if isinstance(stored, dict) and all(isinstance(stored.get(axis), (int, float)) for axis in ("x", "y")):
            result[str(port["id"])] = {"x": _snap(float(stored["x"])), "y": _snap(float(stored["y"]))}
            continue
        if port.get("signal_type") == "ground" or str(port.get("net", "")).lower() in {"0", "gnd"}:
            side = "bottom"
        elif port.get("signal_type") == "power":
            side = "top"
        elif port.get("direction") == "output":
            side = "right"
        else:
            side = "left"
        index = counters[side]
        counters[side] += 1
        if side in {"left", "right"}:
            result[str(port["id"])] = {"x": _snap(min_x if side == "left" else max_x), "y": _snap(min_y + (index + 2) * 3 * GRID)}
        else:
            result[str(port["id"])] = {"x": _snap(min_x + (index + 2) * 4 * GRID), "y": _snap(min_y if side == "top" else max_y)}
    return result


def _layout_candidates(module: dict[str, Any], view: str) -> list[list[dict[str, Any]]]:
    source = [json.loads(json.dumps(component)) for component in module.get("components", []) if _included_component(component, view)]
    candidates = [source]
    if not source:
        return candidates
    input_nets = {port.get("net") for port in module.get("ports", []) if port.get("direction") == "input"}
    output_nets = {port.get("net") for port in module.get("ports", []) if port.get("direction") == "output"}
    power_nets = {port.get("net") for port in module.get("ports", []) if port.get("signal_type") == "power"}
    ground_nets = {port.get("net") for port in module.get("ports", []) if port.get("signal_type") == "ground" or str(port.get("net", "")).lower() in {"0", "gnd"}}

    def rank(component: dict[str, Any]) -> int:
        nets = {pin.get("net") for pin in component.get("pins", [])}
        if nets & input_nets:
            return 0
        if nets & output_nets:
            return 3
        if nets & power_nets or nets & ground_nets:
            return 1
        return 2

    movable = sorted(
        (component for component in source if component.get("position") and len(component.get("pins", [])) >= 3),
        key=lambda component: (-len({pin.get("net") for pin in component.get("pins", [])}), str(component.get("id", ""))),
    )[:2]
    for movable_index, component in enumerate(movable):
        offsets = [(-2, 0), (2, 0), (0, -6)]
        if movable_index == 0:
            offsets.append((0, 2))
        for dx_grid, dy_grid in offsets:
            candidate = [json.loads(json.dumps(item)) for item in source]
            moved = next(item for item in candidate if item.get("id") == component.get("id"))
            moved["position"]["x"] = _snap(float(moved["position"].get("x", 0)) + dx_grid * GRID)
            moved["position"]["y"] = _snap(float(moved["position"].get("y", 0)) + dy_grid * GRID)
            candidates.append(candidate)

    for variant in range(1, 9):
        candidate = [json.loads(json.dumps(component)) for component in source]
        groups: dict[int, list[dict[str, Any]]] = {}
        for component in candidate:
            groups.setdefault(rank(component), []).append(component)
        x_gap = (7 + variant % 3) * GRID
        y_gap = (5 + (variant // 3) % 3) * GRID
        for component_rank, group in sorted(groups.items()):
            ordered = sorted(group, key=lambda item: str(item.get("id", "")), reverse=bool(variant & 1))
            top_lane = 0
            main_lane = 0
            bottom_lane = 0
            for component in ordered:
                nets = {pin.get("net") for pin in component.get("pins", [])}
                if nets & power_nets and not nets & ground_nets:
                    lane_y = -(top_lane + 1) * y_gap
                    top_lane += 1
                elif nets & ground_nets and not nets & power_nets:
                    lane_y = (len(ordered) + bottom_lane + 1) * y_gap
                    bottom_lane += 1
                else:
                    lane_y = main_lane * y_gap
                    main_lane += 1
                component["position"] = {"x": component_rank * x_gap, "y": lane_y}
                if len(component.get("pins", [])) == 2:
                    component["rotation"] = 90 if variant in {3, 6} and (nets & (power_nets | ground_nets)) else 0
        candidates.append(candidate)
    return candidates


def _endpoint_ref(endpoint: dict[str, Any]) -> dict[str, Any]:
    return {key: endpoint[key] for key in endpoint if key not in {"x", "y", "kind", "_egress"}}


def _tree_wires(net_name: str, net_id: str, endpoints: list[dict[str, Any]], trunk: float, vertical_trunk: bool) -> list[dict[str, Any]]:
    projected: list[tuple[dict[str, Any], dict[str, float]]] = []
    wires: list[dict[str, Any]] = []
    for endpoint_index, endpoint in enumerate(endpoints):
        endpoint_point = {"x": endpoint["x"], "y": endpoint["y"]}
        egress = endpoint.get("_egress") or {"x": 0, "y": 0}
        escape = {
            "x": endpoint["x"] + float(egress.get("x", 0)) * 2 * GRID,
            "y": endpoint["y"] + float(egress.get("y", 0)) * 2 * GRID,
        }
        projection = {"x": trunk, "y": escape["y"]} if vertical_trunk else {"x": escape["x"], "y": trunk}
        projected.append((endpoint, projection))
        if endpoint_point != projection:
            points = [endpoint_point]
            if escape != endpoint_point and escape != projection:
                points.append(escape)
            points.append(projection)
            wires.append({
                "id": f"{_safe_name(net_id)}-branch-{endpoint_index}", "net_id": net_id, "net": net_name,
                "from": _endpoint_ref(endpoint), "to": {"x": projection["x"], "y": projection["y"]},
                "points": points,
            })
    unique_projections = sorted({(projection["x"], projection["y"]) for _, projection in projected}, key=lambda point: point[1] if vertical_trunk else point[0])
    for index in range(len(unique_projections) - 1):
        left = {"x": unique_projections[index][0], "y": unique_projections[index][1]}
        right = {"x": unique_projections[index + 1][0], "y": unique_projections[index + 1][1]}
        if left != right:
            wires.append({"id": f"{_safe_name(net_id)}-trunk-{index}", "net_id": net_id, "net": net_name, "from": {**left}, "to": {**right}, "points": [left, right]})
    if not wires and len(endpoints) >= 2:
        start = {"x": endpoints[0]["x"], "y": endpoints[0]["y"]}
        end = {"x": endpoints[-1]["x"], "y": endpoints[-1]["y"]}
        wires.append({"id": f"{_safe_name(net_id)}-direct", "net_id": net_id, "net": net_name, "from": _endpoint_ref(endpoints[0]), "to": _endpoint_ref(endpoints[-1]), "points": [start, end]})
    return wires


def _candidate_route_cost(candidate: list[dict[str, Any]], occupied: list[dict[str, Any]], component_bounds: dict[str, dict[str, float]]) -> tuple[int, int, float, int]:
    candidate_segments = list(_segments(candidate))
    occupied_segments = list(_segments(occupied))
    obstructions = 0
    for start, end, wire in candidate_segments:
        obstructions += sum(_segment_intersects_bounds(start, end, bounds) for bounds in component_bounds.values())
    crossings = sum(_strict_segment_cross(left, right) is not None for left in candidate_segments for right in occupied_segments)
    length = sum(abs(end["x"] - start["x"]) + abs(end["y"] - start["y"]) for start, end, _ in candidate_segments)
    return obstructions, crossings, length, len(candidate)


def _route_set_cost(wires: list[dict[str, Any]], component_bounds: dict[str, dict[str, float]]) -> tuple[int, int, float, int]:
    segments = list(_segments(wires))
    obstructions = sum(_segment_intersects_bounds(start, end, bounds) for start, end, _ in segments for bounds in component_bounds.values())
    crossings = sum(_strict_segment_cross(left, right) is not None for index, left in enumerate(segments) for right in segments[index + 1:])
    length = sum(abs(end["x"] - start["x"]) + abs(end["y"] - start["y"]) for start, end, _ in segments)
    bends = sum(max(0, len(wire.get("points") or []) - 2) for wire in wires)
    return obstructions, crossings, length, bends


def _replace_wire_segment(wires: list[dict[str, Any]], wire_index: int, point_index: int, replacement: list[dict[str, float]]) -> list[dict[str, Any]]:
    result = json.loads(json.dumps(wires))
    points = result[wire_index]["points"]
    compact: list[dict[str, float]] = []
    for point in [*points[:point_index], *replacement, *points[point_index + 2:]]:
        if not compact or compact[-1] != point:
            compact.append(point)
    result[wire_index]["points"] = compact
    return result


def _maze_reroute_wire(wires: list[dict[str, Any]], wire_index: int, component_bounds: dict[str, dict[str, float]]) -> list[dict[str, Any]] | None:
    wire = wires[wire_index]
    points = wire.get("points") or []
    if len(points) < 2:
        return None
    prefix = points[:2] if len(points) >= 3 else points[:1]
    start = prefix[-1]
    end = points[-1]
    step = 5.0
    all_points = [point for candidate in wires for point in candidate.get("points", [])]
    min_x = math.floor((min([point["x"] for point in all_points] + [bounds["min_x"] for bounds in component_bounds.values()]) - 8 * GRID) / step) * step
    max_x = math.ceil((max([point["x"] for point in all_points] + [bounds["max_x"] for bounds in component_bounds.values()]) + 8 * GRID) / step) * step
    min_y = math.floor((min([point["y"] for point in all_points] + [bounds["min_y"] for bounds in component_bounds.values()]) - 8 * GRID) / step) * step
    max_y = math.ceil((max([point["y"] for point in all_points] + [bounds["max_y"] for bounds in component_bounds.values()]) + 8 * GRID) / step) * step
    blocked_axes: dict[tuple[float, float], set[str]] = {}
    for candidate in wires:
        if candidate is wire or candidate.get("net_id") == wire.get("net_id"):
            continue
        for left, right, _ in _segments([candidate]):
            axis = "vertical" if left["x"] == right["x"] else "horizontal"
            length = int(max(abs(right["x"] - left["x"]), abs(right["y"] - left["y"])) / step)
            for index in range(length + 1):
                ratio = index / max(1, length)
                point = (round((left["x"] + (right["x"] - left["x"]) * ratio) / step) * step, round((left["y"] + (right["y"] - left["y"]) * ratio) / step) * step)
                blocked_axes.setdefault(point, set()).add(axis)
    start_key = (round(start["x"] / step) * step, round(start["y"] / step) * step)
    end_key = (round(end["x"] / step) * step, round(end["y"] / step) * step)
    blocked_axes.pop(start_key, None)
    blocked_axes.pop(end_key, None)

    def forbidden(x: float, y: float) -> bool:
        if (x, y) in {start_key, end_key}:
            return False
        return any(bounds["min_x"] < x < bounds["max_x"] and bounds["min_y"] < y < bounds["max_y"] for bounds in component_bounds.values())

    directions = ((step, 0.0), (-step, 0.0), (0.0, step), (0.0, -step))
    queue: list[tuple[float, float, float, float, int]] = []
    heapq.heappush(queue, (0.0, 0.0, start_key[0], start_key[1], -1))
    best: dict[tuple[float, float, int], float] = {(start_key[0], start_key[1], -1): 0.0}
    parent: dict[tuple[float, float, int], tuple[float, float, int]] = {}
    goal: tuple[float, float, int] | None = None
    while queue:
        _, cost, x, y, direction = heapq.heappop(queue)
        state = (x, y, direction)
        if cost != best.get(state):
            continue
        if (x, y) == end_key:
            goal = state
            break
        for next_direction, (dx, dy) in enumerate(directions):
            nx, ny = x + dx, y + dy
            if nx < min_x or nx > max_x or ny < min_y or ny > max_y or forbidden(nx, ny):
                continue
            crossing_axis = "vertical" if dx else "horizontal"
            wire_penalty = 10_000.0 if crossing_axis in blocked_axes.get((nx, ny), set()) else 0.0
            next_cost = cost + 1.0 + wire_penalty + (0.35 if direction not in {-1, next_direction} else 0.0)
            next_state = (nx, ny, next_direction)
            if next_cost >= best.get(next_state, float("inf")):
                continue
            best[next_state] = next_cost
            parent[next_state] = state
            heuristic = (abs(end_key[0] - nx) + abs(end_key[1] - ny)) / step
            heapq.heappush(queue, (next_cost + heuristic, next_cost, nx, ny, next_direction))
    if goal is None:
        return None
    path: list[dict[str, float]] = []
    state = goal
    while True:
        path.append({"x": state[0], "y": state[1]})
        if state not in parent:
            break
        state = parent[state]
    path.reverse()
    compact: list[dict[str, float]] = []
    for point in [*prefix[:-1], *path]:
        if compact and compact[-1] == point:
            continue
        if len(compact) >= 2:
            left, middle = compact[-2], compact[-1]
            if (left["x"] == middle["x"] == point["x"]) or (left["y"] == middle["y"] == point["y"]):
                compact[-1] = point
                continue
        compact.append(point)
    result = json.loads(json.dumps(wires))
    result[wire_index]["points"] = compact
    return result


def _ripup_crossings(wires: list[dict[str, Any]], component_bounds: dict[str, dict[str, float]]) -> list[dict[str, Any]]:
    current = wires
    for _ in range(12):
        indexed_segments = [
            (wire_index, point_index, points[point_index], points[point_index + 1], wire)
            for wire_index, wire in enumerate(current)
            for points in [wire.get("points") or []]
            for point_index in range(len(points) - 1)
        ]
        crossing_pair = next((
            (left, right)
            for index, left in enumerate(indexed_segments)
            for right in indexed_segments[index + 1:]
            if _strict_segment_cross((left[2], left[3], left[4]), (right[2], right[3], right[4])) is not None
        ), None)
        if not crossing_pair:
            break
        variants: list[list[dict[str, Any]]] = []
        for segment, obstacle in (crossing_pair, (crossing_pair[1], crossing_pair[0])):
            wire_index, point_index, start, end, _ = segment
            obstacle_start, obstacle_end = obstacle[2], obstacle[3]
            obstacle_points = obstacle[4].get("points") or [obstacle_start, obstacle_end]
            if start["y"] == end["y"]:
                for offset in (2, 4, 6, 8):
                    for detour_y in (min(point["y"] for point in obstacle_points) - offset * GRID, max(point["y"] for point in obstacle_points) + offset * GRID):
                        variants.append(_replace_wire_segment(current, wire_index, point_index, [start, {"x": start["x"], "y": detour_y}, {"x": end["x"], "y": detour_y}, end]))
            elif start["x"] == end["x"]:
                for offset in (2, 4, 6, 8):
                    for detour_x in (min(point["x"] for point in obstacle_points) - offset * GRID, max(point["x"] for point in obstacle_points) + offset * GRID):
                        variants.append(_replace_wire_segment(current, wire_index, point_index, [start, {"x": detour_x, "y": start["y"]}, {"x": detour_x, "y": end["y"]}, end]))
        baseline = _route_set_cost(current, component_bounds)
        improving = [variant for variant in variants if _route_set_cost(variant, component_bounds)[:2] < baseline[:2]]
        if not improving:
            for wire_index in {crossing_pair[0][0], crossing_pair[1][0]}:
                variant = _maze_reroute_wire(current, wire_index, component_bounds)
                if variant is not None and _route_set_cost(variant, component_bounds)[:2] < baseline[:2]:
                    improving.append(variant)
        if not improving:
            break
        current = min(improving, key=lambda variant: _route_set_cost(variant, component_bounds))
    return current


def _route_module(module: dict[str, Any], components: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, dict[str, float]]]:
    ports = _port_positions(module, components)
    endpoints_by_net: dict[str, list[dict[str, Any]]] = {}
    for component in components:
        for index, pin in enumerate(component.get("pins", [])):
            point = _pin_position(component, pin, index)
            position = component.get("position") or {}
            dx = point["x"] - float(position.get("x", 0))
            dy = point["y"] - float(position.get("y", 0))
            egress = {"x": (1 if dx > 0 else -1) if abs(dx) >= abs(dy) else 0, "y": (1 if dy > 0 else -1) if abs(dy) > abs(dx) else 0}
            endpoints_by_net.setdefault(str(pin.get("net", "")), []).append({
                "kind": "pin", "component_id": component["id"], "pin_id": pin["id"], "_egress": egress, **point,
            })
    for port in module.get("ports", []):
        if str(port.get("id", "")) in ports:
            endpoints_by_net.setdefault(str(port.get("net", "")), []).append({
                "kind": "port", "port_id": port["id"], **ports[str(port["id"])],
            })
    nets: list[dict[str, Any]] = []
    declared_nets = {str(item.get("name", item.get("id", ""))): item for item in module.get("nets", [])}
    for net_name, endpoints in sorted(endpoints_by_net.items()):
        endpoints = sorted(endpoints, key=lambda item: (item["x"], item["y"], item.get("component_id", ""), item.get("port_id", "")))
        net_id = str((declared_nets.get(net_name) or {}).get("id", net_name))
        nets.append({"id": net_id, "name": net_name, "endpoints": endpoints})
    component_bounds = {str(component["id"]): _component_bounds(component) for component in components}
    route_orders = [
        sorted(nets, key=lambda item: (-len(item["endpoints"]), str(item["id"]))),
        sorted(nets, key=lambda item: (len(item["endpoints"]), str(item["id"]))),
        sorted(nets, key=lambda item: str(item["id"])),
        sorted(nets, key=lambda item: (str(item["name"]).lower() in {"0", "gnd"}, -len(item["endpoints"]), str(item["id"]))),
        sorted(nets, key=lambda item: (str(item["name"]).lower() not in {"0", "gnd"}, -len(item["endpoints"]), str(item["id"]))),
        sorted(nets, key=lambda item: (str(item["name"]).lower() not in {"out", "output", "fb", "feedback"}, -len(item["endpoints"]), str(item["id"]))),
    ]
    routed_variants: list[list[dict[str, Any]]] = []
    seen_orders: set[tuple[str, ...]] = set()
    for route_order in route_orders:
        order_key = tuple(str(net["id"]) for net in route_order)
        if order_key in seen_orders:
            continue
        seen_orders.add(order_key)
        routed: list[dict[str, Any]] = []
        for net in route_order:
            endpoints = net["endpoints"]
            if len(endpoints) < 2:
                continue
            route_candidates: list[list[dict[str, Any]]] = []
            for vertical_trunk in (True, False):
                axis = "x" if vertical_trunk else "y"
                coordinates = sorted(float(item[axis]) for item in endpoints)
                median = _snap(coordinates[len(coordinates) // 2])
                trunk_candidates = {median, *(_snap(value) for value in coordinates)}
                for offset in range(1, 9):
                    trunk_candidates.update({median - offset * GRID, median + offset * GRID})
                for trunk in sorted(trunk_candidates):
                    route_candidates.append(_tree_wires(net["name"], net["id"], endpoints, trunk, vertical_trunk))
            routed.extend(min(route_candidates, key=lambda candidate: _candidate_route_cost(candidate, routed, component_bounds)))
        routed_variants.append(routed)
    wires = _ripup_crossings(min(routed_variants, key=lambda candidate: _route_set_cost(candidate, component_bounds)), component_bounds)
    return nets, wires, ports


def _segments(wires: Iterable[dict[str, Any]]) -> Iterable[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]]:
    for wire in wires:
        points = wire.get("points") or []
        for index in range(len(points) - 1):
            yield points[index], points[index + 1], wire


def _strict_segment_cross(left: tuple[dict[str, Any], dict[str, Any], dict[str, Any]], right: tuple[dict[str, Any], dict[str, Any], dict[str, Any]]) -> dict[str, float] | None:
    a, b, aw = left
    c, d, bw = right
    if aw.get("net_id") == bw.get("net_id"):
        return None
    a_vertical, c_vertical = a["x"] == b["x"], c["x"] == d["x"]
    if a_vertical == c_vertical:
        return None
    vertical_a, vertical_b, horizontal_a, horizontal_b = (a, b, c, d) if a_vertical else (c, d, a, b)
    x, y = vertical_a["x"], horizontal_a["y"]
    if min(vertical_a["y"], vertical_b["y"]) < y < max(vertical_a["y"], vertical_b["y"]) and min(horizontal_a["x"], horizontal_b["x"]) < x < max(horizontal_a["x"], horizontal_b["x"]):
        return {"x": x, "y": y}
    return None


def _segment_intersects_bounds(start: dict[str, float], end: dict[str, float], bounds: dict[str, float]) -> bool:
    epsilon = 1e-6
    if abs(start["x"] - end["x"]) < epsilon:
        x = start["x"]
        return bounds["min_x"] + epsilon < x < bounds["max_x"] - epsilon and max(min(start["y"], end["y"]), bounds["min_y"] + epsilon) < min(max(start["y"], end["y"]), bounds["max_y"] - epsilon)
    if abs(start["y"] - end["y"]) < epsilon:
        y = start["y"]
        return bounds["min_y"] + epsilon < y < bounds["max_y"] - epsilon and max(min(start["x"], end["x"]), bounds["min_x"] + epsilon) < min(max(start["x"], end["x"]), bounds["max_x"] - epsilon)
    return False


def _issue(category: str, severity: str, *, components: Iterable[str] = (), nets: Iterable[str] = (), bounds: dict[str, float] | None = None, fix: str) -> dict[str, Any]:
    return {
        "category": category, "severity": severity,
        "component_ids": sorted(set(components)), "net_ids": sorted(set(nets)),
        "bounds": bounds, "fix_category": fix,
    }


def score_layout(module_id: str, components: list[dict[str, Any]], nets: list[dict[str, Any]], wires: list[dict[str, Any]], ports: dict[str, dict[str, float]], connectivity_hash: str) -> dict[str, Any]:
    issues: list[dict[str, Any]] = []
    for net in nets:
        if len(net["endpoints"]) < 2 and not any(endpoint.get("kind") == "port" for endpoint in net["endpoints"]):
            issues.append(_issue("unexpected_single_ended_net", "error", nets=[net["id"]], fix="connect_or_mark_no_connect"))
    component_bounds = {str(component["id"]): _component_bounds(component) for component in components}
    component_ids = sorted(component_bounds)
    for index, left_id in enumerate(component_ids):
        left = component_bounds[left_id]
        for right_id in component_ids[index + 1:]:
            right = component_bounds[right_id]
            if left["min_x"] < right["max_x"] and left["max_x"] > right["min_x"] and left["min_y"] < right["max_y"] and left["max_y"] > right["min_y"]:
                issues.append(_issue("component_overlap", "error", components=[left_id, right_id], bounds={
                    "min_x": max(left["min_x"], right["min_x"]), "min_y": max(left["min_y"], right["min_y"]),
                    "max_x": min(left["max_x"], right["max_x"]), "max_y": min(left["max_y"], right["max_y"]),
                }, fix="move_component"))
    segments = list(_segments(wires))
    for start, end, wire in segments:
        for component_id, bounds in component_bounds.items():
            if _segment_intersects_bounds(start, end, bounds):
                issues.append(_issue("wire_through_component", "error", components=[component_id], nets=[wire.get("net_id", "")], bounds=bounds, fix="reroute_net"))
    crossings: list[dict[str, float]] = []
    for index, left in enumerate(segments):
        for right in segments[index + 1:]:
            crossing = _strict_segment_cross(left, right)
            if crossing:
                crossings.append(crossing)
                issues.append(_issue("wire_crossing", "warning", nets=[left[2].get("net_id", ""), right[2].get("net_id", "")], bounds={"min_x": crossing["x"], "min_y": crossing["y"], "max_x": crossing["x"], "max_y": crossing["y"]}, fix="reroute_net"))
    bends = sum(max(0, len(wire.get("points") or []) - 2) for wire in wires)
    total_length = sum(abs(end["x"] - start["x"]) + abs(end["y"] - start["y"]) for start, end, _ in segments)
    long_wires = sum(1 for wire in wires if sum(abs(end["x"] - start["x"]) + abs(end["y"] - start["y"]) for start, end, candidate in segments if candidate is wire) > 20 * GRID)
    category_counts = {category: sum(issue["category"] == category for issue in issues) for category in {
        "unexpected_single_ended_net", "component_overlap", "wire_through_component", "wire_crossing",
    }}
    readability = max(0.0, min(100.0, 100.0 - category_counts.get("unexpected_single_ended_net", 0) * 30 - category_counts.get("component_overlap", 0) * 25 - category_counts.get("wire_through_component", 0) * 20 - len(crossings) * 8 - bends * 0.15 - long_wires * 1.5))
    vector = [
        category_counts.get("unexpected_single_ended_net", 0),
        category_counts.get("component_overlap", 0) + category_counts.get("wire_through_component", 0),
        len(crossings), 0, 0, bends + long_wires, 0, round(100.0 - readability, 3),
    ]
    return {
        "schema": QUALITY_SCHEMA, "module_id": module_id, "connectivity_hash": connectivity_hash,
        "lexicographic_cost": vector, "readability_score": round(readability, 3),
        "metrics": {"missing_connections": category_counts.get("unexpected_single_ended_net", 0), "component_overlaps": category_counts.get("component_overlap", 0), "wire_through_components": category_counts.get("wire_through_component", 0), "wire_crossings": len(crossings), "label_overlaps": 0, "congestion": 0, "bends": bends, "long_wires": long_wires, "total_length": round(total_length, 3)},
        "issues": issues,
    }


def validate_layout_patch(patch: dict[str, Any], component_ids: set[str], port_ids: set[str]) -> list[dict[str, Any]]:
    if patch.get("schema") != PATCH_SCHEMA:
        raise ValueError(f"layout patch schema must be {PATCH_SCHEMA}")
    operations = patch.get("operations")
    if not isinstance(operations, list) or len(operations) > 32:
        raise ValueError("layout patch operations must be a list with at most 32 entries")
    normalized: list[dict[str, Any]] = []
    for operation in operations:
        kind = operation.get("op")
        if kind == "move_component":
            component_id = str(operation.get("component_id", ""))
            dx, dy = int(operation.get("dx_grid", 0)), int(operation.get("dy_grid", 0))
            if component_id not in component_ids or abs(dx) > 6 or abs(dy) > 6:
                raise ValueError(f"invalid move_component operation for {component_id}")
            normalized.append({"op": kind, "component_id": component_id, "dx_grid": dx, "dy_grid": dy})
        elif kind == "rotate_component":
            component_id, rotation = str(operation.get("component_id", "")), int(operation.get("rotation", -1))
            if component_id not in component_ids or rotation not in ROTATIONS:
                raise ValueError(f"invalid rotate_component operation for {component_id}")
            normalized.append({"op": kind, "component_id": component_id, "rotation": rotation})
        elif kind == "move_port":
            port_id = str(operation.get("port_id", ""))
            dx, dy = int(operation.get("dx_grid", 0)), int(operation.get("dy_grid", 0))
            if port_id not in port_ids or abs(dx) > 6 or abs(dy) > 6:
                raise ValueError(f"invalid move_port operation for {port_id}")
            normalized.append({"op": kind, "port_id": port_id, "dx_grid": dx, "dy_grid": dy})
        elif kind in {"set_block_pin_side", "set_layout_lane"}:
            normalized.append(dict(operation))
        else:
            raise ValueError(f"layout patch operation is not allowed: {kind}")
    return normalized


def _connectivity_records(project: dict[str, Any], modules: dict[str, dict[str, Any]], scope_module: str | None, view: str) -> list[dict[str, str]]:
    aliases = _project_net_aliases(project, modules)
    records: list[dict[str, str]] = []
    for module_id, module in sorted(modules.items()):
        if scope_module and module_id != scope_module:
            continue
        for component in sorted(module.get("components", []), key=lambda item: str(item.get("id", ""))):
            if not _included_component(component, view):
                continue
            for pin in sorted(component.get("pins", []), key=lambda item: str(item.get("id", ""))):
                local_net = str(pin.get("net", ""))
                records.append({"module_id": module_id, "component_id": str(component.get("id", "")), "pin_id": str(pin.get("id", "")), "net": aliases.get(f"{module_id}:{local_net}", f"{module_id}:{local_net}")})
        for port in sorted(module.get("ports", []), key=lambda item: str(item.get("id", ""))):
            local_net = str(port.get("net", ""))
            records.append({"module_id": module_id, "port_id": str(port.get("id", "")), "net": aliases.get(f"{module_id}:{local_net}", f"{module_id}:{local_net}")})
    return records


def connectivity_hash(project: dict[str, Any], modules: dict[str, dict[str, Any]], scope_module: str | None = None, view: str = "design") -> str:
    return _sha256_bytes(_canonical_json(_connectivity_records(project, modules, scope_module, view)))


def build_eda_ir(project: dict[str, Any], modules: dict[str, dict[str, Any]], *, scope: str, module_id: str | None, view: str, document_hash: str) -> tuple[dict[str, Any], dict[str, Any]]:
    selected = {key: value for key, value in modules.items() if scope == "project" or key == module_id}
    if scope == "module" and not selected:
        raise ValueError(f"module not found: {module_id}")
    source_connectivity_hash = connectivity_hash(project, selected, module_id if scope == "module" else None, view)
    pages: list[dict[str, Any]] = []
    reports: list[dict[str, Any]] = []
    for selected_module_id, module in sorted(selected.items()):
        projected_module = _project_module_view(module, view)
        winners: list[tuple[list[Any], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], dict[str, dict[str, float]], dict[str, Any]]] = []
        for components in _layout_candidates(projected_module, view):
            nets, wires, ports = _route_module(projected_module, components)
            report = score_layout(selected_module_id, components, nets, wires, ports, source_connectivity_hash)
            winners.append((report["lexicographic_cost"], components, nets, wires, ports, report))
        _, components, nets, wires, ports, report = min(winners, key=lambda item: item[0])
        reports.append(report)
        pages.append({
            "id": selected_module_id, "name": module.get("name", selected_module_id),
            "revision": module.get("revision", 0), "components": components,
            "ports": [{**port, "position": ports.get(str(port.get("id", "")))} for port in projected_module.get("ports", [])],
            "nets": nets, "wires": wires, "annotations": module.get("annotations", []),
            "spice": module.get("spice", {}),
        })
    ir = {
        "schema": EDA_IR_SCHEMA,
        "source": {"project_id": project["project_id"], "revision": project["revision"], "document_hash": document_hash, "scope": scope, "module_id": module_id, "view": view},
        "coordinate_system": {"unit": "actoviq", "grid": GRID, "mm_per_unit": MM_PER_UNIT},
        "project": {"id": project["project_id"], "name": project.get("name", project["project_id"]), "connections": project.get("connections", [])},
        "pages": pages,
        "connectivity": {"records": _connectivity_records(project, selected, module_id if scope == "module" else None, view), "hash": source_connectivity_hash},
    }
    aggregate = {
        "schema": QUALITY_SCHEMA, "scope": scope, "module_id": module_id,
        "connectivity_hash": source_connectivity_hash, "modules": reports,
        "lexicographic_cost": [sum(report["lexicographic_cost"][index] for report in reports) for index in range(8)],
        "readability_score": round(sum(report["readability_score"] for report in reports) / max(1, len(reports)), 3),
        "issues": [issue for report in reports for issue in report["issues"]],
    }
    return ir, aggregate


def _load_symbol_map(path: str, pages: list[dict[str, Any]]) -> dict[str, Any]:
    mapping = json.loads(Path(path).read_text(encoding="utf-8")) if path else {"schema": SYMBOL_MAP_SCHEMA, "targets": {}}
    if mapping.get("schema") != SYMBOL_MAP_SCHEMA:
        raise ValueError(f"mapping file schema must be {SYMBOL_MAP_SCHEMA}")
    targets = mapping.setdefault("targets", {})
    for target in TARGETS:
        target_map = targets.setdefault(target, {})
        overrides = target_map.get("components", {})
        type_overrides = target_map.get("types", {})
        for page in pages:
            for component in page["components"]:
                entry = overrides.get(component["id"]) or type_overrides.get(component["type"])
                if not entry:
                    continue
                pin_map = entry.get("pin_map") or {}
                source_pins = {str(pin["id"]) for pin in component.get("pins", [])}
                if set(pin_map) != source_pins or len(set(pin_map.values())) != len(pin_map) or any(not str(value) for value in pin_map.values()):
                    raise ValueError(f"incomplete or duplicate {target} pin map for {component['id']}")
    return mapping


def _svg_preview(ir: dict[str, Any]) -> str:
    page = ir["pages"][0] if ir["pages"] else {"components": [], "wires": [], "ports": []}
    points = [component.get("position", {}) for component in page["components"]] + [point for wire in page["wires"] for point in wire.get("points", [])]
    min_x = min((float(point.get("x", 0)) for point in points), default=0) - 100
    min_y = min((float(point.get("y", 0)) for point in points), default=0) - 100
    max_x = max((float(point.get("x", 0)) for point in points), default=800) + 100
    max_y = max((float(point.get("y", 0)) for point in points), default=600) + 100
    lines = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{min_x} {min_y} {max_x-min_x} {max_y-min_y}">', '<rect x="-10000" y="-10000" width="20000" height="20000" fill="white"/>']
    for wire in page["wires"]:
        points_text = " ".join(f'{point["x"]},{point["y"]}' for point in wire["points"])
        lines.append(f'<polyline points="{points_text}" fill="none" stroke="#188038" stroke-width="3" data-net="{wire["net_id"]}"/>')
    for component in page["components"]:
        bounds = _component_bounds(component)
        lines.append(f'<rect x="{bounds["min_x"]}" y="{bounds["min_y"]}" width="{bounds["max_x"]-bounds["min_x"]}" height="{bounds["max_y"]-bounds["min_y"]}" fill="white" stroke="#a00020" stroke-width="2"/>')
        lines.append(f'<text x="{bounds["max_x"]+10}" y="{component["position"]["y"]}" font-family="sans-serif" font-size="18" fill="#1a0dab">{component["name"]}</text>')
    lines.append("</svg>\n")
    return "\n".join(lines)


def _sexpr_string(value: Any) -> str:
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _stable_uuid(*parts: Any) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "actoviq:" + ":".join(map(str, parts))))


def _kicad_symbol_name(page_id: str, component: dict[str, Any]) -> str:
    return _safe_name(f"{page_id}_{component['id']}")


def _kicad_symbol_definition(name: str, component: dict[str, Any], *, embedded: bool, indent: str) -> list[str]:
    symbol_name = f"Actoviq_Generic:{name}" if embedded else name
    width, height = _component_size({**component, "rotation": 0})
    half_width = max(2.54, width * MM_PER_UNIT / 2 - 2.54)
    half_height = max(1.27, height * MM_PER_UNIT / 2 - 1.27)
    reference = str(component.get("type", "X"))[:1] or "X"
    lines = [
        f"{indent}(symbol {_sexpr_string(symbol_name)}",
        f"{indent}  (pin_names (offset 1.27))",
        f"{indent}  (exclude_from_sim no) (in_bom yes) (on_board no)",
        f"{indent}  (property \"Reference\" {_sexpr_string(reference)} (at 0 {-half_height-2.54:.4f} 0) (effects (font (size 1.27 1.27))))",
        f"{indent}  (property \"Value\" {_sexpr_string(component.get('value', ''))} (at 0 {half_height+2.54:.4f} 0) (effects (font (size 1.27 1.27))))",
        f"{indent}  (property \"Footprint\" \"\" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))",
        f"{indent}  (property \"Datasheet\" \"~\" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))",
        f"{indent}  (property \"Description\" \"Actoviq generated generic symbol\" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))",
        f"{indent}  (symbol {_sexpr_string(name + '_0_1')}",
        f"{indent}    (rectangle (start {-half_width:.4f} {-half_height:.4f}) (end {half_width:.4f} {half_height:.4f}) (stroke (width 0) (type default)) (fill (type background)))",
        f"{indent}  )",
        f"{indent}  (symbol {_sexpr_string(name + '_1_1')}",
    ]
    for index, pin in enumerate(component.get("pins", [])):
        point = _pin_position({**component, "position": {"x": 0, "y": 0}, "rotation": 0}, pin, index)
        x, y = point["x"] * MM_PER_UNIT, point["y"] * MM_PER_UNIT
        side = pin.get("side")
        if not side:
            if len(component.get("pins", [])) == 2:
                side = "left" if index == 0 else "right"
            elif component.get("type") == "M":
                side = ("right", "left", "bottom", "top")[min(index, 3)]
            elif component.get("type") == "Q":
                side = ("top", "left", "bottom")[min(index, 2)]
            else:
                side = "left" if index < math.ceil(len(component.get("pins", [])) / 2) else "right"
        angle = {"left": 0, "right": 180, "top": 270, "bottom": 90}[side]
        lines.append(
            f"{indent}    (pin passive line (at {x:.4f} {y:.4f} {angle}) (length 2.54) "
            f"(name {_sexpr_string(pin.get('name', pin['id']))} (effects (font (size 1.27 1.27)))) "
            f"(number {_sexpr_string(pin['id'])} (effects (font (size 1.27 1.27)))))"
        )
    lines.extend([f"{indent}  )", f"{indent})"])
    return lines


def _kicad_page_lines(project_name: str, page: dict[str, Any], all_components: list[dict[str, Any]]) -> list[str]:
    page_uuid = _stable_uuid(project_name, page["id"])
    lines = ["(kicad_sch (version 20231120) (generator actoviq)", f"  (uuid {page_uuid})", "  (paper \"A4\")", "  (lib_symbols"]
    for entry in all_components:
        lines.extend(_kicad_symbol_definition(_kicad_symbol_name(entry["page_id"], entry), entry, embedded=True, indent="    "))
    lines.append("  )")
    for wire in page["wires"]:
        points = wire.get("points") or []
        for index in range(len(points) - 1):
            left, right = points[index], points[index + 1]
            lines.append(f"  (wire (pts (xy {left['x']*MM_PER_UNIT:.4f} {left['y']*MM_PER_UNIT:.4f}) (xy {right['x']*MM_PER_UNIT:.4f} {right['y']*MM_PER_UNIT:.4f})) (stroke (width 0) (type default)) (uuid {_stable_uuid(page['id'], wire['id'], index)}))")
    for net in page["nets"]:
        if net["endpoints"]:
            point = net["endpoints"][0]
            lines.append(f"  (global_label {_sexpr_string(net['name'])} (shape bidirectional) (at {point['x']*MM_PER_UNIT:.4f} {point['y']*MM_PER_UNIT:.4f} 0) (fields_autoplaced yes) (effects (font (size 1.27 1.27)) (justify left)) (uuid {_stable_uuid(page['id'], net['id'])}))")
    for port in page["ports"]:
        position = port.get("position")
        if not position:
            continue
        shape = {"input": "input", "output": "output"}.get(port.get("direction"), "bidirectional")
        lines.append(f"  (hierarchical_label {_sexpr_string(port['name'])} (shape {shape}) (at {position['x']*MM_PER_UNIT:.4f} {position['y']*MM_PER_UNIT:.4f} 0) (fields_autoplaced yes) (effects (font (size 1.27 1.27)) (justify left)) (uuid {_stable_uuid(page['id'], 'port', port['id'])}))")
    for component in page["components"]:
        position = component["position"]
        symbol_name = _kicad_symbol_name(page["id"], component)
        lines.extend([
            f"  (symbol (lib_id {_sexpr_string('Actoviq_Generic:' + symbol_name)}) (at {position['x']*MM_PER_UNIT:.4f} {position['y']*MM_PER_UNIT:.4f} {int(component.get('rotation', 0))}) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board no) (dnp no) (uuid {_stable_uuid(page['id'], component['id'])})",
            f"    (property \"Reference\" {_sexpr_string(component['name'])} (at {position['x']*MM_PER_UNIT:.4f} {(position['y']-30)*MM_PER_UNIT:.4f} 0) (effects (font (size 1.27 1.27))))",
            f"    (property \"Value\" {_sexpr_string(component.get('value', ''))} (at {position['x']*MM_PER_UNIT:.4f} {(position['y']+30)*MM_PER_UNIT:.4f} 0) (effects (font (size 1.27 1.27))))",
            f"    (property \"ACTOVIQ_ID\" {_sexpr_string(component['id'])} (at 0 0 0) (effects (font (size 1.27 1.27)) hide))",
        ])
        for pin in component.get("pins", []):
            lines.append(f"    (pin {_sexpr_string(pin['id'])} (uuid {_stable_uuid(page['id'], component['id'], pin['id'])}))")
        lines.extend([
            "    (instances",
            f"      (project {_sexpr_string(project_name)} (path {_sexpr_string('/' + page_uuid)} (reference {_sexpr_string(component['name'])}) (unit 1)))",
            "    )",
            "  )",
        ])
    lines.extend([f"  (sheet_instances (path \"/\" (page \"1\")))", ")\n"])
    return lines


def _write_kicad(root: Path, project_name: str, ir: dict[str, Any]) -> list[Path]:
    target = root / "kicad"
    target.mkdir(parents=True, exist_ok=True)
    pro = target / f"{project_name}.kicad_pro"
    _write_json(pro, {"board": {}, "boards": [], "cvpcb": {}, "erc": {}, "libraries": {}, "meta": {"filename": pro.name, "version": 1}, "net_settings": {}, "pcbnew": {}, "schematic": {}, "text_variables": {}})
    symbols = target / "Actoviq_Generic.kicad_sym"
    all_components = [{**component, "page_id": page["id"]} for page in ir["pages"] for component in page["components"]]
    symbol_lines = ["(kicad_symbol_lib (version 20231120) (generator actoviq)"]
    for component in all_components:
        symbol_lines.extend(_kicad_symbol_definition(_kicad_symbol_name(component["page_id"], component), component, embedded=False, indent="  "))
    symbol_lines.append(")\n")
    _write_text(symbols, "\n".join(symbol_lines))
    sym_table = target / "sym-lib-table"
    _write_text(sym_table, '(sym_lib_table\n  (version 7)\n  (lib (name "Actoviq_Generic")(type "KiCad")(uri "${KIPRJMOD}/Actoviq_Generic.kicad_sym")(options "")(descr "Actoviq generated symbols"))\n)\n')
    schematic_files: list[Path] = []
    for page in ir["pages"]:
        page_name = project_name if len(ir["pages"]) == 1 else f"{project_name}-{_safe_name(page['id'])}"
        schematic = target / f"{page_name}.kicad_sch"
        _write_text(schematic, "\n".join(_kicad_page_lines(project_name, page, all_components)))
        schematic_files.append(schematic)
    if len(ir["pages"]) > 1:
        root_schematic = target / f"{project_name}.kicad_sch"
        root_uuid = _stable_uuid(project_name, "root")
        lines = ["(kicad_sch (version 20231120) (generator actoviq)", f"  (uuid {root_uuid})", "  (paper \"A4\")", "  (lib_symbols)"]
        root_labels: list[str] = []
        global_port_nets = {
            (record.get("module_id"), record.get("port_id")): record["net"]
            for record in ir["connectivity"]["records"]
            if record.get("port_id")
        }
        for page_index, page in enumerate(ir["pages"]):
            sheet_uuid = _stable_uuid(project_name, "sheet", page["id"])
            x, y = 25.4 + page_index * 63.5, 50.8
            width, height = 50.8, max(25.4, 7.62 + len(page["ports"]) * 5.08)
            lines.extend([
                f"  (sheet (at {x:.4f} {y:.4f}) (size {width:.4f} {height:.4f}) (fields_autoplaced yes) (stroke (width 0) (type default)) (fill (color 0 0 0 0.0000)) (uuid {sheet_uuid})",
                f"    (property \"Sheetname\" {_sexpr_string(page['name'])} (at {x:.4f} {y-1.27:.4f} 0) (effects (font (size 1.27 1.27)) (justify left bottom)))",
                f"    (property \"Sheetfile\" {_sexpr_string(project_name + '-' + _safe_name(page['id']) + '.kicad_sch')} (at {x:.4f} {y+height+1.27:.4f} 0) (effects (font (size 1.27 1.27)) (justify left top)))",
            ])
            for port_index, port in enumerate(page["ports"]):
                output = port.get("direction") == "output"
                pin_x = x + width if output else x
                pin_y = y + 5.08 + port_index * 5.08
                shape = {"input": "input", "output": "output"}.get(port.get("direction"), "bidirectional")
                angle = 180 if output else 0
                lines.append(f"    (pin {_sexpr_string(port['name'])} {shape} (at {pin_x:.4f} {pin_y:.4f} {angle}) (effects (font (size 1.27 1.27))) (uuid {_stable_uuid(page['id'], 'root-pin', port['id'])}))")
                global_net = global_port_nets.get((page["id"], port["id"]), f"{page['id']}:{port.get('net', '')}")
                justify = "right" if output else "left"
                root_labels.append(f"  (global_label {_sexpr_string(global_net)} (shape {shape}) (at {pin_x:.4f} {pin_y:.4f} {angle}) (fields_autoplaced yes) (effects (font (size 1.27 1.27)) (justify {justify})) (uuid {_stable_uuid(page['id'], 'root-label', port['id'])}))")
            lines.extend(["    (instances", f"      (project {_sexpr_string(project_name)} (path {_sexpr_string('/' + sheet_uuid)} (page {_sexpr_string(str(page_index + 2))})))", "    )", "  )"])
        lines.extend(root_labels)
        lines.extend(["  (sheet_instances (path \"/\" (page \"1\")))", ")\n"])
        _write_text(root_schematic, "\n".join(lines))
        schematic_files.insert(0, root_schematic)
    _write_json(target / "connectivity.json", ir["connectivity"])
    return [pro, symbols, sym_table, target / "connectivity.json", *schematic_files]


def _write_altium(root: Path, project_name: str, ir: dict[str, Any]) -> list[Path]:
    target = root / "altium"
    target.mkdir(parents=True, exist_ok=True)
    for source in (root / "kicad").iterdir():
        if source.is_file():
            shutil.copy2(source, target / source.name)
    readme = target / "IMPORT_ALTIUM.md"
    _write_text(readme, f"# Import {project_name} into Altium Designer\n\nUse File > Import Wizard > KiCad Design Files and select `{project_name}.kicad_pro`. The package targets the KiCad 8 format baseline. Save the converted project as PrjPcb/SchDoc.\n")
    _write_json(target / "connectivity.json", ir["connectivity"])
    return [*target.iterdir()]


def _edif_identifier(value: str) -> str:
    result = re.sub(r"[^A-Za-z0-9_]", "_", value)
    if not result or result[0].isdigit():
        result = "N_" + result
    return result


def _write_orcad(root: Path, project_name: str, ir: dict[str, Any]) -> list[Path]:
    target = root / "orcad"
    target.mkdir(parents=True, exist_ok=True)
    edif = target / f"{project_name}.edf"
    lines = [f"(edif {_edif_identifier(project_name)}", "  (edifVersion 2 0 0)", "  (edifLevel 0)", "  (keywordMap (keywordLevel 0))", "  (status (written (timeStamp 2000 1 1 0 0 0) (program \"Actoviq\")))", "  (library ACTOVIQ_GENERIC (edifLevel 0) (technology (numberDefinition))"]
    for page in ir["pages"]:
        for component in page["components"]:
            cell_name = _edif_identifier(f"{page['id']}_{component['id']}")
            lines.append(f"    (cell {cell_name} (cellType GENERIC) (view SYMBOL (viewType SYMBOL) (interface")
            for pin in component.get("pins", []):
                lines.append(f"      (port {_edif_identifier(pin['id'])} (direction INOUT))")
            lines.append("    )))")
    for page in ir["pages"]:
        lines.append(f"    (cell {_edif_identifier(page['id'])} (cellType GENERIC) (view SCHEMATIC (viewType SCHEMATIC) (interface")
        for port in page["ports"]:
            direction = {"input": "INPUT", "output": "OUTPUT"}.get(port.get("direction"), "INOUT")
            lines.append(f"      (port {_edif_identifier(port['id'])} (direction {direction}))")
        lines.append("    ) (contents")
        for component in page["components"]:
            cell_name = _edif_identifier(f"{page['id']}_{component['id']}")
            position = component.get("position") or {}
            orientation = f"R{int(component.get('rotation', 0)) % 360}"
            lines.append(f"      (instance {_edif_identifier(component['id'])} (viewRef SYMBOL (cellRef {cell_name} (libraryRef ACTOVIQ_GENERIC))) (transform (origin (pt {int(position.get('x', 0))} {int(position.get('y', 0))})) (orientation {orientation})) (property VALUE (string {_sexpr_string(component.get('value', ''))})))")
        for net in page["nets"]:
            net_wires = [wire for wire in page["wires"] if wire.get("net_id") == net["id"]]
            wire_points = ";".join(",".join(f"{point['x']}:{point['y']}" for point in wire.get("points", [])) for wire in net_wires)
            lines.append(f"      (net {_edif_identifier(net['id'])} (property ACTOVIQ_WIRE_POINTS (string {_sexpr_string(wire_points)})) (joined")
            for endpoint in net["endpoints"]:
                if endpoint.get("kind") == "pin":
                    lines.append(f"        (portRef {_edif_identifier(endpoint['pin_id'])} (instanceRef {_edif_identifier(endpoint['component_id'])}))")
                else:
                    lines.append(f"        (portRef {_edif_identifier(endpoint['port_id'])})")
            lines.append("      ))")
        lines.append("    )))")
    lines.extend(["  )", ")\n"])
    _write_text(edif, "\n".join(lines))
    symbol_map = target / "symbol-map.json"
    _write_json(symbol_map, {"schema": SYMBOL_MAP_SCHEMA, "target": "orcad", "generic_library": "ACTOVIQ_GENERIC"})
    readme = target / "IMPORT_ORCAD.md"
    _write_text(readme, f"# Import {project_name} into OrCAD Capture\n\nImport `{edif.name}` with the EDIF 2.0 importer, then save the design as DSN/OPJ. Verify the net count against `connectivity.json`.\n")
    _write_json(target / "connectivity.json", ir["connectivity"])
    return [edif, symbol_map, readme, target / "connectivity.json"]


def _spice_lines(ir: dict[str, Any], cdl: bool = False) -> list[str]:
    lines = [f"* Actoviq {'CDL' if cdl else 'SPICE'} export", f"* connectivity_hash={ir['connectivity']['hash']}"]
    global_net_by_endpoint = {(record.get("module_id"), record.get("component_id"), record.get("pin_id")): record["net"] for record in ir["connectivity"]["records"] if record.get("component_id")}
    for page in ir["pages"]:
        for component in page["components"]:
            prefix = component.get("type", "X")
            name = str(component.get("name", component["id"]))
            if not name.upper().startswith(prefix):
                name = prefix + name
            nets = [global_net_by_endpoint.get((page["id"], component["id"], pin["id"]), f"{page['id']}:{pin.get('net', '')}") for pin in component.get("pins", [])]
            value = component.get("value", "GENERIC")
            if prefix == "BLOCK":
                prefix, value = "X", _safe_name(value, "ACTOVIQ_BLOCK")
            lines.append(" ".join([_safe_name(name), *(_safe_name(net, "0") for net in nets), str(value)]))
    lines.append(".END")
    return lines


def _write_virtuoso(root: Path, project_name: str, ir: dict[str, Any]) -> list[Path]:
    target = root / "virtuoso"
    target.mkdir(parents=True, exist_ok=True)
    spice = target / f"{project_name}.spice"
    cdl = target / f"{project_name}.cdl"
    _write_text(spice, "\n".join(_spice_lines(ir)) + "\n")
    _write_text(cdl, "\n".join(_spice_lines(ir, True)) + "\n")
    device_map = target / "device-map.json"
    _write_json(device_map, {"schema": SYMBOL_MAP_SCHEMA, "target": "virtuoso", "types": {"R": "analogLib/res/symbol", "C": "analogLib/cap/symbol", "L": "analogLib/ind/symbol", "D": "analogLib/diode/symbol", "M": "analogLib/nmos4/symbol", "Q": "analogLib/npn/symbol", "V": "analogLib/vsource/symbol", "I": "analogLib/isource/symbol"}, "fallback": "create_generic_symbol"})
    skill = target / "create_schematic.il"
    skill_lines = [
        "; Actoviq Virtuoso reconstruction script",
        "; Set actoviqLibrary before loading this file in CIW or batch mode.",
        'unless(boundp(\'actoviqLibrary) actoviqLibrary="ACTOVIQ")',
        "procedure(actoviqEnsureGenericSymbol(libName cellName pinNames)",
        "  let((cv net)",
        '    cv=dbOpenCellViewByType(libName cellName "symbol" "" "a")',
        '    unless(cv~>shapes dbCreateRect(cv list("device" "drawing") list(-1:-1 1:1)))',
        '    foreach(pinName pinNames unless(dbFindNetByName(cv pinName) net=dbCreateNet(cv pinName) dbCreateTerm(net pinName "inputOutput")))',
        "    dbSave(cv)",
        "    cv",
        "  )",
        ")",
    ]
    cell_map = {"R": ("analogLib", "res"), "C": ("analogLib", "cap"), "L": ("analogLib", "ind"), "D": ("analogLib", "diode"), "M": ("analogLib", "nmos4"), "Q": ("analogLib", "npn"), "V": ("analogLib", "vsource"), "I": ("analogLib", "isource")}
    pin_map = {"R": ["PLUS", "MINUS"], "C": ["PLUS", "MINUS"], "L": ["PLUS", "MINUS"], "D": ["PLUS", "MINUS"], "M": ["D", "G", "S", "B"], "Q": ["C", "B", "E"], "V": ["PLUS", "MINUS"], "I": ["PLUS", "MINUS"]}
    for page in ir["pages"]:
        page_cell = _safe_name(page["id"])
        skill_lines.extend([f'; Module {page["id"]}', f'cv=dbOpenCellViewByType(actoviqLibrary "{page_cell}" "schematic" "" "a")'])
        net_variables: dict[str, str] = {}
        for net_index, net in enumerate(page["nets"]):
            variable = f"net{net_index}"
            net_variables[str(net["name"])] = variable
            skill_lines.append(f'{variable}=dbCreateNet(cv "{_safe_name(net["name"])}")')
        for component_index, component in enumerate(page["components"]):
            component_type = str(component.get("type", "BLOCK"))
            library, cell = cell_map.get(component_type, ("", ""))
            pin_names = pin_map.get(component_type, [str(pin.get("name", pin["id"])) for pin in component.get("pins", [])])
            if not library:
                cell = _safe_name(f"generic_{component_type}_{len(pin_names)}")
                quoted_pins = " ".join(f'\"{_safe_name(name)}\"' for name in pin_names)
                skill_lines.append(f'master=actoviqEnsureGenericSymbol(actoviqLibrary "{cell}" list({quoted_pins}))')
            else:
                skill_lines.append(f'master=dbOpenCellViewByType("{library}" "{cell}" "symbol" "" "r")')
                quoted_pins = " ".join(f'\"{_safe_name(name)}\"' for name in pin_names)
                skill_lines.append(f'unless(master master=actoviqEnsureGenericSymbol(actoviqLibrary "generic_{component_type}_{len(pin_names)}" list({quoted_pins})))')
            position = component.get("position") or {}
            orientation = f"R{int(component.get('rotation', 0)) % 360}"
            skill_lines.append(f'inst{component_index}=dbCreateInst(cv master "{_safe_name(component["name"])}" list({float(position.get("x", 0))*MM_PER_UNIT:.4f}:{float(position.get("y", 0))*MM_PER_UNIT:.4f}) "{orientation}")')
            for pin_index, pin in enumerate(component.get("pins", [])):
                net_variable = net_variables.get(str(pin.get("net", "")))
                target_pin = _safe_name(pin_names[min(pin_index, len(pin_names) - 1)]) if pin_names else _safe_name(pin["id"])
                if net_variable:
                    skill_lines.append(f'dbCreateConnByName({net_variable} inst{component_index} "{target_pin}")')
        for port in page["ports"]:
            net_variable = net_variables.get(str(port.get("net", "")))
            if net_variable:
                direction = {"input": "input", "output": "output"}.get(port.get("direction"), "inputOutput")
                skill_lines.append(f'dbCreateTerm({net_variable} "{_safe_name(port["name"])}" "{direction}")')
        for wire in page["wires"]:
            points = " ".join(f'{point["x"]*MM_PER_UNIT:.4f}:{point["y"]*MM_PER_UNIT:.4f}' for point in wire.get("points", []))
            if points:
                skill_lines.append(f'when(isCallable(\'schCreateWire) schCreateWire(cv "draw" "full" list({points}) 0.0 0.0 0.0))')
        skill_lines.extend(["dbSave(cv)", "dbClose(cv)"])
    skill_lines.append(f'printf("Actoviq: created {len(ir["pages"])} schematic cell(s) for {project_name}\\n")')
    _write_text(skill, "\n".join(skill_lines) + "\n")
    cds = target / "cds.lib.example"
    _write_text(cds, "DEFINE ACTOVIQ ./ACTOVIQ\n")
    readme = target / "IMPORT_VIRTUOSO.md"
    _write_text(readme, f"# Import {project_name} into Cadence Virtuoso\n\nImport `{spice.name}` or `{cdl.name}` with your reference libraries and `device-map.json`. Alternatively load `create_schematic.il` in CIW after configuring the destination library. Missing cells must be replaced by generic symbols with the same pins.\n")
    _write_json(target / "connectivity.json", ir["connectivity"])
    return [spice, cdl, device_map, skill, cds, readme, target / "connectivity.json"]


def _native_status(target: str, policy: str) -> tuple[str, list[str]]:
    executable = {"kicad": shutil.which("kicad-cli"), "altium": os.environ.get("ALTIUM_BIN"), "orcad": os.environ.get("ORCAD_CAPTURE_BIN"), "virtuoso": os.environ.get("VIRTUOSO_BIN")}[target]
    if policy == "never":
        return "import_ready", []
    if executable:
        return "import_ready", [f"Native {target} converter detected but unattended conversion is not enabled by this adapter; package was validated structurally."]
    if policy == "required":
        return "failed", [f"Native {target} conversion was required but its executable is not configured."]
    return "import_ready", [f"Native {target} tool was not detected; generated an import-ready package."]


def export_eda(root: Path, project: dict[str, Any], modules: dict[str, dict[str, Any]], erc: dict[str, Any], document_hash: str, *, scope: str, module_id: str | None, targets: list[str], view: str, mapping_file: str, native_convert: str, strict_layout: bool, source_revision: int | None) -> dict[str, Any]:
    if source_revision is not None and int(source_revision) != int(project["revision"]):
        raise ValueError(f"stale source revision: requested {source_revision}, current {project['revision']}")
    if erc.get("blocking"):
        raise ValueError(f"blocking ERC prevents export ({erc.get('summary', {}).get('errors', 0)} errors)")
    if scope == "module" and not module_id:
        raise ValueError("scope=module requires --module-id")
    unknown_targets = sorted(set(targets) - set(TARGETS))
    if unknown_targets:
        raise ValueError(f"unsupported EDA targets: {', '.join(unknown_targets)}")
    ir, quality = build_eda_ir(project, modules, scope=scope, module_id=module_id, view=view, document_hash=document_hash)
    if ir["connectivity"]["hash"] != connectivity_hash(project, modules, module_id if scope == "module" else None, view):
        raise ValueError("connectivity hash changed during layout projection")
    if strict_layout and quality["readability_score"] < 90:
        raise ValueError(f"layout readability score {quality['readability_score']} is below strict threshold 90")
    symbol_map = _load_symbol_map(mapping_file, ir["pages"])
    export_id = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{document_hash[:8]}"
    export_root = root / "build" / "exports" / export_id
    project_name = _safe_name(project.get("name", project["project_id"]))
    _write_json(export_root / "ir" / "project.eda.json", ir)
    _write_json(export_root / "ir" / "symbol-map.resolved.json", symbol_map)
    _write_json(export_root / "common" / "connectivity.json", ir["connectivity"])
    _write_text(export_root / "common" / "preview.svg", _svg_preview(ir))
    _write_text(export_root / "common" / "design.spice", "\n".join(_spice_lines(ir)) + "\n")
    _write_text(export_root / "common" / "design.cdl", "\n".join(_spice_lines(ir, True)) + "\n")
    _write_json(export_root / "reports" / "layout-quality.json", quality)
    statuses: dict[str, Any] = {}
    warnings: list[dict[str, str]] = []
    if quality["readability_score"] < 90:
        warnings.append({"target": "all", "code": "layout_below_threshold", "message": f"Layout readability score is {quality['readability_score']} (< 90)."})
    writers = {"kicad": _write_kicad, "altium": _write_altium, "orcad": _write_orcad, "virtuoso": _write_virtuoso}
    ordered_targets = [target for target in TARGETS if target in targets]
    for target in ordered_targets:
        if target == "altium" and not (export_root / "kicad").exists():
            _write_kicad(export_root, project_name, ir)
        files = writers[target](export_root, project_name, ir)
        status, target_warnings = _native_status(target, native_convert)
        warnings.extend({"target": target, "code": "native_conversion", "message": message} for message in target_warnings)
        statuses[target] = {"status": status, "connectivity_hash": ir["connectivity"]["hash"], "files": [str(path.relative_to(export_root)).replace("\\", "/") for path in files if path.is_file()]}
    _write_json(export_root / "reports" / "export-warnings.json", {"warnings": warnings})
    file_hashes = {}
    for path in sorted(export_root.rglob("*")):
        if path.is_file() and path.name != "manifest.json":
            file_hashes[str(path.relative_to(export_root)).replace("\\", "/")] = _sha256_bytes(path.read_bytes())
    manifest = {
        "schema": MANIFEST_SCHEMA, "export_id": export_id, "created_at": _utc_now(),
        "source": {"project_id": project["project_id"], "revision": project["revision"], "document_hash": document_hash, "connectivity_hash": ir["connectivity"]["hash"], "scope": scope, "module_id": module_id, "view": view},
        "coordinate_transform": {"internal_grid": GRID, "mm_per_internal_unit": MM_PER_UNIT, "mm_per_grid": GRID * MM_PER_UNIT},
        "layout": {"readability_score": quality["readability_score"], "strict": strict_layout},
        "targets": statuses, "warnings": len(warnings), "files": file_hashes,
    }
    _write_json(export_root / "manifest.json", manifest)
    if native_convert == "required" and any(value["status"] == "failed" for value in statuses.values()):
        raise ValueError(f"one or more required native conversions failed; report: {export_root / 'manifest.json'}")
    return {"ok": True, "export_id": export_id, "export_root": str(export_root.resolve()), "manifest": manifest, "layout_quality": quality, "targets": statuses}
