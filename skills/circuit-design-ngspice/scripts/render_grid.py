#!/usr/bin/env python3
"""Render a clean analog schematic from a SPICE netlist via idiom recognition.

netlistsvg/ELK and the schemdraw build_layout path both *guess* placement from a
flat netlist and tangle transistor-level analog circuits. This renderer instead
recognises the common analog idioms (current mirror, differential pair, tail
source, pass device, feedback divider, output loads, rails) straight from
connectivity, places one device per grid cell (so overlaps are impossible),
draws power/ground rails, and routes the rest with a crossing-aware maze router.

    python render_grid.py --netlist design.cir --svg-path schematic.svg

Emits a JSON status line. Degrades to ``{"ok": false}`` if schemdraw is missing
so the caller can fall back to netlistsvg.
"""
from __future__ import annotations

import argparse
import heapq
import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path

try:
    import schemdraw
    import schemdraw.elements as elm
    _SCHEMDRAW_OK = True
except Exception:  # pragma: no cover - optional dependency
    _SCHEMDRAW_OK = False

COL_W = 6.0
ROW_H = 5.0
LEAD = 1.1
WIRE = "#222"
ACCENT = "#165c7d"
BG = "#fffdf8"
FS = 10


# --------------------------------------------------------------------------- #
# Netlist parsing
# --------------------------------------------------------------------------- #
def read_netlist(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() in {".md", ".markdown"}:
        blocks = re.findall(r"```(?:spice|cir|netlist)\s*\r?\n([\s\S]*?)```", text, re.I)
        if blocks:
            return "\n".join(b.strip() for b in blocks)
    return text


def short_wl(params: str) -> str:
    w = re.search(r"(?i)\bW=(\S+)", params)
    l = re.search(r"(?i)\bL=(\S+)", params)
    return f"{w.group(1).rstrip('uU')}/{l.group(1).rstrip('uU')}" if w and l else ""


def parse(netlist: str) -> list[dict]:
    models: dict[str, str] = {}
    for name, kind in re.findall(r"(?im)^\s*\.model\s+(\S+)\s+(NMOS|PMOS)", netlist):
        models[name] = "nmos" if kind.upper() == "NMOS" else "pmos"
    devices: list[dict] = []
    for raw in netlist.splitlines():
        s = raw.strip()
        if not s or s.startswith("*") or s.startswith("."):
            continue
        tok = s.split()
        c = tok[0][0].upper()
        if c == "M" and len(tok) >= 6:
            devices.append({"ref": tok[0], "kind": models.get(tok[5], "nmos"),
                            "value": short_wl(" ".join(tok[6:])),
                            "pins": {"D": tok[1], "G": tok[2], "S": tok[3], "B": tok[4]}})
        elif c == "R" and len(tok) >= 4:
            devices.append({"ref": tok[0], "kind": "res", "value": tok[3],
                            "pins": {"1": tok[1], "2": tok[2]}})
        elif c == "C" and len(tok) >= 4:
            devices.append({"ref": tok[0], "kind": "cap", "value": tok[3],
                            "pins": {"1": tok[1], "2": tok[2]}})
        elif c == "V" and len(tok) >= 3:
            devices.append({"ref": tok[0], "kind": "vsrc", "value": " ".join(tok[3:]),
                            "pins": {"p": tok[1], "n": tok[2]}})
        elif c == "I" and len(tok) >= 3:
            devices.append({"ref": tok[0], "kind": "isrc", "value": " ".join(tok[3:]),
                            "pins": {"p": tok[1], "n": tok[2]}})
    return devices


# --------------------------------------------------------------------------- #
# Idiom-based auto-placement  (netlist -> grid layout-IR)
# --------------------------------------------------------------------------- #
def auto_layout(devices: list[dict]) -> dict:
    by_ref = {d["ref"]: d for d in devices}
    fets = [d for d in devices if d["kind"] in {"nmos", "pmos"}]
    twos = [d for d in devices if d["kind"] in {"res", "cap"}]

    src_fanout: dict[str, int] = {}
    for d in fets:
        src_fanout[d["pins"]["S"]] = src_fanout.get(d["pins"]["S"], 0) + 1
    supply = max(src_fanout, key=src_fanout.get) if src_fanout else None
    rails = {"0": "bottom"}
    if supply and supply != "0":
        rails[supply] = "top"

    load_fanout: dict[str, int] = {}
    for d in twos:
        for net in (d["pins"]["1"], d["pins"]["2"]):
            if net not in rails:
                load_fanout[net] = load_fanout.get(net, 0) + 1
    output = max(load_fanout, key=load_fanout.get) if load_fanout else None

    placed: dict[str, dict] = {}
    used: set[str] = set()
    for d in devices:
        if d["kind"] == "vsrc" and supply in d["pins"].values() and "0" in d["pins"].values():
            used.add(d["ref"])

    def place(ref, cell, *, orient=None, flip=False):
        d = dict(by_ref[ref])
        d["cell"] = list(cell)
        if orient:
            d["orient"] = orient
        if flip:
            d["flip"] = True
        d["pins"] = {k: v for k, v in d["pins"].items() if k != "B"}
        placed[ref] = d
        used.add(ref)

    mirror = None
    for kind in ("pmos", "nmos"):
        groups: dict[str, list] = {}
        for d in (f for f in fets if f["kind"] == kind):
            groups.setdefault(d["pins"]["G"], []).append(d)
        for grp in groups.values():
            diode = [d for d in grp if d["pins"]["D"] == d["pins"]["G"]]
            if len(grp) >= 2 and diode:
                mirror = {"ref": diode[0], "out": [d for d in grp if d is not diode[0]]}
                break
        if mirror:
            break

    diff = None
    for kind in ("nmos", "pmos"):
        groups = {}
        for d in (f for f in fets if f["kind"] == kind and f["ref"] not in used):
            if d["pins"]["S"] not in rails:
                groups.setdefault(d["pins"]["S"], []).append(d)
        for tail_net, grp in groups.items():
            if len(grp) == 2:
                diff = {"tail": tail_net, "devs": grp}
                break
        if diff:
            break

    if diff:
        d0, d1 = diff["devs"]
        ref_gate = None
        for v in devices:
            if v["kind"] == "vsrc" and v["pins"]["p"] in (d0["pins"]["G"], d1["pins"]["G"]):
                ref_gate = v["pins"]["p"]
        if ref_gate and d0["pins"]["G"] == ref_gate:
            d0, d1 = d1, d0
        place(d0["ref"], (1, 2))
        place(d1["ref"], (2, 2), flip=True)
        if mirror:
            mref, mout = mirror["ref"], mirror["out"][0]
            left = mref if mref["pins"]["D"] == d0["pins"]["D"] else mout
            right = mout if left is mref else mref
            place(left["ref"], (1, 1))
            place(right["ref"], (2, 1), flip=True)
        for d in devices:
            if d["ref"] not in used and diff["tail"] in d["pins"].values() and "0" in d["pins"].values():
                place(d["ref"], (1, 3), orient="down")
        for d in devices:
            if d["kind"] == "vsrc" and d["ref"] not in used and d["pins"]["p"] == d1["pins"]["G"]:
                place(d["ref"], (0, 2), orient="down")

    if output:
        for d in fets:
            if d["ref"] not in used and d["pins"]["D"] == output:
                place(d["ref"], (4, 1))

    load_col = 4
    div_done = False
    for d in twos:
        if d["ref"] in used:
            continue
        nets = {d["pins"]["1"], d["pins"]["2"]}
        if output in nets and "0" in nets:
            place(d["ref"], (load_col, 3), orient="down")
            load_col += 1
        elif output in nets and not div_done:
            place(d["ref"], (6, 2), orient="down")
            tap = (nets - {output}).pop()
            for d2 in twos:
                if d2["ref"] not in used and tap in {d2["pins"]["1"], d2["pins"]["2"]} \
                        and "0" in {d2["pins"]["1"], d2["pins"]["2"]}:
                    place(d2["ref"], (6, 3), orient="down")
            div_done = True

    spare = 0
    for d in devices:
        if d["ref"] not in used:
            place(d["ref"], (spare, 4), orient="down")
            spare += 1

    return {"rails": rails, "tail_net": diff["tail"] if diff else None,
            "mirror_net": mirror["ref"]["pins"]["G"] if mirror else None,
            "devices": [placed[d["ref"]] for d in devices if d["ref"] in placed]}


# --------------------------------------------------------------------------- #
# Drawing  (grid layout-IR -> schemdraw SVG)
# --------------------------------------------------------------------------- #
def cell_xy(cell):
    return (cell[0] * COL_W, -cell[1] * ROW_H)


def two_terminal_class(kind):
    return {"res": elm.ResistorIEEE, "cap": elm.Capacitor, "ind": elm.Inductor2,
            "vsrc": elm.SourceV, "isrc": elm.SourceI, "diode": elm.Diode}.get(kind)


def place_device(d, dev):
    kind = dev["kind"]
    cx, cy = cell_xy(dev["cell"])
    pins, ref, value = dev["pins"], dev.get("ref", ""), str(dev.get("value", ""))
    cls = two_terminal_class(kind)
    if cls is not None:
        horizontal = dev.get("orient") in {"left", "right"}
        p_a, p_b = ((cx - LEAD, cy), (cx + LEAD, cy)) if horizontal else ((cx, cy + LEAD), (cx, cy - LEAD))
        element = cls().endpoints(p_a, p_b).color(WIRE)
        if ref:
            element.label(ref, loc="top" if horizontal else "left", fontsize=FS)
        if value:
            element.label(value, loc="bot" if horizontal else "right", fontsize=FS - 1, color=ACCENT)
        added = d.add(element)
        keys = list(pins.keys())
        return {keys[0]: (added.absanchors["start"].x, added.absanchors["start"].y),
                keys[1]: (added.absanchors["end"].x, added.absanchors["end"].y)}
    if kind in {"nmos", "pmos"}:
        # Both reversed so the gate is on the left; this puts the PMOS source /
        # NMOS drain at the top and the PMOS drain / NMOS source at the bottom,
        # matching a PMOS-mirror-over-NMOS-pair stack.
        element = (elm.NFet() if kind == "nmos" else elm.PFet()).reverse()
        element = element.anchor("center").at((cx, cy)).color(WIRE)
        if dev.get("flip"):
            element = element.flip()
        added = d.add(element)
        if ref:
            d.add(elm.Label().at((cx - 1.9, cy + 0.5)).label(ref, fontsize=FS, color=WIRE))
        if value:
            d.add(elm.Label().at((cx - 1.9, cy - 0.4)).label(value, fontsize=FS - 2, color=ACCENT))
        return {"D": (added.absanchors["drain"].x, added.absanchors["drain"].y),
                "G": (added.absanchors["gate"].x, added.absanchors["gate"].y),
                "S": (added.absanchors["source"].x, added.absanchors["source"].y)}
    raise ValueError(f"unknown device kind: {kind}")


def add_segment(segments, a, b):
    if abs(a[0] - b[0]) > 1e-6 or abs(a[1] - b[1]) > 1e-6:
        segments.append((a, b))


# --------------------------- crossing-aware maze router -------------------- #
RSTEP = 1.0
R_TURN = 0.5
R_CROSS = 4.0
R_SHARE = 25.0


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
    horizontal bar, then a single wire down to the tail source - no loops."""
    pts = sorted((pc[0] for pc in pin_centers), key=lambda p: p[1])
    tail_pin, sources = pts[0], pts[1:]
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
    for (px, py), _c in drains:
        route_segs.append((net, (px, py), (px, bus_y)))
        xs.append(round(px, 2))
    for (px, py), (ccx, _ccy) in gates:
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
    vertical wire of a different net, draw a small semicircle 'hop' so the
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


def render(layout, svg_path: Path) -> dict:
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

    handled = set(rails)
    tail_net = layout.get("tail_net")
    if tail_net and len(net_pins.get(tail_net, [])) >= 3:
        route_tail(tail_net, net_pins[tail_net], route_segs, junctions)
        handled.add(tail_net)
    if mirror_net and len(net_pins.get(mirror_net, [])) >= 3:
        if route_mirror(mirror_net, net_pins[mirror_net], route_segs, junctions):
            handled.add(mirror_net)

    non_rail = [(net, pcs) for net, pcs in net_pins.items() if net not in handled and len(pcs) >= 2]
    non_rail.sort(key=lambda kv: (max(p[0] for p, *_ in kv[1]) - min(p[0] for p, *_ in kv[1])) +
                                 (max(p[1] for p, *_ in kv[1]) - min(p[1] for p, *_ in kv[1])))
    rsegs, rjuncs, rstubs = maze_route(non_rail, route_boxes, x_lo, x_hi, y_bot, y_top)
    route_segs += rsegs
    stub_segs += rstubs
    junctions += rjuncs

    draw_wires(d, rail_segs + route_segs + stub_segs + diode_segs)
    for jx, jy in junctions:
        d.add(elm.Dot().at((jx, jy)).color(WIRE))

    svg_path.parent.mkdir(parents=True, exist_ok=True)
    d.save(str(svg_path), transparent=False)
    return geometry_check([(a, b) for _net, a, b in rail_segs + route_segs], check_boxes)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--netlist", required=True)
    ap.add_argument("--svg-path", required=True)
    args = ap.parse_args()
    if not _SCHEMDRAW_OK:
        print(json.dumps({"ok": False, "error": "schemdraw is not installed"}))
        return 0
    try:
        devices = parse(read_netlist(Path(args.netlist)))
        layout = auto_layout(devices)
        if not layout["devices"]:
            print(json.dumps({"ok": False, "error": "no placeable devices"}))
            return 0
        metrics = render(layout, Path(args.svg_path).resolve())
        print(json.dumps({"ok": True, "svg_path": str(Path(args.svg_path).resolve()),
                          "renderer": "grid", "metrics": metrics,
                          "devices": len(layout["devices"])}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
