#!/usr/bin/env python3
"""Shared helpers for report schematics and KiCad export."""

from __future__ import annotations

import json
import math
import re
import uuid
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

from netlist_to_json import (
    apply_value_resolution,
    choose_two_terminal_orientation,
    infer_io_nodes,
    is_control_directive,
    merge_continuation_lines,
    parse_component_line,
    parse_param_assignments,
)

GRID_X_MM = 32.0
GRID_Y_MM = 22.0
MAIN_ROW_Y_MM = 90.0
RAIL_Y_MM = {
    "vcc": 30.0,
    "vee": 42.0,
    "gnd": 155.0,
}

PIN_LAYOUTS: dict[str, dict[str, tuple[float, float]]] = {
    "resistor_h": {"1": (-7.5, 0.0), "2": (7.5, 0.0)},
    "resistor_v": {"1": (0.0, -7.5), "2": (0.0, 7.5)},
    "capacitor_h": {"1": (-6.5, 0.0), "2": (6.5, 0.0)},
    "capacitor_v": {"1": (0.0, -6.5), "2": (0.0, 6.5)},
    "inductor_h": {"1": (-8.0, 0.0), "2": (8.0, 0.0)},
    "inductor_v": {"1": (0.0, -8.0), "2": (0.0, 8.0)},
    "diode_h": {"1": (-7.0, 0.0), "2": (7.0, 0.0)},
    "diode_v": {"1": (0.0, -7.0), "2": (0.0, 7.0)},
    "source_v": {"1": (0.0, -8.0), "2": (0.0, 8.0)},
    "bjt_npn": {"1": (0.0, -8.0), "2": (-8.0, 0.0), "3": (0.0, 8.0)},
    "bjt_pnp": {"1": (0.0, -8.0), "2": (-8.0, 0.0), "3": (0.0, 8.0)},
    "mos_n": {"1": (0.0, -10.0), "2": (-10.0, 0.0), "3": (0.0, 10.0), "4": (10.0, 0.0)},
    "mos_p": {"1": (0.0, -10.0), "2": (-10.0, 0.0), "3": (0.0, 10.0), "4": (10.0, 0.0)},
    "opamp": {"1": (20.0, 0.0), "2": (-20.0, 8.0), "3": (-20.0, -8.0)},
    "comparator": {"1": (20.0, 0.0), "2": (-20.0, 8.0), "3": (-20.0, -8.0)},
    "power": {"1": (0.0, 0.0)},
    "connector_1": {"1": (0.0, 0.0)},
    "connector_2": {"1": (0.0, -3.81), "2": (0.0, 3.81)},
}

OSC_NODE_Y_MM = {
    "supply": 46.0,
    "base": 68.0,
    "collector": 92.0,
    "emitter": 122.0,
    "output": 92.0,
    "misc": 92.0,
}

AMP_NODE_Y_MM = {
    "input": 90.0,
    "base": 66.0,
    "collector": 90.0,
    "emitter": 116.0,
    "output": 90.0,
    "supply": 42.0,
    "misc": 90.0,
}

DIFF_NODE_Y_MM = {
    "input_top": 64.0,
    "input_bottom": 120.0,
    "collector": 52.0,
    "tail": 122.0,
    "output": 84.0,
    "supply": 38.0,
    "misc": 84.0,
}

COLPITTS_NODE_Y_MM = {
    "supply": 40.0,
    "base": 82.0,
    "collector": 64.0,
    "emitter": 118.0,
    "tank": 64.0,
    "tap": 92.0,
    "output": 92.0,
    "misc": 90.0,
}


def new_uuid() -> str:
    return str(uuid.uuid4())


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def rail_kind(node: str) -> str | None:
    lower = str(node).strip().lower()
    if lower in {"0", "gnd", "agnd", "dgnd", "pgnd"} or lower.endswith("gnd"):
        return "gnd"
    if lower.startswith(("vcc", "vdd")) or lower.endswith(("_vcc", "_vdd")):
        return "vcc"
    if lower.startswith(("vee", "vss")) or lower.endswith(("_vee", "_vss")):
        return "vee"
    return None


def numeric_suffix(node: str) -> int | None:
    match = re.search(r"(\d+)$", str(node))
    return int(match.group(1)) if match else None


def is_rail(node: str) -> bool:
    return rail_kind(node) is not None


def component_nodes(comp: dict[str, Any]) -> list[str]:
    source = comp.get("schematic_nodes") or comp.get("nodes", [])
    return [str(node) for node in source]


def parse_netlist_components(netlist_path: Path) -> tuple[list[dict[str, Any]], dict[str, str], list[str]]:
    warnings: list[str] = []
    content = netlist_path.read_text(encoding="utf-8-sig", errors="ignore")
    merged_lines = merge_continuation_lines(content)
    params = parse_param_assignments(merged_lines)
    components: list[dict[str, Any]] = []
    in_control = False
    for line_no, line in merged_lines:
        if is_control_directive(line, ".control"):
            in_control = True
            continue
        if is_control_directive(line, ".endc"):
            in_control = False
            continue
        if in_control:
            continue
        comp = parse_component_line(line, line_no, warnings)
        if not comp:
            continue
        apply_value_resolution(comp, params)
        components.append(comp)
    return components, params, warnings


def normalize_component_record(comp: dict[str, Any]) -> dict[str, Any]:
    record = dict(comp)
    if "sim_value" not in record:
        record["sim_value"] = record.get("value_spice") or record.get("value") or ""
    if "display_value" not in record:
        record["display_value"] = record.get("value") or record.get("display") or ""
    if "component_role" not in record:
        record["component_role"] = infer_component_role(record)
    if "mount_policy" not in record:
        record["mount_policy"] = infer_mount_policy(record)
    return record


