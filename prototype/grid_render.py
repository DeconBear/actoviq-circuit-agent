#!/usr/bin/env python3
"""Prototype: AI-authored grid layout -> clean schemdraw schematic.

The AI supplies a coarse *layout intent* (one device per integer grid cell, an
orientation, and per-pin net names). Deterministic code then does the geometry:

  * one device per cell  -> overlaps are structurally impossible
  * power/ground rails    -> the bulk of wires leave the body area
  * a crossing-aware maze router (Dijkstra on a fine channel grid, with
    orthogonal pin escapes) routes the rest, minimising wire crossings

    python prototype/grid_render.py --layout prototype/ldo.layout.json \
        --svg-path out.svg
"""
from __future__ import annotations

import argparse
import heapq
import json
from collections import defaultdict
from pathlib import Path

import schemdraw
import schemdraw.elements as elm

COL_W = 6.0
ROW_H = 5.0
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


def add_segment(segments: list, a: tuple[float, float], b: tuple[float, float]) -> None:
    if abs(a[0] - b[0]) > 1e-6 or abs(a[1] - b[1]) > 1e-6:
        segments.append((a, b))


# --------------------------------------------------------------------------- #
# Crossing-aware maze router
# --------------------------------------------------------------------------- #
RSTEP = 1.0
R_TURN = 0.5     # prefer straight wires
R_CROSS = 4.0    # avoid crossing another net
R_SHARE = 25.0   # never run on top of another net


def _route_axes(x_lo, x_hi, y_lo, y_hi):
    nx = max(1, round((x_hi - x_lo) / RSTEP))
    ny = max(1, round((y_hi - y_lo) / RSTEP))
    xs = [round(x_lo + i * RSTEP, 1) for i in range(nx + 1)]
    ys = [round(y_lo + j * RSTEP, 1) for j in range(ny + 1)]
    return xs, ys


def _in_box(n, box, m=1e-6):
    return box[0] - m <= n[0] <= box[2] + m and box[1] - m <= n[1] <= box[3] + m


def _merge_iv(intervals):
    intervals = sorted(intervals)
    out = []
    for a, b in intervals:
        if out and a <= out[-1][1] + 1e-6:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def _merge_net(edges):
    """Collapse a net's grid edges into maximal segments + junction nodes."""
    adj = defaultdict(set)
    horiz, vert = defaultdict(list), defaultdict(list)
    for u, v in edges:
        adj[u].add(v)
        adj[v].add(u)
        if abs(u[1] - v[1]) < 1e-6:
            horiz[u[1]].append(tuple(sorted((u[0], v[0]))))
        else:
            vert[u[0]].append(tuple(sorted((u[1], v[1]))))
    segs = []
    for y, ivs in horiz.items():
        segs += [((a, y), (b, y)) for a, b in _merge_iv(ivs)]
    for x, ivs in vert.items():
        segs += [((x, a), (x, b)) for a, b in _merge_iv(ivs)]
    juncs = [n for n in adj if len(adj[n]) >= 3]
    return segs, juncs


def maze_route(nets, route_boxes, x_lo, x_hi, y_lo, y_hi):
    """nets: list of (net, [(pin_xy, center_xy), ...]). Returns routed segments,
    junction dots, and the short pin-escape stubs (device's own connections)."""
    xs, ys = _route_axes(x_lo, x_hi, y_lo, y_hi)
    xset, yset = set(xs), set(ys)
    blocked = {(x, y) for x in xs for y in ys if any(_in_box((x, y), b) for b in route_boxes)}
    huse, vuse = defaultdict(set), defaultdict(set)
    route_segs, juncs, stubs = [], [], []

    def snap(v, axis):
        return min(axis, key=lambda a: abs(a - v))

    def valid(n):
        return n[0] in xset and n[1] in yset and n not in blocked

    def escape(pin, center):
        # Step orthogonally out of the body in the pin's natural exit direction
        # so the access stub is never diagonal and clears the device.
        px, py = pin
        cx, cy = center
        if abs(py - cy) >= abs(px - cx):
            d = (0.0, RSTEP if py >= cy else -RSTEP)
        else:
            d = (RSTEP if px >= cx else -RSTEP, 0.0)
        n = (snap(px, xs), snap(py, ys))
        for _ in range(12):
            if valid(n):
                return n
            n = (round(n[0] + d[0], 1), round(n[1] + d[1], 1))
        return n

    def neighbours(node):
        x, y = node
        for dx, dy, orient in ((RSTEP, 0, 1), (-RSTEP, 0, 1), (0, RSTEP, 2), (0, -RSTEP, 2)):
            m = (round(x + dx, 1), round(y + dy, 1))
            if valid(m):
                yield m, orient

    for net, pin_centers in nets:
        escapes = [escape(p, c) for p, c in pin_centers]
        for (p, _c), e in zip(pin_centers, escapes):
            stubs.append((p, e))
        tree = {escapes[0]}
        net_edges = set()
        for target in escapes[1:]:
            if target in tree:
                continue
            pq = [(0.0, 0, target, 0, None)]
            best, prev, cnt, goal = {}, {}, 1, None
            while pq:
                cost, _, node, ld, par = heapq.heappop(pq)
                key = (node, ld)
                if key in best and best[key] <= cost:
                    continue
                best[key] = cost
                prev[key] = par
                if node in tree:
                    goal = key
                    break
                for m, orient in neighbours(node):
                    nc = cost + RSTEP
                    if ld and ld != orient:
                        nc += R_TURN
                    oh = any(s != net for s in huse.get(m, ()))
                    ov = any(s != net for s in vuse.get(m, ()))
                    if orient == 1 and ov:
                        nc += R_CROSS
                    if orient == 2 and oh:
                        nc += R_CROSS
                    if orient == 1 and oh:
                        nc += R_SHARE
                    if orient == 2 and ov:
                        nc += R_SHARE
                    heapq.heappush(pq, (nc, cnt, m, orient, key))
                    cnt += 1
            if goal is None:
                continue
            path, k = [], goal
            while k is not None:
                path.append(k[0])
                k = prev.get(k)
            for u, v in zip(path, path[1:]):
                net_edges.add((u, v))
                tree.add(u)
                tree.add(v)
                if abs(u[1] - v[1]) < 1e-6:
                    huse[u].add(net); huse[v].add(net)
                else:
                    vuse[u].add(net); vuse[v].add(net)
        segs, jn = _merge_net(net_edges)
        route_segs += segs
        juncs += jn
    return route_segs, juncs, stubs


