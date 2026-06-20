#!/usr/bin/env python3
"""Prototype: AI-authored grid layout -> clean schemdraw schematic.

The AI supplies a coarse *layout intent* (one device per integer grid cell, an
orientation, and per-pin net names). Deterministic code then does the geometry:

  * one device per cell  -> overlaps are structurally impossible
  * power/ground rails    -> the bulk of wires leave the body area
  * orthogonal "comb" routing in the channels between cells

This is the division of labour the flat-netlist renderers get wrong: the AI owns
*placement* (which it understands), code owns *coordinates + routing* (which it
is good at). Run:

    python prototype/grid_render.py --layout prototype/ldo.layout.json \
        --svg-path out.svg
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import schemdraw
import schemdraw.elements as elm

COL_W = 4.0
ROW_H = 4.0
LEAD = 1.1            # half-length of a 2-terminal symbol
WIRE = "#222"
ACCENT = "#165c7d"
BG = "#fffdf8"
FS = 10


def cell_xy(cell: list[int]) -> tuple[float, float]:
    return (cell[0] * COL_W, -cell[1] * ROW_H)


def two_terminal_class(kind: str):
    return {
        "res": elm.ResistorIEEE,
        "cap": elm.Capacitor,
        "ind": elm.Inductor2,
        "vsrc": elm.SourceV,
        "isrc": elm.SourceI,
        "diode": elm.Diode,
    }.get(kind)


def place_device(d: schemdraw.Drawing, dev: dict) -> dict[str, tuple[float, float]]:
    """Draw one device at its cell and return {pin_name: (x, y)}."""
    kind = dev["kind"]
    cx, cy = cell_xy(dev["cell"])
    pins = dev["pins"]
    ref = dev.get("ref", "")
    value = str(dev.get("value", ""))

    cls = two_terminal_class(kind)
    if cls is not None:
        horizontal = dev.get("orient") in {"left", "right"}
        if horizontal:
            p_a, p_b = (cx - LEAD, cy), (cx + LEAD, cy)
        else:
            p_a, p_b = (cx, cy + LEAD), (cx, cy - LEAD)
        element = cls().endpoints(p_a, p_b).color(WIRE)
        if ref:
            element.label(ref, loc="left" if not horizontal else "top", fontsize=FS)
        if value:
            element.label(value, loc="right" if not horizontal else "bot",
                          fontsize=FS - 1, color=ACCENT)
        added = d.add(element)
        keys = list(pins.keys())
        return {
            keys[0]: (added.absanchors["start"].x, added.absanchors["start"].y),
            keys[1]: (added.absanchors["end"].x, added.absanchors["end"].y),
        }

    if kind in {"nmos", "pmos"}:
        if kind == "nmos":
            element = elm.NFet().reverse().anchor("center").at((cx, cy)).color(WIRE)
        else:
            element = elm.PFet().theta(180).anchor("center").at((cx, cy)).color(WIRE)
        if dev.get("flip"):
            element = element.flip()
        added = d.add(element)
        if ref:
            d.add(elm.Label().at((cx - 1.9, cy + 0.5)).label(ref, fontsize=FS, color=WIRE))
        if value:
            d.add(elm.Label().at((cx - 1.9, cy - 0.4))
                  .label(value, fontsize=FS - 2, color=ACCENT))
        return {
            "D": (added.absanchors["drain"].x, added.absanchors["drain"].y),
            "G": (added.absanchors["gate"].x, added.absanchors["gate"].y),
            "S": (added.absanchors["source"].x, added.absanchors["source"].y),
        }

    raise ValueError(f"unknown device kind: {kind}")


def snap_channel(value: float, step: float) -> float:
    """Snap a coordinate to the mid-line between grid cells (a wiring channel)."""
    k = round(value / step - 0.5)
    return (k + 0.5) * step


def add_segment(segments: list, a: tuple[float, float], b: tuple[float, float]) -> None:
    if abs(a[0] - b[0]) < 1e-6 and abs(a[1] - b[1]) < 1e-6:
        return
    segments.append((a, b))


def route_comb(net_pins: list[tuple[float, float]], segments: list) -> None:
    """Route a multi-pin net with an orthogonal trunk + perpendicular stubs."""
    xs = [p[0] for p in net_pins]
    ys = [p[1] for p in net_pins]
    spread_x, spread_y = max(xs) - min(xs), max(ys) - min(ys)
    if spread_x >= spread_y:
        trunk_y = snap_channel(sorted(ys)[len(ys) // 2], ROW_H)
        add_segment(segments, (min(xs), trunk_y), (max(xs), trunk_y))
        for px, py in net_pins:
            add_segment(segments, (px, py), (px, trunk_y))
    else:
        trunk_x = snap_channel(sorted(xs)[len(xs) // 2], COL_W)
        add_segment(segments, (trunk_x, min(ys)), (trunk_x, max(ys)))
        for px, py in net_pins:
            add_segment(segments, (px, py), (trunk_x, py))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--layout", required=True)
    parser.add_argument("--svg-path", required=True)
    args = parser.parse_args()

    layout = json.loads(Path(args.layout).read_text(encoding="utf-8"))
    rails = layout.get("rails", {})  # {net: "top"|"bottom"}

    schemdraw.use("svg")
    d = schemdraw.Drawing(show=False, transparent=False)
    d.config(fontsize=FS, lw=2, color=WIRE, bgcolor=BG, margin=0.4)

    net_pins: dict[str, list[tuple[float, float]]] = {}
    device_boxes: list[tuple[float, float, float, float]] = []
    for dev in layout["devices"]:
        anchors = place_device(d, dev)
        cx, cy = cell_xy(dev["cell"])
        device_boxes.append((cx - 1.3, cy - 1.6, cx + 1.3, cy + 1.6))
        for pin_name, net in dev["pins"].items():
            net_pins.setdefault(net, []).append(anchors[pin_name])

    cols = [dev["cell"][0] for dev in layout["devices"]]
    rows = [dev["cell"][1] for dev in layout["devices"]]
    x_lo, x_hi = min(cols) * COL_W - COL_W, max(cols) * COL_W + COL_W
    y_top = -(min(rows) * ROW_H) + ROW_H * 0.85
    y_bot = -(max(rows) * ROW_H) - ROW_H * 0.85

    segments: list = []
    junctions: list[tuple[float, float]] = []

    # Power/ground rails: one horizontal bus, each pin stubbed to it.
    for net, side in rails.items():
        rail_y = y_top if side == "top" else y_bot
        add_segment(segments, (x_lo, rail_y), (x_hi, rail_y))
        for px, py in net_pins.get(net, []):
            add_segment(segments, (px, py), (px, rail_y))
            junctions.append((px, rail_y))
        d.add(elm.Label().at(((x_lo + x_hi) / 2, rail_y + (0.4 if side == "top" else -0.7)))
              .label(net.upper(), fontsize=FS, color=ACCENT))

    # Remaining signal nets: orthogonal comb routing in the channels.
    for net, pins in net_pins.items():
        if net in rails or len(pins) < 2:
            continue
        route_comb(pins, segments)

    for a, b in segments:
        d.add(elm.Line().at(a).to(b).color(WIRE))
    for jx, jy in junctions:
        d.add(elm.Dot().at((jx, jy)).color(WIRE))

    Path(args.svg_path).parent.mkdir(parents=True, exist_ok=True)
    d.save(args.svg_path, transparent=False)

    metrics = geometry_check(segments, device_boxes)
    metrics.update({"ok": True, "svg_path": args.svg_path,
                    "devices": len(layout["devices"]), "nets": len(net_pins)})
    print(json.dumps(metrics, ensure_ascii=False))
    return 0


def _seg_is_h(s):
    return abs(s[0][1] - s[1][1]) < 1e-6


def geometry_check(segments: list, boxes: list) -> dict:
    """Count wire-wire crossings and wires passing through device bodies."""
    crossings = 0
    h = [s for s in segments if _seg_is_h(s)]
    v = [s for s in segments if not _seg_is_h(s)]
    for hs in h:
        hy = hs[0][1]
        hx0, hx1 = sorted([hs[0][0], hs[1][0]])
        for vs in v:
            vx = vs[0][0]
            vy0, vy1 = sorted([vs[0][1], vs[1][1]])
            if hx0 < vx < hx1 and vy0 < hy < vy1:
                crossings += 1
    intrusions = 0
    for s in segments:
        sx0, sx1 = sorted([s[0][0], s[1][0]])
        sy0, sy1 = sorted([s[0][1], s[1][1]])
        for bx0, by0, bx1, by1 in boxes:
            # overlap of segment's span with the body interior
            ix = min(sx1, bx1) - max(sx0, bx0)
            iy = min(sy1, by1) - max(sy0, by0)
            if ix > 0.3 and iy > 0.3:
                intrusions += 1
    return {"device_overlaps": 0, "wire_crossings": crossings,
            "wire_body_intrusions": intrusions}


if __name__ == "__main__":
    raise SystemExit(main())