def load_design_payload(json_path: Path) -> dict[str, Any]:
    payload = read_json(json_path)
    if payload.get("components"):
        payload["components"] = [normalize_component_record(c) for c in payload["components"]]
        return payload
    if payload.get("format") == "spice-components-v1":
        payload["components"] = [normalize_component_record(c) for c in payload.get("components", [])]
        return payload
    source = payload.get("source_netlist")
    if not source:
        raise ValueError(f"design payload has no embedded components and no source netlist: {json_path}")
    netlist_path = Path(str(source))
    components, params, warnings = parse_netlist_components(netlist_path)
    inferred_input, inferred_output = infer_io_nodes(
        components,
        explicit_input=str(payload.get("io_inference", {}).get("explicit_input_node") or ""),
        explicit_output=str(payload.get("io_inference", {}).get("explicit_output_node") or ""),
        warnings=warnings,
    )
    payload["components"] = [normalize_component_record(c) for c in components]
    payload.setdefault("params", params)
    payload.setdefault(
        "io_inference",
        {
            "input_node": inferred_input,
            "output_node": inferred_output,
            "explicit_input_node": None,
            "explicit_output_node": None,
        },
    )
    return payload


def build_adjacency(components: list[dict[str, Any]]) -> dict[str, set[str]]:
    graph: dict[str, set[str]] = defaultdict(set)
    for comp in components:
        nodes = component_nodes(comp)
        active_nodes = [node for node in nodes if not is_rail(node)]
        if len(active_nodes) >= 2:
            head = active_nodes[0]
            for other in active_nodes[1:]:
                graph[head].add(other)
                graph[other].add(head)
        elif len(active_nodes) == 1:
            graph.setdefault(active_nodes[0], set())
    return graph


def shortest_path(graph: dict[str, set[str]], start: str, goal: str) -> list[str]:
    if not start or not goal or start not in graph or goal not in graph:
        return []
    queue: deque[str] = deque([start])
    prev: dict[str, str | None] = {start: None}
    while queue:
        node = queue.popleft()
        if node == goal:
            break
        for neighbor in sorted(graph.get(node, set())):
            if neighbor in prev:
                continue
            prev[neighbor] = node
            queue.append(neighbor)
    if goal not in prev:
        return []
    path: list[str] = []
    node: str | None = goal
    while node is not None:
        path.append(node)
        node = prev[node]
    return list(reversed(path))


def infer_component_role(comp: dict[str, Any]) -> str:
    name = str(comp.get("name", "")).lower()
    nodes = [node.lower() for node in component_nodes(comp)]
    comp_type = str(comp.get("type", ""))
    if comp_type in {"voltage_source", "current_source"}:
        return "source"
    if comp_type in {"bjt", "mosfet"}:
        return "gain_active"
    if str(comp.get("symbol_hint") or "").lower() == "comparator":
        return "decision"
    if str(comp.get("symbol_hint") or "").lower() == "opamp":
        return "gain_active"
    if name.startswith(("rload", "rl", "rprobe")):
        return "load"
    if name.startswith(("cin", "cout")):
        return "coupling"
    if name.startswith(("ce", "cbyp", "cdec", "cvdd", "cvcc")):
        return "decoupling"
    if name.startswith(("rb", "re", "rc", "rg", "rs", "rd")) and any(
        node.startswith(("vcc", "vdd", "vee", "vss")) or node == "0" for node in nodes
    ):
        return "bias"
    if comp_type in {"inductor", "capacitor"} and any(node in {"in", "out", "rf_in", "rf_out"} for node in nodes):
        return "matching"
    if comp_type in {"resistor", "capacitor", "inductor"}:
        return "passive_network"
    if comp_type == "diode":
        return "protection"
    return "unspecified"


def infer_mount_policy(comp: dict[str, Any]) -> str:
    comp_type = str(comp.get("type", ""))
    name = str(comp.get("name", "")).lower()
    if comp_type in {"voltage_source", "current_source"}:
        return "testbench_exclude"
    if name.startswith(("rprobe", "vprobe", "iproble", "rload")):
        return "optional_testbench"
    return "populate"


def ordered_signal_nodes(components: list[dict[str, Any]], input_node: str, output_node: str) -> list[str]:
    nodes_in_order: list[str] = []
    seen: set[str] = set()
    for comp in components:
        for node in component_nodes(comp):
            node_s = str(node)
            if is_rail(node_s):
                continue
            if node_s not in seen:
                seen.add(node_s)
                nodes_in_order.append(node_s)

    graph = build_adjacency(components)
    main_path = shortest_path(graph, input_node, output_node)
    ordered: list[str] = []
    for node in main_path:
        if node not in ordered:
            ordered.append(node)
    for node in nodes_in_order:
        if node not in ordered:
            ordered.append(node)
    return ordered


def active_tail_nodes(components: list[dict[str, Any]]) -> dict[str, int]:
    tails: dict[str, int] = defaultdict(int)
    for comp in components:
        ctype = str(comp.get("type", ""))
        nodes = component_nodes(comp)
        if ctype == "bjt" and len(nodes) >= 3:
            tails[nodes[2]] += 1
        if ctype == "mosfet" and len(nodes) >= 3:
            tails[nodes[2]] += 1
    return dict(tails)


def diff_input_nodes(components: list[dict[str, Any]]) -> list[str]:
    candidates: list[str] = []
    for comp in components:
        for node in component_nodes(comp):
            node_s = str(node)
            lower = node_s.lower()
            if lower in {"inp", "inn", "vinp", "vinn", "vip", "vin_n", "vin_p", "in_p", "in_n"}:
                if node_s not in candidates:
                    candidates.append(node_s)
                continue
            if lower.startswith("in") and (lower.endswith("p") or lower.endswith("n")) and node_s not in candidates:
                candidates.append(node_s)
    return candidates