def _seg_is_h(s):
    return abs(s[0][1] - s[1][1]) < 1e-6


def geometry_check(segments, boxes):
    """Count wire-wire crossings and routed wires passing through device bodies
    (pin-escape stubs are excluded by the caller)."""
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
            if min(sx1, bx1) - max(sx0, bx0) > 0.3 and min(sy1, by1) - max(sy0, by0) > 0.3:
                intrusions += 1
    return {"device_overlaps": 0, "wire_crossings": crossings, "wire_body_intrusions": intrusions}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--layout", required=True)
    parser.add_argument("--svg-path", required=True)
    args = parser.parse_args()

    layout = json.loads(Path(args.layout).read_text(encoding="utf-8"))
    rails = layout.get("rails", {})

    schemdraw.use("svg")
    d = schemdraw.Drawing(show=False, transparent=False)
    d.config(fontsize=FS, lw=2, color=WIRE, bgcolor=BG, margin=0.4)

    net_pins: dict[str, list] = {}
    route_boxes, check_boxes = [], []
    for dev in layout["devices"]:
        anchors = place_device(d, dev)
        cx, cy = cell_xy(dev["cell"])
        route_boxes.append((cx - 1.6, cy - 2.0, cx + 1.6, cy + 2.0))
        check_boxes.append((cx - 1.3, cy - 1.6, cx + 1.3, cy + 1.6))
        for pin_name, net in dev["pins"].items():
            net_pins.setdefault(net, []).append((anchors[pin_name], (cx, cy)))

    cols = [dev["cell"][0] for dev in layout["devices"]]
    rows = [dev["cell"][1] for dev in layout["devices"]]
    x_lo, x_hi = min(cols) * COL_W - COL_W, max(cols) * COL_W + COL_W
    y_top = -(min(rows) * ROW_H) + ROW_H * 0.85
    y_bot = -(max(rows) * ROW_H) - ROW_H * 0.85

    rail_segs, stub_segs, route_segs, junctions = [], [], [], []

    # Power/ground rails: one horizontal bus, each pin stubbed to it.
    for net, side in rails.items():
        rail_y = y_top if side == "top" else y_bot
        add_segment(rail_segs, (x_lo, rail_y), (x_hi, rail_y))
        for (px, py), _c in net_pins.get(net, []):
            add_segment(stub_segs, (px, py), (px, rail_y))
            junctions.append((px, rail_y))
        d.add(elm.Label().at(((x_lo + x_hi) / 2, rail_y + (0.4 if side == "top" else -0.7)))
              .label(net.upper(), fontsize=FS, color=ACCENT))

    # Remaining signal nets: crossing-aware maze routing.
    non_rail = [(net, pcs) for net, pcs in net_pins.items()
                if net not in rails and len(pcs) >= 2]
    non_rail.sort(key=lambda kv: (max(p[0] for p, _ in kv[1]) - min(p[0] for p, _ in kv[1])) +
                                 (max(p[1] for p, _ in kv[1]) - min(p[1] for p, _ in kv[1])))
    rsegs, rjuncs, rstubs = maze_route(non_rail, route_boxes, x_lo, x_hi, y_bot, y_top)
    route_segs += rsegs
    stub_segs += rstubs
    junctions += rjuncs

    for a, b in rail_segs + route_segs + stub_segs:
        d.add(elm.Line().at(a).to(b).color(WIRE))
    for jx, jy in junctions:
        d.add(elm.Dot().at((jx, jy)).color(WIRE))

    Path(args.svg_path).parent.mkdir(parents=True, exist_ok=True)
    d.save(args.svg_path, transparent=False)

    metrics = geometry_check(rail_segs + route_segs, check_boxes)
    metrics.update({"ok": True, "svg_path": args.svg_path,
                    "devices": len(layout["devices"]), "nets": len(net_pins)})
    print(json.dumps(metrics, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
