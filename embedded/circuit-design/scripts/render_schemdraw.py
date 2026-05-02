#!/usr/bin/env python3
"""Render a report-oriented schematic SVG with the real schemdraw package."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import schemdraw
import schemdraw.elements as elm

from schematic_common import build_layout, load_design_payload, rail_kind


SCALE = 0.07
TEXT_SIZE = 10
TITLE_SIZE = 14
WIRE_COLOR = "#222"
ACCENT = "#165c7d"
BG = "#fffdf8"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Render report schematic SVG with schemdraw")
    parser.add_argument("--json-path", required=True, help="Design JSON path")
    parser.add_argument("--svg-path", required=True, help="Output SVG path")
    return parser


def to_xy(point: tuple[float, float], bbox: dict[str, float]) -> tuple[float, float]:
    x_mm, y_mm = point
    return ((x_mm - bbox["min_x"]) * SCALE, (bbox["max_y"] - y_mm) * SCALE)


def add_label(drawing: schemdraw.Drawing, xy: tuple[float, float], text: str, *, size: float = TEXT_SIZE) -> None:
    if not text:
        return
    drawing.add(elm.Label().at(xy).label(text, fontsize=size))


def two_terminal_element(kind: str):
    if kind.startswith("resistor"):
        return elm.ResistorIEEE
    if kind.startswith("capacitor"):
        return elm.Capacitor
    if kind.startswith("inductor"):
        return elm.Inductor2
    if kind.startswith("diode"):
        return elm.Diode
    if kind == "source_v":
        return elm.SourceV
    return None


def place_two_terminal(
    drawing: schemdraw.Drawing,
    placed: dict,
    bbox: dict[str, float],
) -> dict[str, tuple[float, float]]:
    cls = two_terminal_element(str(placed["kind"]))
    if cls is None:
        return {}

    pin1 = to_xy(tuple(placed["pin_points"]["1"]), bbox)
    pin2 = to_xy(tuple(placed["pin_points"]["2"]), bbox)
    element = cls().endpoints(pin1, pin2).color(WIRE_COLOR)
    comp = placed["component"]
    name = str(comp.get("name", ""))
    value = str(comp.get("display_value") or comp.get("sim_value") or "")
    if name:
        element.label(name, loc="top", fontsize=TEXT_SIZE)
    if value:
        element.label(value, loc="bot", fontsize=TEXT_SIZE - 1, color=ACCENT)
    added = drawing.add(element)
    return {
        "1": (added.absanchors["start"].x, added.absanchors["start"].y),
        "2": (added.absanchors["end"].x, added.absanchors["end"].y),
    }


def place_three_or_four_terminal(
    drawing: schemdraw.Drawing,
    placed: dict,
    bbox: dict[str, float],
) -> dict[str, tuple[float, float]]:
    kind = str(placed["kind"])
    center = to_xy((float(placed["x"]), float(placed["y"])), bbox)
    comp = placed["component"]
    name = str(comp.get("name", ""))
    value = str(comp.get("display_value") or comp.get("sim_value") or "")

    if kind == "bjt_npn":
        element = elm.BjtNpn().anchor("center").at(center).color(WIRE_COLOR)
        added = drawing.add(element)
        if name:
            added.label(name, loc="top", fontsize=TEXT_SIZE)
        if value:
            added.label(value, loc="bot", fontsize=TEXT_SIZE - 1, color=ACCENT)
        return {
            "1": (added.absanchors["collector"].x, added.absanchors["collector"].y),
            "2": (added.absanchors["base"].x, added.absanchors["base"].y),
            "3": (added.absanchors["emitter"].x, added.absanchors["emitter"].y),
        }

    if kind == "bjt_pnp":
        element = elm.BjtPnp().anchor("center").at(center).color(WIRE_COLOR)
        added = drawing.add(element)
        if name:
            added.label(name, loc="top", fontsize=TEXT_SIZE)
        if value:
            added.label(value, loc="bot", fontsize=TEXT_SIZE - 1, color=ACCENT)
        return {
            "1": (added.absanchors["collector"].x, added.absanchors["collector"].y),
            "2": (added.absanchors["base"].x, added.absanchors["base"].y),
            "3": (added.absanchors["emitter"].x, added.absanchors["emitter"].y),
        }

    if kind == "mos_n":
        element = elm.NFet().reverse().anchor("center").at(center).color(WIRE_COLOR)
        added = drawing.add(element)
        if name:
            added.label(name, loc="top", fontsize=TEXT_SIZE)
        if value:
            added.label(value, loc="bot", fontsize=TEXT_SIZE - 1, color=ACCENT)
        anchors = {
            "1": (added.absanchors["drain"].x, added.absanchors["drain"].y),
            "2": (added.absanchors["gate"].x, added.absanchors["gate"].y),
            "3": (added.absanchors["source"].x, added.absanchors["source"].y),
        }
        if "4" in placed["pin_points"]:
            anchors["4"] = anchors["3"]
        return anchors

    if kind == "mos_p":
        element = elm.PFet().theta(180).anchor("center").at(center).color(WIRE_COLOR)
        added = drawing.add(element)
        if name:
            added.label(name, loc="top", fontsize=TEXT_SIZE)
        if value:
            added.label(value, loc="bot", fontsize=TEXT_SIZE - 1, color=ACCENT)
        anchors = {
            "1": (added.absanchors["drain"].x, added.absanchors["drain"].y),
            "2": (added.absanchors["gate"].x, added.absanchors["gate"].y),
            "3": (added.absanchors["source"].x, added.absanchors["source"].y),
        }
        if "4" in placed["pin_points"]:
            anchors["4"] = anchors["3"]
        return anchors

    if kind in {"opamp", "comparator"}:
        element = elm.Opamp().anchor("center").at(center).color(WIRE_COLOR)
        added = drawing.add(element)
        if name:
            added.label(name, loc="top", fontsize=TEXT_SIZE)
        if value:
            added.label(value, loc="bot", fontsize=TEXT_SIZE - 1, color=ACCENT)
        if kind == "comparator":
            drawing.add(
                elm.Label()
                .at((center[0] - 0.05, center[1] - 0.42))
                .label("CMP", fontsize=TEXT_SIZE - 1, color=ACCENT)
            )
            output_node = str(comp.get("schematic_nodes", comp.get("nodes", [""]))[0]).lower()
            if output_node.endswith("_n") or output_node.startswith("alarm"):
                drawing.add(
                    elm.Dot(open=True)
                    .at((added.absanchors["out"].x + 0.12, added.absanchors["out"].y))
                    .color(WIRE_COLOR)
                )
        anchors = {
            "1": (added.absanchors["out"].x, added.absanchors["out"].y),
            "2": (added.absanchors["in2"].x, added.absanchors["in2"].y),
            "3": (added.absanchors["in1"].x, added.absanchors["in1"].y),
        }
        return anchors

    return {}


def place_component(
    drawing: schemdraw.Drawing,
    placed: dict,
    bbox: dict[str, float],
) -> dict[str, tuple[float, float]]:
    anchors = place_two_terminal(drawing, placed, bbox)
    if anchors:
        return anchors
    return place_three_or_four_terminal(drawing, placed, bbox)


def draw_terminal(
    drawing: schemdraw.Drawing,
    xy: tuple[float, float],
    net_name: str,
    label: str,
    direction: str,
) -> None:
    dot = drawing.add(elm.Dot(open=True).at(xy).color(WIRE_COLOR))
    if direction == "input":
        dot.label(label, loc="left", fontsize=TEXT_SIZE)
    else:
        dot.label(label, loc="right", fontsize=TEXT_SIZE)
    dot.label(net_name, loc="top", fontsize=TEXT_SIZE - 1)


def draw_rail(drawing: schemdraw.Drawing, xy: tuple[float, float], node: str) -> None:
    kind = rail_kind(node)
    if kind == "gnd":
        rail = drawing.add(elm.Ground().at(xy).color(WIRE_COLOR))
        rail.label(node, loc="right", fontsize=TEXT_SIZE - 1)
        return
    if kind == "vcc":
        rail = drawing.add(elm.Vdd().at(xy).color(WIRE_COLOR))
        rail.label(node, loc="right", fontsize=TEXT_SIZE - 1)
        return
    if kind == "vee":
        rail = drawing.add(elm.Vss().at(xy).color(WIRE_COLOR))
        rail.label(node, loc="right", fontsize=TEXT_SIZE - 1)


def add_wires(
    drawing: schemdraw.Drawing,
    layout: dict,
    bbox: dict[str, float],
) -> None:
    for wire in layout["wires"]:
        drawing.add(
            elm.Line()
            .at(to_xy(tuple(wire["start"]), bbox))
            .to(to_xy(tuple(wire["end"]), bbox))
            .color(WIRE_COLOR)
        )


def add_junctions(drawing: schemdraw.Drawing, layout: dict, bbox: dict[str, float]) -> None:
    for point in layout["junctions"]:
        drawing.add(elm.Dot().at(to_xy(tuple(point), bbox)).color(WIRE_COLOR))


def main() -> int:
    args = build_parser().parse_args()
    json_path = Path(args.json_path).resolve()
    svg_path = Path(args.svg_path).resolve()

    payload = load_design_payload(json_path)
    layout = build_layout(payload)
    bbox = layout["bbox"]

    schemdraw.use("svg")
    drawing = schemdraw.Drawing(show=False, transparent=False)
    drawing.config(fontsize=TEXT_SIZE, lw=2, color=WIRE_COLOR, bgcolor=BG, margin=0.25)

    title_xy = (((bbox["max_x"] - bbox["min_x"]) * SCALE) / 2.0, ((bbox["max_y"] - bbox["min_y"]) * SCALE) + 0.6)
    add_label(drawing, title_xy, json_path.stem.replace("_", " "), size=TITLE_SIZE)

    pin_anchor_map: dict[str, dict[str, tuple[float, float]]] = {}
    for placed in layout["placements"]:
        pin_anchor_map[str(placed["name"])] = place_component(drawing, placed, bbox)

    add_wires(drawing, layout, bbox)
    add_junctions(drawing, layout, bbox)

    input_node = str(layout.get("input_node") or "")
    output_node = str(layout.get("output_node") or "")
    if input_node and input_node in layout["net_positions"]:
        draw_terminal(drawing, to_xy(tuple(layout["net_positions"][input_node]), bbox), input_node, "IN", "input")
    if output_node and output_node in layout["net_positions"]:
        label = "OUT_N" if output_node.lower().endswith("_n") else "OUT"
        draw_terminal(drawing, to_xy(tuple(layout["net_positions"][output_node]), bbox), output_node, label, "output")

    for node, point in layout["net_positions"].items():
        if rail_kind(str(node)) is not None:
            draw_rail(drawing, to_xy(tuple(point), bbox), str(node))

    svg_path.parent.mkdir(parents=True, exist_ok=True)
    drawing.save(str(svg_path), transparent=False)
    print(json.dumps({"ok": True, "svg_path": str(svg_path), "backend": "schemdraw-svg"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