def is_signal_chain_comparator(
    components: list[dict[str, Any]],
    input_node: str,
    output_node: str,
) -> bool:
    if not input_node or not output_node:
        return False
    hints = {str(comp.get("symbol_hint") or "").lower() for comp in components}
    if "opamp" not in hints:
        return False
    if "comparator" not in hints:
        return False
    nodes = {node.lower() for comp in components for node in component_nodes(comp)}
    return any(node in nodes for node in {"filt", "vth"}) or output_node.lower().endswith("_n")


def is_rf_mixed_signal(
    components: list[dict[str, Any]],
    input_node: str,
    output_node: str,
) -> bool:
    if not input_node or not output_node:
        return False
    types = {str(comp.get("type", "")).lower() for comp in components}
    hints = {str(comp.get("symbol_hint") or "").lower() for comp in components}
    nodes = {node.lower() for comp in components for node in component_nodes(comp)}
    has_rf_frontend = "inductor" in types and ("mosfet" in types or "bjt" in types)
    has_detector = "diode" in types and any(node.startswith(("det", "env", "lpf", "adc")) for node in nodes)
    has_digitizer = "comparator" in hints or any(node.endswith("_n") for node in nodes)
    return has_rf_frontend and has_detector and has_digitizer


def classify_layout_profile(
    components: list[dict[str, Any]],
    input_node: str,
    output_node: str,
) -> str:
    counts = {"bjt": 0, "mosfet": 0, "capacitor": 0, "inductor": 0}
    for comp in components:
        ctype = str(comp.get("type", ""))
        if ctype in counts:
            counts[ctype] += 1

    active_count = counts["bjt"] + counts["mosfet"]
    diff_inputs = diff_input_nodes(components)
    tail_nodes = active_tail_nodes(components)
    if is_signal_chain_comparator(components, input_node, output_node):
        return "signal_chain_comparator"
    if is_rf_mixed_signal(components, input_node, output_node):
        return "rf_mixed_signal"
    if active_count >= 2 and len(diff_inputs) >= 2 and any(count >= 2 for count in tail_nodes.values()):
        return "differential_pair"
    if active_count >= 1 and counts["inductor"] >= 1 and counts["capacitor"] >= 2 and not input_node and output_node:
        return "colpitts"
    if active_count >= 2 and counts["capacitor"] >= 2 and not input_node and output_node:
        return "oscillator"
    if active_count == 1 and input_node and output_node:
        return "common_emitter"
    if active_count >= 1 and input_node and output_node:
        return "amplifier"
    return "generic"


def classify_row(node: str) -> int:
    lower = node.lower()
    if lower.startswith(("b", "g", "vb", "bias")):
        return -1
    if lower.startswith(("e", "s")):
        return 1
    if lower.startswith(("c", "d", "out")):
        return 0
    return 0


def oscillator_node_category(node: str, output_node: str) -> str:
    lower = node.lower()
    if lower == output_node.lower():
        return "output"
    if lower.startswith(("vosc", "vbias", "vcore", "vint", "vreg")) or (lower.startswith("v") and not is_rail(node)):
        return "supply"
    if lower.startswith(("b", "g")):
        return "base"
    if lower.startswith(("e", "s")):
        return "emitter"
    if lower.startswith(("c", "d", "n")):
        return "collector"
    return "misc"


def amplifier_node_category(node: str, input_node: str, output_node: str) -> str:
    lower = node.lower()
    if input_node and lower == input_node.lower():
        return "input"
    if output_node and lower == output_node.lower():
        return "output"
    if lower.startswith(("src", "in", "vin", "rf_in")):
        return "input"
    if lower.startswith(("b", "g")):
        return "base"
    if lower.startswith(("e", "s")):
        return "emitter"
    if lower.startswith(("c", "d")):
        return "collector"
    if lower.startswith("v") and not is_rail(node):
        return "supply"
    return "misc"


def signal_chain_node_category(node: str, input_node: str, output_node: str) -> str:
    lower = node.lower()
    if input_node and lower == input_node.lower():
        return "input"
    if output_node and lower == output_node.lower():
        return "output"
    if lower in {"vp", "inp", "vinp"}:
        return "opamp_plus"
    if lower in {"vn", "inn", "vinn"}:
        return "opamp_minus"
    if lower.startswith(("op_raw", "op_", "amp")):
        return "opamp_internal"
    if lower.startswith(("opout", "op_out")):
        return "opamp_output"
    if lower.startswith(("filt", "flt", "lp")):
        return "filter"
    if lower.startswith(("vth", "th", "ref")):
        return "threshold"
    if lower.endswith("_n") or lower.startswith(("alarm", "cmp_out", "out")):
        return "output"
    if lower.startswith(("cmp", "comp")):
        return "compare_input"
    if lower.startswith(("v", "bias")) and not is_rail(node):
        return "threshold"
    return "misc"


def rf_mixed_node_category(node: str, input_node: str, output_node: str) -> str:
    lower = node.lower()
    if input_node and lower == input_node.lower():
        return "input"
    if output_node and lower == output_node.lower():
        return "output"
    if lower.startswith(("match", "rf_in")):
        return "matching"
    if lower in {"gate", "base", "vgate", "vbias"}:
        return "gain_input"
    if lower in {"drain", "collector", "rf_amp"}:
        return "gain_output"
    if lower in {"source", "emitter"}:
        return "gain_source"
    if lower.startswith(("det", "env")):
        return "detector"
    if lower.startswith(("lpf", "adc")):
        return "baseband"
    if lower.startswith(("vth", "ref")):
        return "threshold"
    if lower.endswith("_n") or lower.startswith(("alarm", "dout", "digital")):
        return "output"
    if lower.startswith(("v", "bias")) and not is_rail(node):
        return "bias"
    return "misc"


