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
import math
from collections import Counter, defaultdict
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
        # Both reversed so the gate sits on the left; this also puts the NMOS
        # drain / PMOS source at the top and the NMOS source / PMOS drain at the
        # bottom, which matches a PMOS-load-over-NMOS-pair stack (source->top
        # rail, drain->the pair below).
        element = (elm.NFet() if kind == "nmos" else elm.PFet()).reverse()
        element = element.anchor("center").at((cx, cy)).color(WIRE)
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
        escapes = [escape(pc[0], pc[1]) for pc in pin_centers]
        for pc, e in zip(pin_centers, escapes):
            stubs.append((net, pc[0], e))
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
        route_segs += [(net, a, b) for a, b in segs]
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


def route_tail(net, pin_centers, route_segs, junctions):
    """Idiom routing for a differential-pair tail: drop both sources to one
    horizontal bar, then a single wire down to the tail source — no loops."""
    pts = sorted((pc[0] for pc in pin_centers), key=lambda p: p[1])
    tail_pin, sources = pts[0], pts[1:]          # lowest pin is the tail source
    bar_y = round((min(s[1] for s in sources) + tail_pin[1]) / 2, 2)
    xs = [s[0] for s in sources] + [tail_pin[0]]
    route_segs.append((net, (min(xs), bar_y), (max(xs), bar_y)))
    for s in sources:
        route_segs.append((net, (s[0], s[1]), (s[0], bar_y)))
    route_segs.append((net, (tail_pin[0], tail_pin[1]), (tail_pin[0], bar_y)))
    counts = Counter(xs)
    for x in set(xs):
        if counts[x] >= 2 or min(xs) < x < max(xs):
            junctions.append((x, bar_y))


def route_mirror(net, pins, route_segs, junctions):
    """Current-mirror gate-bus idiom: connect the mirror gates and drains on a
    bus that runs just below the mirror bodies, so the gate connection clears the
    devices instead of snaking around them. Returns False if unrecognised."""
    gates = [(p, c) for p, c, r in pins if r == "G"]
    drains = [(p, c) for p, c, r in pins if r == "D"]
    if len(gates) < 2 or not drains:
        return False
    bus_y = round(min(c[1] for _p, c in gates) - 2.3, 2)
    xs = []
    for (px, py), _c in drains:                     # drains drop/raise to the bus
        route_segs.append((net, (px, py), (px, bus_y)))
        xs.append(round(px, 2))
    for (px, py), (ccx, _ccy) in gates:             # gates jog out, then to the bus
        jog_x = round(ccx - 2.5, 2)
        route_segs.append((net, (px, py), (jog_x, py)))
        route_segs.append((net, (jog_x, py), (jog_x, bus_y)))
        xs.append(jog_x)
    route_segs.append((net, (min(xs), bus_y), (max(xs), bus_y)))
    counts = Counter(xs)
    for x in set(xs):
        if counts[x] >= 2 or min(xs) < x < max(xs):
            junctions.append((x, bus_y))
    return True


