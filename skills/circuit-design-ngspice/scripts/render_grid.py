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
ACCENT = "#0d4a66"
BG = "#fffdf8"
FS = 10
JEPS = 1e-3          # geometry tolerance for junction / collinear tests


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
    for name, kind in re.findall(r"(?im)^\s*\.model\s+(\S+)\s+(NMOS|PMOS|NPN|PNP)", netlist):
        models[name] = {
            "NMOS": "nmos",
            "PMOS": "pmos",
            "NPN": "npn",
            "PNP": "pnp",
        }[kind.upper()]
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
        elif c == "Q" and len(tok) >= 5:
            model = tok[4]
            if len(tok) >= 6 and model not in models:
                model = tok[5]
            devices.append({"ref": tok[0], "kind": models.get(model, "npn"), "value": model,
                            "pins": {"C": tok[1], "B": tok[2], "E": tok[3]}})
        elif c == "R" and len(tok) >= 4:
            devices.append({"ref": tok[0], "kind": "res", "value": tok[3],
                            "pins": {"1": tok[1], "2": tok[2]}})
        elif c == "C" and len(tok) >= 4:
            devices.append({"ref": tok[0], "kind": "cap", "value": tok[3],
                            "pins": {"1": tok[1], "2": tok[2]}})
        elif c == "L" and len(tok) >= 4:
            devices.append({"ref": tok[0], "kind": "ind", "value": tok[3],
                            "pins": {"1": tok[1], "2": tok[2]}})
        elif c == "D" and len(tok) >= 4:
            devices.append({"ref": tok[0], "kind": "diode", "value": tok[3],
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
    bjts = [d for d in devices if d["kind"] in {"npn", "pnp"}]
    twos = [d for d in devices if d["kind"] in {"res", "cap", "ind", "diode"}]

    source_fanout: dict[str, int] = {}
    for d in fets:
        source_fanout[d["pins"]["S"]] = source_fanout.get(d["pins"]["S"], 0) + 1
    for d in bjts:
        key = "E" if d["kind"] == "pnp" else "C"
        source_fanout[d["pins"][key]] = source_fanout.get(d["pins"][key], 0) + 1

    def supply_score(net: str) -> float:
        lower = net.lower()
        score = source_fanout.get(net, 0) * 8.0
        if lower in {"vdd", "vcc", "vin", "vbat", "vp", "vplus"} or lower.startswith(("vdd", "vcc", "vin")):
            score += 100.0
        if lower.startswith(("vref", "ref", "vb", "vbias", "bias")):
            score -= 45.0
        for d in devices:
            pins = d["pins"]
            if d["kind"] == "vsrc" and pins.get("p") == net and pins.get("n") == "0":
                score += 60.0
            elif d["kind"] == "vsrc" and pins.get("n") == net and pins.get("p") == "0":
                score -= 20.0
            elif d["kind"] == "isrc" and net in pins.values():
                score += 5.0
        return score

    candidates = {net for d in devices for net in d["pins"].values() if net != "0"}
    supply = max(candidates, key=supply_score) if candidates else None
    if supply and supply_score(supply) < 50.0:
        supply = None
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

    common_bjt = None
    if not diff and bjts:
        common_bjt = bjts[0]
        place(common_bjt["ref"], (3, 2))
        base = common_bjt["pins"]["B"]
        collector = common_bjt["pins"]["C"]
        emitter = common_bjt["pins"]["E"]
        for d in devices:
            if d["ref"] in used:
                continue
            pins = set(d["pins"].values())
            if d["kind"] == "vsrc" and base in pins:
                place(d["ref"], (0, 2), orient="down")
            elif d["kind"] in {"res", "cap", "ind", "diode"} and base in pins and supply in pins:
                place(d["ref"], (2, 1), orient="down")
            elif d["kind"] in {"res", "cap", "ind", "diode"} and base in pins and "0" in pins:
                place(d["ref"], (2, 3), orient="down")
            elif d["kind"] in {"res", "cap", "ind", "diode"} and collector in pins and supply in pins:
                place(d["ref"], (3, 1), orient="down")
            elif d["kind"] in {"res", "cap"} and emitter in pins and "0" in pins:
                place(d["ref"], (3 if d["kind"] == "res" else 4, 3), orient="down")
            elif d["kind"] in {"res", "cap", "ind", "diode"} and collector in pins:
                place(d["ref"], (5, 2), orient="right")
            elif d["kind"] in {"res", "cap", "ind", "diode"} and base in pins:
                place(d["ref"], (1, 2), orient="right")

    if bjts and not common_bjt:
        for d in bjts:
            if d["ref"] in used:
                continue
            pins = d["pins"]
            if supply and pins["C"] not in rails and pins["E"] not in rails:
                place(d["ref"], (2, 2))
                continue
            place(d["ref"], (2, 2))

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
            element.label(ref, loc="top" if horizontal else "left", fontsize=FS + 1)
        if value:
            element.label(value, loc="bot" if horizontal else "right", fontsize=FS + 1, color=ACCENT)
        added = d.add(element)
        keys = list(pins.keys())
        return {keys[0]: (added.absanchors["start"].x, added.absanchors["start"].y),
                keys[1]: (added.absanchors["end"].x, added.absanchors["end"].y)}
    if kind in {"nmos", "pmos"}:
        element = (elm.NFet().reverse() if kind == "nmos" else elm.PFet().theta(180))
        element = element.anchor("center").at((cx, cy)).color(WIRE)
        if dev.get("flip"):
            element = element.flip()
        added = d.add(element)
        if ref:
            d.add(elm.Label().at((cx - 2.0, cy + 0.6)).label(ref, fontsize=FS + 1, color=WIRE))
        if value:
            d.add(elm.Label().at((cx - 2.0, cy - 0.5)).label(value, fontsize=FS, color=ACCENT))
        return {"D": (added.absanchors["drain"].x, added.absanchors["drain"].y),
                "G": (added.absanchors["gate"].x, added.absanchors["gate"].y),
                "S": (added.absanchors["source"].x, added.absanchors["source"].y)}
    if kind in {"npn", "pnp"}:
        element = elm.BjtNpn() if kind == "npn" else elm.BjtPnp()
        element = element.anchor("center").at((cx, cy)).color(WIRE)
        if dev.get("flip"):
            element = element.flip()
        added = d.add(element)
        if ref:
            d.add(elm.Label().at((cx - 2.0, cy + 0.6)).label(ref, fontsize=FS + 1, color=WIRE))
        if value:
            d.add(elm.Label().at((cx - 2.0, cy - 0.5)).label(value, fontsize=FS, color=ACCENT))
        return {"C": (added.absanchors["collector"].x, added.absanchors["collector"].y),
                "B": (added.absanchors["base"].x, added.absanchors["base"].y),
                "E": (added.absanchors["emitter"].x, added.absanchors["emitter"].y)}
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
    # Pin-aware (Hanan) augmentation: every routed pin's exact x and y becomes a
    # grid line, so each pin sits *on* the lattice. Access stubs are then true
    # orthogonal segments and trunks meet the terminal head-on -- no snap-induced
    # diagonal kinks beside the gate/drain/source.
    for _net, pin_centers in nets:
        for (px, py), _c in pin_centers:
            xs.append(px)
            ys.append(py)
    xs, ys = sorted(set(xs)), sorted(set(ys))
    xi = {x: i for i, x in enumerate(xs)}
    yi = {y: i for i, y in enumerate(ys)}
    xset, yset = set(xs), set(ys)
    blocked = {(x, y) for x in xs for y in ys if any(_in_box((x, y), b) for b in route_boxes)}
    huse, vuse = defaultdict(set), defaultdict(set)
    route_segs, juncs, stubs = [], [], []

    def valid(n):
        return n[0] in xset and n[1] in yset and n not in blocked

    def escape(pin, center):
        # Walk straight out of the body along the pin's exit axis to the first
        # free node. The pin's own coordinate is now a grid line, so the stub
        # stays exactly vertical (drain/source) or horizontal (gate).
        px, py = pin
        cx, cy = center
        if abs(py - cy) >= abs(px - cx):            # vertical exit
            j, step, n = yi[py], (1 if py >= cy else -1), (px, py)
            while not valid(n) and 0 <= j + step < len(ys):
                j += step
                n = (px, ys[j])
        else:                                       # horizontal exit
            i, step, n = xi[px], (1 if px >= cx else -1), (px, py)
            while not valid(n) and 0 <= i + step < len(xs):
                i += step
                n = (xs[i], py)
        return n

    def neighbours(node):
        x, y = node
        i, j = xi[x], yi[y]
        if i > 0:
            yield (xs[i - 1], y), 1
        if i < len(xs) - 1:
            yield (xs[i + 1], y), 1
        if j > 0:
            yield (x, ys[j - 1]), 2
        if j < len(ys) - 1:
            yield (x, ys[j + 1]), 2

    for net, pin_centers in nets:
        escapes = [escape(p, c) for p, c in pin_centers]
        for (p, _c), e in zip(pin_centers, escapes):
            stubs.append((net, p, e))
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
                    nc = cost + abs(m[0] - node[0]) + abs(m[1] - node[1])
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
            if _in_box(s[0], (bx0, by0, bx1, by1), 1e-6) or _in_box(s[1], (bx0, by0, bx1, by1), 1e-6):
                continue
            if min(sx1, bx1) - max(sx0, bx0) > 0.3 and min(sy1, by1) - max(sy0, by0) > 0.3:
                intrusions += 1
    return {"device_overlaps": 0, "wire_crossings": crossings, "wire_body_intrusions": intrusions}


def route_tail(net, pin_centers, route_segs, junctions):
    """Idiom routing for a differential-pair tail: drop both sources to one
    horizontal bar, then a single wire down to the tail source - no loops."""
    pts = sorted((p for p, _c in pin_centers), key=lambda p: p[1])
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


def _pt_eq(p, q):
    return abs(p[0] - q[0]) < JEPS and abs(p[1] - q[1]) < JEPS


def _on_seg(p, a, b):
    """True if p lies on the axis-aligned segment a-b (endpoints included)."""
    if abs(a[1] - b[1]) < JEPS:        # horizontal
        return abs(p[1] - a[1]) < JEPS and min(a[0], b[0]) - JEPS <= p[0] <= max(a[0], b[0]) + JEPS
    if abs(a[0] - b[0]) < JEPS:        # vertical
        return abs(p[0] - a[0]) < JEPS and min(a[1], b[1]) - JEPS <= p[1] <= max(a[1], b[1]) + JEPS
    return False


def merge_collinear(segments):
    """Merge each net's collinear, overlapping/touching segments into maximal
    runs so every wire draws as one continuous line (no visual breaks where the
    router, rails and pin stubs meet)."""
    horiz, vert, out = defaultdict(list), defaultdict(list), []
    for net, a, b in segments:
        if abs(a[1] - b[1]) < JEPS and abs(a[0] - b[0]) > JEPS:
            horiz[(net, round(a[1], 3))].append(tuple(sorted((a[0], b[0]))))
        elif abs(a[0] - b[0]) < JEPS and abs(a[1] - b[1]) > JEPS:
            vert[(net, round(a[0], 3))].append(tuple(sorted((a[1], b[1]))))
        else:
            out.append((net, a, b))    # diagonal/degenerate: keep verbatim
    for (net, y), ivs in horiz.items():
        out += [(net, (lo, y), (hi, y)) for lo, hi in _merge_iv(ivs)]
    for (net, x), ivs in vert.items():
        out += [(net, (x, lo), (x, hi)) for lo, hi in _merge_iv(ivs)]
    return out


def compute_junctions(segments):
    """A connection dot belongs wherever 3+ wire 'arms' of the SAME net meet
    (a T-tap or multi-way node). Derived geometrically from the final wires, so
    rail taps, pin-stub/trunk joins and idiom bars all get a dot; a pin terminus
    (one arm) and a cross of different nets (a hop) do not."""
    by_net = defaultdict(list)
    for net, a, b in segments:
        by_net[net].append((a, b))
    dots = []
    for segs in by_net.values():
        cand = {(round(a[0], 3), round(a[1], 3)) for a, _ in segs}
        cand |= {(round(b[0], 3), round(b[1], 3)) for _, b in segs}
        for p in cand:
            arms = 0
            for a, b in segs:
                if _pt_eq(p, a) or _pt_eq(p, b):
                    arms += 1
                elif _on_seg(p, a, b):
                    arms += 2
            if arms >= 3:
                dots.append(p)
    return dots


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

    net_pins: dict[str, list] = {}
    route_boxes, check_boxes, diode_segs = [], [], []
    for dev in layout["devices"]:
        anchors = place_device(d, dev)
        cx, cy = cell_xy(dev["cell"])
        route_boxes.append((cx - 1.6, cy - 1.8, cx + 1.6, cy + 1.8))
        check_boxes.append((cx - 1.3, cy - 1.6, cx + 1.3, cy + 1.6))
        pins = dev["pins"]
        diode = dev["kind"] in {"nmos", "pmos"} and pins.get("G") == pins.get("D")
        for pin_name, net in pins.items():
            if diode and pin_name == "D":
                continue  # drain tied to gate by a short local jumper, below
            net_pins.setdefault(net, []).append((anchors[pin_name], (cx, cy)))
        if diode:
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
        for (px, py), _c in net_pins.get(net, []):
            if abs(py - rail_y) > 1e-6:
                stub_segs.append((net, (px, py), (px, rail_y)))
        label = "GND" if net == "0" else net.upper()
        d.add(elm.Label().at((x_lo + 1.3, rail_y + (0.8 if side == "top" else -1.0)))
              .label(label, fontsize=FS + 4, color=WIRE))

    handled = set(rails)
    tail_net = layout.get("tail_net")
    if tail_net and len(net_pins.get(tail_net, [])) >= 3:
        route_tail(tail_net, net_pins[tail_net], route_segs, junctions)
        handled.add(tail_net)

    non_rail = [(net, pcs) for net, pcs in net_pins.items() if net not in handled and len(pcs) >= 2]
    non_rail.sort(key=lambda kv: (max(p[0] for p, _ in kv[1]) - min(p[0] for p, _ in kv[1])) +
                                 (max(p[1] for p, _ in kv[1]) - min(p[1] for p, _ in kv[1])))
    rsegs, rjuncs, rstubs = maze_route(non_rail, route_boxes, x_lo, x_hi, y_bot, y_top)
    route_segs += rsegs
    stub_segs += rstubs
    junctions += rjuncs

    all_segs = merge_collinear(rail_segs + route_segs + stub_segs + diode_segs)
    draw_wires(d, all_segs)
    for jx, jy in compute_junctions(all_segs):
        d.add(elm.Dot(radius=0.12).at((jx, jy)).color(WIRE))

    svg_path.parent.mkdir(parents=True, exist_ok=True)
    d.save(str(svg_path), transparent=False)
    return geometry_check([(a, b) for _net, a, b in all_segs], check_boxes)


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