def colpitts_node_category(node: str, output_node: str) -> str:
    lower = node.lower()
    if lower == output_node.lower():
        return "output"
    if lower.startswith(("tank", "tap")):
        return "tap"
    if lower.startswith(("l", "x", "ntank", "res")):
        return "tank"
    if lower.startswith(("b", "g")):
        return "base"
    if lower.startswith(("e", "s")):
        return "emitter"
    if lower.startswith(("c", "d")):
        return "collector"
    if lower.startswith(("vosc", "vbias", "vcore", "vint", "vreg")) or (lower.startswith("v") and not is_rail(node)):
        return "supply"
    return "misc"


def build_net_positions(components: list[dict[str, Any]], input_node: str, output_node: str) -> dict[str, tuple[float, float]]:
    profile = classify_layout_profile(components, input_node, output_node)
    if profile == "signal_chain_comparator":
        return build_net_positions_signal_chain_comparator(components, input_node, output_node)
    if profile == "rf_mixed_signal":
        return build_net_positions_rf_mixed_signal(components, input_node, output_node)
    if profile == "common_emitter":
        return build_net_positions_common_emitter(components, input_node, output_node)
    if profile == "differential_pair":
        return build_net_positions_differential_pair(components, output_node)
    if profile == "colpitts":
        return build_net_positions_colpitts(components, output_node)
    if profile == "oscillator":
        return build_net_positions_oscillator(components, output_node)
    if profile == "amplifier":
        return build_net_positions_amplifier(components, input_node, output_node)

    ordered = ordered_signal_nodes(components, input_node, output_node)
    positions: dict[str, tuple[float, float]] = {}
    for idx, node in enumerate(ordered):
        row = classify_row(node)
        positions[node] = (40.0 + idx * GRID_X_MM, MAIN_ROW_Y_MM + row * GRID_Y_MM)

    rail_links: dict[str, set[float]] = defaultdict(set)
    for comp in components:
        nodes = component_nodes(comp)
        signal_nodes = [node for node in nodes if not is_rail(node)]
        rail_nodes = [node for node in nodes if is_rail(node)]
        for rail in rail_nodes:
            rail_type = rail_kind(rail)
            if rail_type is None:
                continue
            for signal in signal_nodes:
                if signal in positions:
                    rail_links[rail].add(positions[signal][0])
            if not signal_nodes:
                rail_links[rail].add(40.0)
    for rail, xs in rail_links.items():
        rail_type = rail_kind(rail)
        if rail_type is None:
            continue
        x = min(xs) if xs else 40.0
        positions[rail] = (x, RAIL_Y_MM[rail_type])
    if "0" not in positions:
        positions["0"] = (40.0, RAIL_Y_MM["gnd"])
    return positions


def build_net_positions_signal_chain_comparator(
    components: list[dict[str, Any]],
    input_node: str,
    output_node: str,
) -> dict[str, tuple[float, float]]:
    ordered = ordered_signal_nodes(components, input_node, output_node)
    positions: dict[str, tuple[float, float]] = {}

    stage_x = {
        "input": 46.0,
        "opamp_plus": 112.0,
        "opamp_minus": 150.0,
        "opamp_internal": 194.0,
        "opamp_output": 252.0,
        "filter": 338.0,
        "threshold": 416.0,
        "compare_input": 470.0,
        "output": 584.0,
        "misc": 304.0,
    }
    stage_y = {
        "input": 92.0,
        "opamp_plus": 74.0,
        "opamp_minus": 110.0,
        "opamp_internal": 92.0,
        "opamp_output": 92.0,
        "filter": 82.0,
        "threshold": 118.0,
        "compare_input": 96.0,
        "output": 92.0,
        "misc": 92.0,
    }
    misc_x = stage_x["misc"]
    for node in ordered:
        category = signal_chain_node_category(node, input_node, output_node)
        x = stage_x.get(category, misc_x)
        y = stage_y.get(category, stage_y["misc"])
        positions[node] = (x, y)
        if category == "misc":
            misc_x += 34.0

    if input_node:
        positions[input_node] = positions.get(input_node, (stage_x["input"], stage_y["input"]))
    if output_node:
        positions[output_node] = positions.get(output_node, (stage_x["output"], stage_y["output"]))

    for node in ordered:
        lower = node.lower()
        if lower.startswith(("op_out", "opout")):
            positions[node] = (stage_x["opamp_output"], 92.0)
        elif lower.startswith(("filt", "flt", "lp")):
            positions[node] = (stage_x["filter"], 82.0)
        elif lower.startswith(("vth", "th", "ref")):
            positions[node] = (stage_x["threshold"], 118.0)

    rail_x = stage_x["threshold"]
    positions["0"] = (rail_x, RAIL_Y_MM["gnd"])
    for comp in components:
        for rail in [node for node in component_nodes(comp) if is_rail(node)]:
            kind = rail_kind(rail)
            if kind is None:
                continue
            if kind == "gnd":
                positions[rail] = positions["0"]
            else:
                positions[rail] = (rail_x, RAIL_Y_MM[kind])
    return positions