def draw_wires(d, segments, hop_r=0.35, steps=10):
    """Draw tagged (net, a, b) segments. Where a horizontal wire crosses a
    vertical wire of a *different* net, draw a small semicircle 'hop' so the
    crossing is unambiguously a non-connection (standard schematic practice)."""
    H = [(net, a, b) for net, a, b in segments
         if abs(a[1] - b[1]) < 1e-6 and abs(a[0] - b[0]) > 1e-6]
    V = [(net, a, b) for net, a, b in segments
         if abs(a[0] - b[0]) < 1e-6 and abs(a[1] - b[1]) > 1e-6]
    for _net, a, b in V:
        d.add(elm.Line().at(a).to(b).color(WIRE))
    for net, a, b in H:
        y = a[1]
        x0, x1 = sorted((a[0], b[0]))
        hops = sorted({
            va[0] for (vnet, va, vb) in V
            if vnet != net and x0 + 1e-6 < va[0] < x1 - 1e-6
            and min(va[1], vb[1]) + 1e-6 < y < max(va[1], vb[1]) - 1e-6
        })
        cur = x0
        for hx in hops:
            if hx - hop_r > cur + 1e-6:
                d.add(elm.Line().at((cur, y)).to((hx - hop_r, y)).color(WIRE))
            arc = [(hx + hop_r * math.cos(math.pi * (1 - i / steps)),
                    y + hop_r * math.sin(math.pi * (1 - i / steps))) for i in range(steps + 1)]
            for p, q in zip(arc, arc[1:]):
                d.add(elm.Line().at(p).to(q).color(WIRE))
            cur = hx + hop_r
        if x1 > cur + 1e-6:
            d.add(elm.Line().at((cur, y)).to((x1, y)).color(WIRE))


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

    mirror_net = layout.get("mirror_net")
    net_pins: dict[str, list] = {}
    route_boxes, check_boxes, diode_segs = [], [], []
    for dev in layout["devices"]:
        anchors = place_device(d, dev)
        cx, cy = cell_xy(dev["cell"])
        route_boxes.append((cx - 1.6, cy - 1.8, cx + 1.6, cy + 1.8))
        check_boxes.append((cx - 1.3, cy - 1.6, cx + 1.3, cy + 1.6))
        pins = dev["pins"]
        diode = dev["kind"] in {"nmos", "pmos"} and pins.get("G") == pins.get("D")
        local_diode = diode and pins.get("G") != mirror_net  # mirror handles its own
        for pin_name, net in pins.items():
            if local_diode and pin_name == "G":
                continue  # gate tied to drain by a short local jumper, below
            net_pins.setdefault(net, []).append((anchors[pin_name], (cx, cy), pin_name))
        if local_diode:
            g, dr = anchors["G"], anchors["D"]
            diode_segs.append((pins["D"], (g[0], g[1]), (g[0], dr[1])))
            diode_segs.append((pins["D"], (g[0], dr[1]), (dr[0], dr[1])))

    cols = [dev["cell"][0] for dev in layout["devices"]]
    rows = [dev["cell"][1] for dev in layout["devices"]]
    x_lo, x_hi = min(cols) * COL_W - COL_W, max(cols) * COL_W + COL_W
    y_top = -(min(rows) * ROW_H) + ROW_H * 0.85
    y_bot = -(max(rows) * ROW_H) - ROW_H * 0.85

    rail_segs, stub_segs, route_segs, junctions = [], [], [], []

    # Power/ground rails: one horizontal bus, each pin stubbed to it.
    for net, side in rails.items():
        rail_y = y_top if side == "top" else y_bot
        if abs(x_lo - x_hi) > 1e-6:
            rail_segs.append((net, (x_lo, rail_y), (x_hi, rail_y)))
        for (px, py), _c, _r in net_pins.get(net, []):
            if abs(py - rail_y) > 1e-6:
                stub_segs.append((net, (px, py), (px, rail_y)))
            junctions.append((px, rail_y))
        d.add(elm.Label().at(((x_lo + x_hi) / 2, rail_y + (0.4 if side == "top" else -0.7)))
              .label(net.upper(), fontsize=FS, color=ACCENT))

    # Known sub-circuits routed as explicit idioms (no loops, clean buses).
    handled = set(rails)
    tail_net = layout.get("tail_net")
    if tail_net and len(net_pins.get(tail_net, [])) >= 3:
        route_tail(tail_net, net_pins[tail_net], route_segs, junctions)
        handled.add(tail_net)
    if mirror_net and len(net_pins.get(mirror_net, [])) >= 3:
        if route_mirror(mirror_net, net_pins[mirror_net], route_segs, junctions):
            handled.add(mirror_net)

    # Remaining signal nets: crossing-aware maze routing.
    non_rail = [(net, pcs) for net, pcs in net_pins.items()
                if net not in handled and len(pcs) >= 2]
    non_rail.sort(key=lambda kv: (max(p[0] for p, *_ in kv[1]) - min(p[0] for p, *_ in kv[1])) +
                                 (max(p[1] for p, *_ in kv[1]) - min(p[1] for p, *_ in kv[1])))
    rsegs, rjuncs, rstubs = maze_route(non_rail, route_boxes, x_lo, x_hi, y_bot, y_top)
    route_segs += rsegs
    stub_segs += rstubs
    junctions += rjuncs

    draw_wires(d, rail_segs + route_segs + stub_segs + diode_segs)
    for jx, jy in junctions:
        d.add(elm.Dot().at((jx, jy)).color(WIRE))

    Path(args.svg_path).parent.mkdir(parents=True, exist_ok=True)
    d.save(args.svg_path, transparent=False)

    metrics = geometry_check([(a, b) for _net, a, b in rail_segs + route_segs], check_boxes)
    metrics.update({"ok": True, "svg_path": args.svg_path,
                    "devices": len(layout["devices"]), "nets": len(net_pins)})
    print(json.dumps(metrics, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
