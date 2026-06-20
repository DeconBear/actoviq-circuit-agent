#!/usr/bin/env python3
"""Generate a grid layout-IR straight from a SPICE netlist via idiom recognition.

This closes the loop the agent needs: instead of hand-authoring a layout, we
parse the netlist the agent already produces, recognise the common analog
idioms (current mirror, differential pair, tail source, pass device, feedback
divider, output loads, reference), and place them with known-good relative
positions. Output is the same layout-IR that grid_render.py consumes.

    python prototype/auto_layout.py --netlist <file|notebook.md> --out layout.json
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


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
    if w and l:
        return f"{w.group(1).rstrip('uU')}/{l.group(1).rstrip('uU')}"
    return ""


def parse(netlist: str):
    models: dict[str, str] = {}
    for name, kind in re.findall(r"(?im)^\s*\.model\s+(\S+)\s+(NMOS|PMOS)", netlist):
        models[name] = "nmos" if kind.upper() == "NMOS" else "pmos"

    devices: list[dict] = []
    for raw in netlist.splitlines():
        s = raw.strip()
        if not s or s.startswith("*") or s.startswith("."):
            continue
        tok = s.split()
        ref, c = tok[0], tok[0][0].upper()
        if c == "M" and len(tok) >= 6:
            kind = models.get(tok[5], "nmos")
            devices.append({"ref": ref, "kind": kind, "value": short_wl(" ".join(tok[6:])),
                            "pins": {"D": tok[1], "G": tok[2], "S": tok[3], "B": tok[4]}})
        elif c == "R" and len(tok) >= 4:
            devices.append({"ref": ref, "kind": "res", "value": tok[3],
                            "pins": {"1": tok[1], "2": tok[2]}})
        elif c == "C" and len(tok) >= 4:
            devices.append({"ref": ref, "kind": "cap", "value": tok[3],
                            "pins": {"1": tok[1], "2": tok[2]}})
        elif c == "V" and len(tok) >= 3:
            devices.append({"ref": ref, "kind": "vsrc", "value": " ".join(tok[3:]),
                            "pins": {"p": tok[1], "n": tok[2]}})
        elif c == "I" and len(tok) >= 3:
            devices.append({"ref": ref, "kind": "isrc", "value": " ".join(tok[3:]),
                            "pins": {"p": tok[1], "n": tok[2]}})
    return devices


def fet_terms(d):  # (drain, gate, source)
    return d["pins"]["D"], d["pins"]["G"], d["pins"]["S"]


def auto_layout(devices: list[dict]) -> dict:
    by_ref = {d["ref"]: d for d in devices}
    fets = [d for d in devices if d["kind"] in {"nmos", "pmos"}]
    twos = [d for d in devices if d["kind"] in {"res", "cap"}]

    # --- rails: ground is "0"; supply = source-net feeding the most FETs ---
    src_fanout: dict[str, int] = {}
    for d in fets:
        src_fanout[d["pins"]["S"]] = src_fanout.get(d["pins"]["S"], 0) + 1
    supply = max(src_fanout, key=src_fanout.get) if src_fanout else None
    rails = {"0": "bottom"}
    if supply and supply != "0":
        rails[supply] = "top"

    # --- output: non-rail net carrying the most R/C loads ---
    load_fanout: dict[str, int] = {}
    for d in twos:
        for net in (d["pins"]["1"], d["pins"]["2"]):
            if net not in rails:
                load_fanout[net] = load_fanout.get(net, 0) + 1
    output = max(load_fanout, key=load_fanout.get) if load_fanout else None

    placed: dict[str, dict] = {}
    used_refs: set[str] = set()

    # Supply/ground-defining sources are represented by the rails themselves, the
    # way engineers draw them (a labelled rail, not an inline battery symbol).
    for d in devices:
        if d["kind"] == "vsrc" and supply in d["pins"].values() and "0" in d["pins"].values():
            used_refs.add(d["ref"])

    def place(ref, cell, *, orient=None, flip=False):
        d = dict(by_ref[ref])
        d["cell"] = list(cell)
        if orient:
            d["orient"] = orient
        if flip:
            d["flip"] = True
        d["pins"] = {k: v for k, v in d["pins"].items() if k != "B"}  # bulk -> rail, undrawn
        placed[ref] = d
        used_refs.add(ref)

    # --- current mirror: same-type FETs sharing a gate net, one diode (g==d) ---
    mirror = None
    for kind in ("pmos", "nmos"):
        groups: dict[str, list] = {}
        for d in (f for f in fets if f["kind"] == kind):
            groups.setdefault(d["pins"]["G"], []).append(d)
        for gate_net, grp in groups.items():
            diode = [d for d in grp if d["pins"]["D"] == d["pins"]["G"]]
            if len(grp) >= 2 and diode:
                mirror = {"gate": gate_net, "ref": diode[0], "out": [d for d in grp if d is not diode[0]]}
                break
        if mirror:
            break

    # --- diff pair: same-type FETs sharing a (non-rail) source net ---
    diff = None
    for kind in ("nmos", "pmos"):
        groups = {}
        for d in (f for f in fets if f["kind"] == kind and f["ref"] not in used_refs):
            if d["pins"]["S"] not in rails:
                groups.setdefault(d["pins"]["S"], []).append(d)
        for tail_net, grp in groups.items():
            if len(grp) == 2:
                diff = {"tail": tail_net, "devs": grp}
                break
        if diff:
            break

    # Place diff pair: the device whose gate is the feedback tap goes left,
    # aligned under the mirror device that shares its drain.
    if diff:
        d0, d1 = diff["devs"]
        # left = the one whose gate is NOT a source/reference (i.e. the feedback input)
        ref_gate = None
        for v in devices:
            if v["kind"] == "vsrc" and v["pins"]["p"] in (d0["pins"]["G"], d1["pins"]["G"]):
                ref_gate = v["pins"]["p"]
        if ref_gate and d0["pins"]["G"] == ref_gate:
            d0, d1 = d1, d0  # ensure d1 holds the reference gate (right side)
        place(d0["ref"], (1, 2))
        place(d1["ref"], (2, 2), flip=True)
        if mirror:
            mref, mout = mirror["ref"], mirror["out"][0]
            # diode mirror device above whichever diff device shares its drain net
            above_left = mref if mref["pins"]["D"] == d0["pins"]["D"] else mout
            above_right = mout if above_left is mref else mref
            place(above_left["ref"], (1, 1))
            place(above_right["ref"], (2, 1), flip=True)
        # tail source: 2-term/FET bridging tail net to ground
        for d in devices:
            nets = set(d["pins"].values())
            if d["ref"] not in used_refs and diff["tail"] in nets and "0" in nets:
                place(d["ref"], (1, 3), orient="down")
        # reference source feeding the right gate
        for d in devices:
            if d["kind"] == "vsrc" and d["ref"] not in used_refs and d["pins"]["p"] == d1["pins"]["G"]:
                place(d["ref"], (0, 2), orient="down")

    # --- pass device: FET (not yet placed) whose drain is the output ---
    if output:
        for d in fets:
            if d["ref"] not in used_refs and d["pins"]["D"] == output:
                place(d["ref"], (4, 1))

    # --- output loads + feedback divider on the right ---
    load_col = 4
    div_done = False
    for d in twos:
        if d["ref"] in used_refs:
            continue
        nets = {d["pins"]["1"], d["pins"]["2"]}
        if output in nets and "0" in nets:                      # load to ground
            place(d["ref"], (load_col, 3), orient="down")
            load_col += 1
        elif output in nets and not div_done:                   # divider top (vout->fb)
            place(d["ref"], (6, 2), orient="down")
            tap = (nets - {output}).pop()
            for d2 in twos:                                      # divider bottom (fb->0)
                if d2["ref"] not in used_refs and tap in {d2["pins"]["1"], d2["pins"]["2"]} \
                        and "0" in {d2["pins"]["1"], d2["pins"]["2"]}:
                    place(d2["ref"], (6, 3), orient="down")
            div_done = True

    # --- anything unrecognised: drop into a spare row so it still renders ---
    spare = 0
    for d in devices:
        if d["ref"] not in used_refs:
            place(d["ref"], (spare, 4), orient="down")
            spare += 1

    return {"title": "auto layout", "rails": rails,
            "tail_net": diff["tail"] if diff else None,
            "devices": [placed[d["ref"]] for d in devices if d["ref"] in placed]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--netlist", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    devices = parse(read_netlist(Path(args.netlist)))
    layout = auto_layout(devices)
    Path(args.out).write_text(json.dumps(layout, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "out": args.out, "devices": len(layout["devices"]),
                      "rails": layout["rails"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