def build_net_positions_rf_mixed_signal(
    components: list[dict[str, Any]],
    input_node: str,
    output_node: str,
) -> dict[str, tuple[float, float]]:
    ordered = ordered_signal_nodes(components, input_node, output_node)
    positions: dict[str, tuple[float, float]] = {}
    stage_x = {
        "input": 42.0,
        "matching": 108.0,
        "gain_input": 170.0,
        "bias": 170.0,
        "gain_output": 246.0,
        "gain_source": 246.0,
        "detector": 336.0,
        "baseband": 418.0,
        "threshold": 500.0,
        "output": 610.0,
        "misc": 300.0,
    }
    stage_y = {
        "input": 92.0,
        "matching": 92.0,
        "gain_input": 92.0,
        "bias": 62.0,
        "gain_output": 92.0,
        "gain_source": 122.0,
        "detector": 92.0,
        "baseband": 92.0,
        "threshold": 116.0,
        "output": 92.0,
        "misc": 92.0,
    }
    misc_x = stage_x["misc"]
    for node in ordered:
        category = rf_mixed_node_category(node, input_node, output_node)
        x = stage_x.get(category, misc_x)
        y = stage_y.get(category, stage_y["misc"])
        positions[node] = (x, y)
        if category == "misc":
            misc_x += 34.0

    if input_node:
        positions[input_node] = positions.get(input_node, (stage_x["input"], stage_y["input"]))
    if output_node:
        positions[output_node] = positions.get(output_node, (stage_x["output"], stage_y["output"]))

    rail_x = stage_x["threshold"]
    positions["0"] = (rail_x, RAIL_Y_MM["gnd"])
    for comp in components:
        for rail in [node for node in component_nodes(comp) if is_rail(node)]:
            kind = rail_kind(rail)
            if kind is None:
                continue
            if kind == "gnd":
                positions[rail] = positions["0"]
            else:
                positions[rail] = (rail_x, RAIL_Y_MM[kind])
    return positions


def apply_rail_positions(
    components: list[dict[str, Any]],
    positions: dict[str, tuple[float, float]],
    *,
    default_x: float = 38.0,
) -> dict[str, tuple[float, float]]:
    rail_links: dict[str, list[float]] = defaultdict(list)
    for comp in components:
        nodes = component_nodes(comp)
        signal_nodes = [node for node in nodes if not is_rail(node)]
        rail_nodes = [node for node in nodes if is_rail(node)]
        for rail in rail_nodes:
            for signal in signal_nodes:
                if signal in positions:
                    rail_links[rail].append(positions[signal][0])
    positions["0"] = (default_x, RAIL_Y_MM["gnd"])
    for rail, xs in rail_links.items():
        kind = rail_kind(rail)
        if kind is None:
            continue
        if kind == "gnd":
            positions[rail] = positions.get("0", (default_x, RAIL_Y_MM["gnd"]))
            continue
        positions[rail] = (default_x, RAIL_Y_MM[kind])
    return positions


def build_net_positions_common_emitter(
    components: list[dict[str, Any]],
    input_node: str,
    output_node: str,
) -> dict[str, tuple[float, float]]:
    ordered = ordered_signal_nodes(components, input_node, output_node)
    positions: dict[str, tuple[float, float]] = {}
    for node in ordered:
        lower = node.lower()
        if input_node and lower == input_node.lower():
            positions[node] = (58.0, AMP_NODE_Y_MM["input"])
        elif lower.startswith(("src", "vin")):
            positions[node] = (34.0, AMP_NODE_Y_MM["input"])
        elif lower.startswith(("b", "g")):
            positions[node] = (96.0, AMP_NODE_Y_MM["base"])
        elif lower.startswith(("c", "d")):
            positions[node] = (140.0, AMP_NODE_Y_MM["collector"])
        elif lower.startswith(("e", "s")):
            positions[node] = (140.0, AMP_NODE_Y_MM["emitter"])
        elif output_node and lower == output_node.lower():
            positions[node] = (224.0, AMP_NODE_Y_MM["output"])
        else:
            positions[node] = (182.0, AMP_NODE_Y_MM["misc"])
    return apply_rail_positions(components, positions)


def build_net_positions_differential_pair(
    components: list[dict[str, Any]],
    output_node: str,
) -> dict[str, tuple[float, float]]:
    positions: dict[str, tuple[float, float]] = {}
    diff_inputs = diff_input_nodes(components)
    left_input = diff_inputs[0] if diff_inputs else "inp"
    right_input = diff_inputs[1] if len(diff_inputs) > 1 else "inn"
    left_x = 98.0
    right_x = 156.0

    seen: set[str] = set()
    for comp in components:
        for node in component_nodes(comp):
            node_s = str(node)
            if is_rail(node_s) or node_s in seen:
                continue
            seen.add(node_s)
            lower = node_s.lower()
            if lower == left_input.lower():
                positions[node_s] = (52.0, DIFF_NODE_Y_MM["input_top"])
            elif lower == right_input.lower():
                positions[node_s] = (52.0, DIFF_NODE_Y_MM["input_bottom"])
            elif lower.startswith(("b1", "g1")):
                positions[node_s] = (left_x, DIFF_NODE_Y_MM["input_top"])
            elif lower.startswith(("b2", "g2")):
                positions[node_s] = (right_x, DIFF_NODE_Y_MM["input_bottom"])
            elif lower.startswith(("c1", "d1")):
                positions[node_s] = (left_x, DIFF_NODE_Y_MM["collector"])
            elif lower.startswith(("c2", "d2")):
                positions[node_s] = (right_x, DIFF_NODE_Y_MM["collector"])
            elif lower.startswith(("e", "s", "tail", "ns")):
                positions[node_s] = (127.0, DIFF_NODE_Y_MM["tail"])
            elif output_node and lower == output_node.lower():
                positions[node_s] = (236.0, DIFF_NODE_Y_MM["output"])
            elif lower.startswith(("v", "vbias")) and not is_rail(node_s):
                positions[node_s] = (70.0, DIFF_NODE_Y_MM["supply"])
            else:
                suffix = numeric_suffix(node_s)
                if suffix == 1:
                    positions[node_s] = (left_x, DIFF_NODE_Y_MM["misc"])
                elif suffix == 2:
                    positions[node_s] = (right_x, DIFF_NODE_Y_MM["misc"])
                else:
                    positions[node_s] = (196.0, DIFF_NODE_Y_MM["misc"])
    return apply_rail_positions(components, positions)


