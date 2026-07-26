#!/usr/bin/env python3
"""Regression for infer_editable_ports Vin vs IN interface rules."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "skills" / "circuit-design-ngspice" / "scripts"))

from circuit_project import infer_editable_ports  # noqa: E402


def main() -> None:
    buck_with_vin = [
        {
            "id": "vin",
            "type": "V",
            "name": "Vin",
            "value": "DC 12",
            "pins": [
                {"id": "p", "name": "+", "net": "vin"},
                {"id": "n", "name": "-", "net": "0"},
            ],
        },
        {
            "id": "m1",
            "type": "M",
            "name": "M1",
            "value": "NMOS",
            "pins": [
                {"id": "d", "net": "sw"},
                {"id": "g", "net": "pwm"},
                {"id": "s", "net": "0"},
                {"id": "b", "net": "0"},
            ],
        },
        {
            "id": "rload",
            "type": "R",
            "name": "R1",
            "value": "10",
            "pins": [{"id": "a", "net": "vout"}, {"id": "b", "net": "0"}],
        },
    ]
    ports = infer_editable_ports([], buck_with_vin)
    assert not any(port["name"] == "IN" or port["id"] == "input" for port in ports), ports
    assert not any(port["net"] == "vin" for port in ports), ports
    assert any(port["name"] == "OUT" for port in ports), ports

    external_vin = [
        {
            "id": "m1",
            "type": "M",
            "name": "M1",
            "value": "NMOS",
            "pins": [
                {"id": "d", "net": "sw"},
                {"id": "g", "net": "pwm"},
                {"id": "s", "net": "0"},
                {"id": "b", "net": "0"},
            ],
        },
        {
            "id": "r1",
            "type": "R",
            "name": "R1",
            "value": "1k",
            "pins": [{"id": "a", "net": "vin"}, {"id": "b", "net": "sw"}],
        },
    ]
    ports = infer_editable_ports([], external_vin)
    assert any(port["id"] == "vin" and port["signal_type"] == "power" for port in ports), ports
    assert not any(port["name"] == "IN" for port in ports), ports

    signal_in = [
        {
            "id": "r1",
            "type": "R",
            "name": "R1",
            "value": "1k",
            "pins": [{"id": "a", "net": "in"}, {"id": "b", "net": "out"}],
        },
        {
            "id": "c1",
            "type": "C",
            "name": "C1",
            "value": "1n",
            "pins": [{"id": "a", "net": "out"}, {"id": "b", "net": "0"}],
        },
    ]
    ports = infer_editable_ports([], signal_in)
    assert any(port["name"] == "IN" and port["signal_type"] == "analog" for port in ports), ports

    stale = [
        {
            "id": "input",
            "name": "IN",
            "direction": "input",
            "signal_type": "analog",
            "net": "vin",
            "inferred": True,
        }
    ]
    ports = infer_editable_ports(stale, buck_with_vin)
    assert not any(port["id"] == "input" for port in ports), ports
    print("infer-editable-ports-unit: ok")


if __name__ == "__main__":
    main()
