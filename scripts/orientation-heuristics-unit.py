#!/usr/bin/env python3
"""Orientation heuristics for R/C/L/D and sources."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "skills" / "circuit-design-ngspice" / "scripts"))

from netlist_to_json import choose_source_orientation, choose_two_terminal_orientation  # noqa: E402


def check(nodes: list[str], comp: dict, expect: str) -> None:
    got = choose_two_terminal_orientation(nodes, comp=comp)
    label = comp.get("name") or comp.get("type")
    status = "OK" if got == expect else f"FAIL want {expect}"
    print(f"{str(label):10} {nodes} -> {got} {status}")
    assert got == expect, (nodes, comp, got, expect)


def main() -> None:
    cases = [
        # Resistors (existing)
        (["n0", "n1"], {"name": "R0", "type": "resistor"}, "h"),
        (["n0", "Vb0"], {"name": "R2_0", "type": "resistor"}, "v"),
        (["n0", "Vb0"], {"name": "Rs0", "type": "resistor"}, "v"),
        (["out", "0"], {"name": "Rload", "type": "resistor"}, "v"),
        (["in", "out"], {"name": "Rfilter", "type": "resistor"}, "h"),
        (["mid", "out"], {"name": "Rser1", "type": "resistor"}, "h"),
        # Capacitors
        (["vdd", "0"], {"name": "Cdec", "type": "capacitor"}, "v"),
        (["out", "0"], {"name": "Cload", "type": "capacitor"}, "v"),
        (["in", "gate"], {"name": "Cin", "type": "capacitor"}, "h"),
        (["drain", "out"], {"name": "Cout", "type": "capacitor"}, "h"),
        (["fb", "out"], {"name": "Ccomp", "type": "capacitor"}, "v"),
        (["fb", "vout"], {"name": "Cx", "type": "capacitor"}, "v"),
        (["n0", "n1"], {"name": "C1", "type": "capacitor"}, "h"),
        # Inductors
        (["rf_in", "match"], {"name": "Lin", "type": "inductor"}, "h"),
        (["a", "b"], {"name": "Lmatch", "type": "inductor"}, "h"),
        (["vdd", "bias"], {"name": "Lchoke", "type": "inductor"}, "v"),
        # Diodes
        (["in", "0"], {"name": "Desd", "type": "diode"}, "v"),
        (["rf_in", "det"], {"name": "Ddet", "type": "diode"}, "h"),
    ]
    for nodes, comp, expect in cases:
        check(nodes, comp, expect)

    assert choose_source_orientation({"name": "Vb0", "nodes": ["Vb0", "0"]}) == "v"
    assert choose_source_orientation({"name": "Vser1", "nodes": ["in", "mid"]}) == "h"
    print("ALL PASS")


if __name__ == "__main__":
    main()