def build_net_positions_colpitts(
    components: list[dict[str, Any]],
    output_node: str,
) -> dict[str, tuple[float, float]]:
    positions: dict[str, tuple[float, float]] = {}
    seen: set[str] = set()
    for comp in components:
        for node in component_nodes(comp):
            node_s = str(node)
            if is_rail(node_s) or node_s in seen:
                continue
            seen.add(node_s)
            lower = node_s.lower()
            category = colpitts_node_category(node_s, output_node)
            if category == "supply":
                positions[node_s] = (60.0, COLPITTS_NODE_Y_MM["supply"])
            elif category == "base":
                positions[node_s] = (112.0, COLPITTS_NODE_Y_MM["base"])
            elif category == "collector":
                positions[node_s] = (154.0, COLPITTS_NODE_Y_MM["collector"])
            elif category == "emitter":
                positions[node_s] = (112.0, COLPITTS_NODE_Y_MM["emitter"])
            elif category == "tank":
                positions[node_s] = (192.0, COLPITTS_NODE_Y_MM["tank"])
            elif category == "tap":
                positions[node_s] = (210.0, COLPITTS_NODE_Y_MM["tap"])
            elif category == "output":
                positions[node_s] = (252.0, COLPITTS_NODE_Y_MM["output"])
            else:
                positions[node_s] = (222.0, COLPITTS_NODE_Y_MM["misc"])
    return apply_rail_positions(components, positions)


def build_net_positions_oscillator(
    components: list[dict[str, Any]],
    output_node: str,
) -> dict[str, tuple[float, float]]:
    nodes_in_order: list[str] = []
    seen: set[str] = set()
    for comp in components:
        for node in component_nodes(comp):
            node_s = str(node)
            if is_rail(node_s):
                continue
            if node_s not in seen:
                seen.add(node_s)
                nodes_in_order.append(node_s)

    suffixes = sorted({numeric_suffix(node) for node in nodes_in_order if numeric_suffix(node) is not None})
    suffix_x = {suffix: 108.0 + idx * 46.0 for idx, suffix in enumerate(suffixes)}
    next_misc_x = 108.0 + len(suffixes) * 46.0

    positions: dict[str, tuple[float, float]] = {}
    for node in nodes_in_order:
        lower = node.lower()
        suffix = numeric_suffix(node)
        category = oscillator_node_category(node, output_node)
        if category == "supply":
            x = 58.0
        elif category == "output":
            x = max(250.0, next_misc_x + 36.0)
        elif suffix is not None and suffix in suffix_x:
            x = suffix_x[suffix]
        else:
            x = next_misc_x
            next_misc_x += 34.0
        y = OSC_NODE_Y_MM.get(category, OSC_NODE_Y_MM["misc"])
        positions[node] = (x, y)

    positions["0"] = (38.0, RAIL_Y_MM["gnd"])

    rail_links: dict[str, list[float]] = defaultdict(list)
    for comp in components:
        nodes = component_nodes(comp)
        signal_nodes = [node for node in nodes if not is_rail(node)]
        rail_nodes = [node for node in nodes if is_rail(node)]
        for rail in rail_nodes:
            for signal in signal_nodes:
                if signal in positions:
                    rail_links[rail].append(positions[signal][0])

    for rail, xs in rail_links.items():
        kind = rail_kind(rail)
        if kind is None:
            continue
        if kind == "gnd":
            positions[rail] = positions.get("0", (38.0, RAIL_Y_MM["gnd"]))
            continue
        x = min(xs) if xs else 38.0
        positions[rail] = (min(x, 38.0), RAIL_Y_MM[kind])
    return positions


def build_net_positions_amplifier(
    components: list[dict[str, Any]],
    input_node: str,
    output_node: str,
) -> dict[str, tuple[float, float]]:
    ordered = ordered_signal_nodes(components, input_node, output_node)
    positions: dict[str, tuple[float, float]] = {}

    current_x = 40.0
    for node in ordered:
        lower = node.lower()
        category = amplifier_node_category(node, input_node, output_node)
        if category == "input":
            x = current_x
            current_x += 28.0
        elif category == "output":
            x = max(current_x + 24.0, 210.0)
        else:
            suffix = numeric_suffix(node)
            if suffix is not None:
                x = 76.0 + (suffix - 1) * 48.0
                current_x = max(current_x, x + 18.0)
            else:
                x = current_x
                current_x += 28.0
        y = AMP_NODE_Y_MM.get(category, AMP_NODE_Y_MM["misc"])
        positions[node] = (x, y)

    rail_links: dict[str, set[float]] = defaultdict(set)
    for comp in components:
        nodes = component_nodes(comp)
        signal_nodes = [node for node in nodes if not is_rail(node)]
        rail_nodes = [node for node in nodes if is_rail(node)]
        for rail in rail_nodes:
            kind = rail_kind(rail)
            if kind is None:
                continue
            for signal in signal_nodes:
                if signal in positions:
                    rail_links[rail].add(positions[signal][0])

    positions["0"] = (38.0, RAIL_Y_MM["gnd"])
    for rail, xs in rail_links.items():
        kind = rail_kind(rail)
        if kind is None:
            continue
        if kind == "gnd":
            positions[rail] = positions.get("0", (38.0, RAIL_Y_MM["gnd"]))
            continue
        x = min(xs) if xs else 38.0
        positions[rail] = (min(x, 38.0), RAIL_Y_MM[kind])
    return positions


