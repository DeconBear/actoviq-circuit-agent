#!/usr/bin/env python3
"""Regression for infer_editable_ports Vin vs IN interface rules."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "skills" / "circuit-design-ngspice" / "scripts"))

from circuit_project import (  # noqa: E402
    infer_editable_ports,
    port_alias_remap,
    rewrite_module_port_connections,
)


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

    # Netlist sync owns the interface list: a stale explicit port must disappear
    # when its net no longer exists.
    stale_explicit = [
        {
            "id": "old_out",
            "name": "OUT",
            "direction": "output",
            "signal_type": "analog",
            "net": "removed_net",
        }
    ]
    ports = infer_editable_ports(stale_explicit, signal_in)
    assert not any(port["id"] == "old_out" for port in ports), ports

    # Named cross-module interfaces remain stable even when the local notebook
    # does not consume them yet; project connections may still reference them.
    explicit_supply = [
        {
            "id": "vdd",
            "name": "VDD",
            "direction": "input",
            "signal_type": "power",
            "net": "vdd",
        }
    ]
    ports = infer_editable_ports(explicit_supply, signal_in)
    assert any(port["id"] == "vdd" for port in ports), ports

    # The net is the electrical identity. Prefer the explicit module interface
    # over an older inferred alias so VIN/OUT cannot render twice or with the
    # inferred rail direction.
    duplicate_interfaces = [
        {
            "id": "vin",
            "name": "VIN",
            "direction": "input",
            "signal_type": "power",
            "net": "vin",
            "inferred": True,
        },
        {
            "id": "output",
            "name": "OUT",
            "direction": "output",
            "signal_type": "analog",
            "net": "vout",
            "inferred": True,
        },
        {
            "id": "VIN",
            "name": "VIN",
            "direction": "input",
            "signal_type": "analog",
            "net": "VIN",
        },
        {
            "id": "VOUT",
            "name": "VOUT",
            "direction": "output",
            "signal_type": "analog",
            "net": "VOUT",
        },
    ]
    duplicate_net_components = [
        {
            "id": "r1",
            "type": "R",
            "name": "R1",
            "value": "1k",
            "pins": [{"id": "a", "net": "VIN"}, {"id": "b", "net": "VOUT"}],
        },
        {
            "id": "rload",
            "type": "R",
            "name": "Rload",
            "value": "10",
            "pins": [{"id": "a", "net": "VOUT"}, {"id": "b", "net": "0"}],
        },
    ]
    ports = infer_editable_ports(duplicate_interfaces, duplicate_net_components)
    vin_ports = [port for port in ports if port["net"].casefold() == "vin"]
    vout_ports = [port for port in ports if port["net"].casefold() == "vout"]
    assert [(port["id"], port["signal_type"]) for port in vin_ports] == [("VIN", "analog")], ports
    assert [(port["id"], port["name"]) for port in vout_ports] == [("VOUT", "VOUT")], ports

    # Named explicit interfaces beat generic IN/OUT even when the generic port
    # appears first in the module port list.
    generic_first = [
        {
            "id": "output",
            "name": "OUT",
            "direction": "output",
            "signal_type": "analog",
            "net": "vout",
        },
        {
            "id": "VOUT",
            "name": "VOUT",
            "direction": "output",
            "signal_type": "analog",
            "net": "vout",
        },
        {
            "id": "input",
            "name": "IN",
            "direction": "input",
            "signal_type": "analog",
            "net": "vin",
        },
        {
            "id": "VIN",
            "name": "VIN",
            "direction": "input",
            "signal_type": "analog",
            "net": "vin",
        },
    ]
    ports = infer_editable_ports(generic_first, duplicate_net_components)
    assert [(port["id"], port["name"]) for port in ports if port["net"].casefold() == "vin"] == [("VIN", "VIN")], ports
    assert [(port["id"], port["name"]) for port in ports if port["net"].casefold() == "vout"] == [("VOUT", "VOUT")], ports

    previous = generic_first
    next_ports = infer_editable_ports(previous, duplicate_net_components)
    assert port_alias_remap(previous, next_ports) == {
        "output": "VOUT",
        "input": "VIN",
    }
    project = {
        "connections": [
            {
                "id": "c1",
                "from": {"module_id": "src", "port_id": "out"},
                "to": {"module_id": "dut", "port_id": "input"},
            },
            {
                "id": "c2",
                "from": {"module_id": "dut", "port_id": "output"},
                "to": {"module_id": "load", "port_id": "in"},
            },
            {
                "id": "c3",
                "from": {"module_id": "bias", "port_id": "vdd"},
                "to": {"module_id": "dut", "port_id": "vdd"},
            },
        ]
    }
    rewrite_module_port_connections(project, "dut", previous, next_ports)
    assert project["connections"] == [
        {
            "id": "c1",
            "from": {"module_id": "src", "port_id": "out"},
            "to": {"module_id": "dut", "port_id": "VIN"},
        },
        {
            "id": "c2",
            "from": {"module_id": "dut", "port_id": "VOUT"},
            "to": {"module_id": "load", "port_id": "in"},
        },
    ], project["connections"]
    print("infer-editable-ports-unit: ok")


if __name__ == "__main__":
    main()