def symbol_kind(comp: dict[str, Any]) -> str:
    comp_type = str(comp.get("type", ""))
    nodes = component_nodes(comp)
    symbol_hint = str(comp.get("symbol_hint") or "").lower()
    if comp_type == "resistor":
        return f"resistor_{choose_two_terminal_orientation(nodes, comp=comp)}"
    if comp_type == "capacitor":
        return f"capacitor_{choose_two_terminal_orientation(nodes, comp=comp)}"
    if comp_type == "inductor":
        return f"inductor_{choose_two_terminal_orientation(nodes, comp=comp)}"
    if comp_type == "diode":
        return f"diode_{choose_two_terminal_orientation(nodes, comp=comp)}"
    if comp_type in {"voltage_source", "current_source"}:
        # Sources default vertical in this renderer.
        return "source_v"
    if comp_type == "bjt":
        model = str(comp.get("model") or comp.get("sim_model") or comp.get("sim_value") or "").lower()
        return "bjt_pnp" if "pnp" in model else "bjt_npn"
    if comp_type == "mosfet":
        model = str(comp.get("model") or comp.get("sim_model") or comp.get("sim_value") or "").lower()
        return "mos_p" if "pmos" in model or model.startswith("p") else "mos_n"
    if symbol_hint in {"opamp", "comparator"}:
        return symbol_hint
    return "connector_1"


def place_component(comp: dict[str, Any], net_positions: dict[str, tuple[float, float]]) -> dict[str, Any]:
    kind = symbol_kind(comp)
    nodes = component_nodes(comp)
    coords = [net_positions.get(node, (40.0, MAIN_ROW_Y_MM)) for node in nodes]
    if kind in {"opamp", "comparator"} and len(nodes) >= 3:
        output_coord = net_positions.get(nodes[0])
        input_coords = [net_positions.get(nodes[index]) for index in range(1, min(len(nodes), 3))]
        input_coords = [coord for coord in input_coords if coord is not None]
        if output_coord is not None and input_coords:
            left_x = max(coord[0] for coord in input_coords)
            x = (left_x + output_coord[0]) / 2.0
            y = sum(coord[1] for coord in input_coords) / len(input_coords)
        else:
            x = sum(pt[0] for pt in coords) / max(1, len(coords))
            y = sum(pt[1] for pt in coords) / max(1, len(coords))
    elif kind in {"bjt_npn", "bjt_pnp", "mos_n", "mos_p"} and coords:
        xs = sorted(pt[0] for pt in coords)
        ys = sorted(pt[1] for pt in coords)
        x = xs[len(xs) // 2]
        y = ys[len(ys) // 2]
    elif kind.endswith("_v") and len(coords) == 2 and any(is_rail(node) for node in nodes):
        non_rail = [net_positions.get(node) for node in nodes if not is_rail(node)]
        x = non_rail[0][0] if non_rail else (sum(pt[0] for pt in coords) / len(coords))
        y = sum(pt[1] for pt in coords) / max(1, len(coords))
    else:
        x = sum(pt[0] for pt in coords) / max(1, len(coords))
        y = sum(pt[1] for pt in coords) / max(1, len(coords))
    rotation = 0
    if kind.endswith("_v") or kind == "source_v":
        rotation = 90
    pin_map = PIN_LAYOUTS[kind]
    pin_points: dict[str, tuple[float, float]] = {}
    for index, node in enumerate(nodes, start=1):
        dx, dy = pin_map.get(str(index), (0.0, 0.0))
        pin_points[str(index)] = (x + dx, y + dy)
    return {
        "name": comp.get("name"),
        "kind": kind,
        "x": x,
        "y": y,
        "rotation": rotation,
        "component": comp,
        "pin_points": pin_points,
    }


def refresh_pin_points(placed: dict[str, Any]) -> None:
    pin_map = PIN_LAYOUTS[placed["kind"]]
    nodes = component_nodes(placed["component"])
    pin_points: dict[str, tuple[float, float]] = {}
    for index, _node in enumerate(nodes, start=1):
        dx, dy = pin_map.get(str(index), (0.0, 0.0))
        pin_points[str(index)] = (placed["x"] + dx, placed["y"] + dy)
    placed["pin_points"] = pin_points


def spread_overlapping_placements(placements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    for placed in placements:
        key = (round(float(placed["x"]) * 10), round(float(placed["y"]) * 10))
        grouped[key].append(placed)

    for group in grouped.values():
        if len(group) <= 1:
            continue
        offsets = []
        count = len(group)
        spacing = 8.0
        center = (count - 1) / 2.0
        for index in range(count):
            offsets.append((index - center) * spacing)
        for placed, offset in zip(group, offsets):
            if placed["kind"].endswith("_v") or placed["kind"] == "source_v":
                placed["x"] += offset
            else:
                placed["y"] += offset
            refresh_pin_points(placed)
    return placements


def route_segments(start: tuple[float, float], end: tuple[float, float]) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    if abs(start[0] - end[0]) < 1e-6 or abs(start[1] - end[1]) < 1e-6:
        return [(start, end)]
    elbow = (end[0], start[1])
    return [(start, elbow), (elbow, end)]


def unique_sorted(values: list[float]) -> list[float]:
    ordered = sorted(values)
    unique: list[float] = []
    for value in ordered:
        if not unique or not math.isclose(unique[-1], value, abs_tol=1e-6):
            unique.append(value)
    return unique


def append_wire_segment(
    wires: list[dict[str, Any]],
    junction_counter: dict[tuple[float, float], int],
    net: str,
    start: tuple[float, float],
    end: tuple[float, float],
) -> None:
    if math.isclose(start[0], end[0], abs_tol=1e-6) and math.isclose(start[1], end[1], abs_tol=1e-6):
        return
    wires.append({"start": start, "end": end, "net": net})
    junction_counter[start] += 1
    junction_counter[end] += 1


def routed_points_by_net(placements: list[dict[str, Any]]) -> dict[str, list[tuple[float, float]]]:
    grouped: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for placed in placements:
        nodes = component_nodes(placed["component"])
        for index, node in enumerate(nodes, start=1):
            point = placed["pin_points"].get(str(index))
            if point is None:
                continue
            grouped[str(node)].append(point)
    return grouped


def net_trunk_orientation(
    net: str,
    points: list[tuple[float, float]],
    anchor: tuple[float, float],
    profile: str,
    input_node: str,
    output_node: str,
) -> str:
    lower = net.lower()
    if is_rail(net):
        return "horizontal"
    if profile == "signal_chain_comparator":
        if lower in {"vth"}:
            return "vertical"
        special_h = {
            input_node.lower() if input_node else "",
            output_node.lower() if output_node else "",
            "vp",
            "vn",
            "op_raw",
            "op_out",
            "filt",
            "alarm_n",
        }
        if lower in special_h:
            return "horizontal"
    if profile == "rf_mixed_signal":
        if lower in {"vgate", "vbias", "vth", "ref"}:
            return "vertical"
        special_h = {
            input_node.lower() if input_node else "",
            output_node.lower() if output_node else "",
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
            "alarm_n",
        }
        if lower in special_h:
            return "horizontal"
    xs = [pt[0] for pt in points] + [anchor[0]]
    ys = [pt[1] for pt in points] + [anchor[1]]
    x_span = max(xs) - min(xs) if xs else 0.0
    y_span = max(ys) - min(ys) if ys else 0.0
    return "horizontal" if x_span >= y_span else "vertical"


def build_net_wires(
    placements: list[dict[str, Any]],
    net_positions: dict[str, tuple[float, float]],
    *,
    profile: str,
    input_node: str,
    output_node: str,
) -> tuple[list[dict[str, Any]], list[tuple[float, float]]]:
    wires: list[dict[str, Any]] = []
    junction_counter: dict[tuple[float, float], int] = defaultdict(int)
    pin_points = routed_points_by_net(placements)

    for net, points in pin_points.items():
        anchor = net_positions.get(net)
        if anchor is None:
            continue
        if len(points) <= 1:
            for point in points:
                for start, end in route_segments(point, anchor):
                    append_wire_segment(wires, junction_counter, net, start, end)
            continue

        orientation = net_trunk_orientation(net, points, anchor, profile, input_node, output_node)
        if orientation == "horizontal":
            y = anchor[1]
            xs = unique_sorted([anchor[0], *[pt[0] for pt in points]])
            for point in points:
                if not math.isclose(point[1], y, abs_tol=1e-6):
                    append_wire_segment(wires, junction_counter, net, point, (point[0], y))
            for start_x, end_x in zip(xs, xs[1:]):
                append_wire_segment(wires, junction_counter, net, (start_x, y), (end_x, y))
        else:
            x = anchor[0]
            ys = unique_sorted([anchor[1], *[pt[1] for pt in points]])
            for point in points:
                if not math.isclose(point[0], x, abs_tol=1e-6):
                    append_wire_segment(wires, junction_counter, net, point, (x, point[1]))
            for start_y, end_y in zip(ys, ys[1:]):
                append_wire_segment(wires, junction_counter, net, (x, start_y), (x, end_y))

    junctions = [pt for pt, count in junction_counter.items() if count >= 3]
    return wires, junctions


def build_layout(payload: dict[str, Any]) -> dict[str, Any]:
    components = [normalize_component_record(c) for c in payload.get("components", [])]
    io = payload.get("io_inference", {})
    input_node = str(io.get("input_node") or "")
    output_node = str(io.get("output_node") or "")
    profile = classify_layout_profile(components, input_node, output_node)
    net_positions = build_net_positions(components, input_node, output_node)
    placements = spread_overlapping_placements([place_component(comp, net_positions) for comp in components])
    wires, junctions = build_net_wires(
        placements,
        net_positions,
        profile=profile,
        input_node=input_node,
        output_node=output_node,
    )
    all_points = list(net_positions.values()) + [
        placed_point
        for placed in placements
        for placed_point in [(placed["x"], placed["y"]) ]
    ]
    min_x = min((pt[0] for pt in all_points), default=0.0) - 25.0
    min_y = min((pt[1] for pt in all_points), default=0.0) - 25.0
    max_x = max((pt[0] for pt in all_points), default=200.0) + 25.0
    max_y = max((pt[1] for pt in all_points), default=120.0) + 25.0
    return {
        "components": components,
        "input_node": input_node,
        "output_node": output_node,
        "profile": profile,
        "net_positions": net_positions,
        "placements": placements,
        "wires": wires,
        "junctions": junctions,
        "bbox": {"min_x": min_x, "min_y": min_y, "max_x": max_x, "max_y": max_y},
    }


def svg_coord(pt: tuple[float, float], bbox: dict[str, float], scale: float) -> tuple[float, float]:
    return ((pt[0] - bbox["min_x"]) * scale, (pt[1] - bbox["min_y"]) * scale)


def quote(value: str) -> str:
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"') + '"'


def format_mm(value: float) -> str:
    return f"{value:.4f}".rstrip("0").rstrip(".") if not math.isclose(value, round(value), abs_tol=1e-9) else f"{round(value):d}"
