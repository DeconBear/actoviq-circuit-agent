#!/usr/bin/env python3
"""Regression for hierarchical MODULE helpers and compile path."""

from __future__ import annotations

import json
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL_SCRIPTS = ROOT / "skills" / "circuit-design-ngspice" / "scripts"
sys.path.insert(0, str(SKILL_SCRIPTS))

from circuit_project import atomic_write_json, compile_project, evaluate_erc  # noqa: E402
from module_hierarchy import (  # noqa: E402
    compare_ordered_pin_nets,
    detect_module_cycles,
    make_module_instance,
    ordered_connectivity_hash,
    ports_to_symbol_geometry,
    safe_format_interpolate,
    sync_instance_pins_from_ports,
)


def test_symbol_geometry() -> None:
    ports = [
        {"id": "vin", "name": "VIN", "direction": "input", "signal_type": "analog", "net": "vin"},
        {"id": "vout", "name": "VOUT", "direction": "output", "signal_type": "analog", "net": "vout"},
        {"id": "vdd", "name": "VDD", "direction": "input", "signal_type": "power", "net": "vdd"},
        {"id": "gnd", "name": "GND", "direction": "input", "signal_type": "ground", "net": "0"},
    ]
    geometry = ports_to_symbol_geometry(ports)
    sides = {pin["id"]: pin["side"] for pin in geometry["pins"]}
    assert sides["vin"] == "left"
    assert sides["vout"] == "right"
    assert sides["vdd"] == "top"
    assert sides["gnd"] == "bottom"
    assert geometry["block"]["width"] >= 80
    assert geometry["block"]["height"] >= 80


def test_pin_sync_preserves_nets() -> None:
    child_ports = [
        {"id": "a", "name": "A", "direction": "input", "signal_type": "analog", "net": "a"},
        {"id": "b", "name": "B", "direction": "output", "signal_type": "analog", "net": "b"},
    ]
    instance = make_module_instance(
        component_id="u1",
        name="Xbias",
        child_module_id="bias",
        child_ports=child_ports,
        position={"x": 10, "y": 20},
        parameters={"w": "2u"},
    )
    instance["pins"][0]["net"] = "wired_a"
    instance["pins"][0]["net_id"] = "n-a"
    next_ports = child_ports + [
        {"id": "c", "name": "C", "direction": "input", "signal_type": "analog", "net": "c"},
    ]
    synced = sync_instance_pins_from_ports(instance, next_ports)
    by_id = {pin["id"]: pin for pin in synced["pins"]}
    assert by_id["a"]["net"] == "wired_a"
    assert by_id["a"]["net_id"] == "n-a"
    assert "c" in by_id


def test_cycle_detection() -> None:
    modules = {
        "top": {
            "module_id": "top",
            "components": [
                make_module_instance(
                    component_id="u1",
                    name="Xmid",
                    child_module_id="mid",
                    child_ports=[{"id": "p", "name": "P", "direction": "input", "signal_type": "analog", "net": "p"}],
                    position={"x": 0, "y": 0},
                )
            ],
        },
        "mid": {
            "module_id": "mid",
            "components": [
                make_module_instance(
                    component_id="u2",
                    name="Xtop",
                    child_module_id="top",
                    child_ports=[{"id": "p", "name": "P", "direction": "input", "signal_type": "analog", "net": "p"}],
                    position={"x": 0, "y": 0},
                )
            ],
        },
    }
    cycle = detect_module_cycles(modules, start_module_id="top")
    assert cycle, "expected a hierarchy cycle"


def test_hierarchy_erc() -> None:
    child = {
        "module_id": "child",
        "revision": 3,
        "ports": [{"id": "in", "name": "IN", "net": "child_in"}],
        "components": [],
        "wires": [],
    }
    parent = {
        "module_id": "parent",
        "revision": 1,
        "ports": [],
        "components": [{
            "id": "xchild",
            "type": "MODULE",
            "name": "XCHILD",
            "value": "child",
            "module_ref": {"module_id": "child", "revision": 1},
            "pins": [{"id": "old", "name": "OLD", "net": "legacy"}],
        }],
        "wires": [],
    }
    project = {
        "revision": 1,
        "modules": [{"id": "parent", "ports": []}, {"id": "child", "ports": child["ports"]}],
        "connections": [],
    }
    diagnostics = evaluate_erc(
        project,
        {"parent": parent, "child": child},
    )["diagnostics"]
    codes = {item["code"] for item in diagnostics}
    assert "module_revision_mismatch" in codes
    assert "module_port_missing" in codes
    assert "module_pin_extra" in codes


def test_format_and_hash() -> None:
    line = safe_format_interpolate(
        "{name} {D} {G} {S} {B} {model} w={w} l={l}",
        {"name": "M1", "D": "out", "G": "in", "S": "0", "B": "0", "model": "nmos", "w": "1u", "l": "0.13u"},
    )
    assert line == "M1 out in 0 0 nmos w=1u l=0.13u"
    try:
        safe_format_interpolate("{name}; rm -rf /", {"name": "M1"})
        raise AssertionError("unsafe template should fail")
    except ValueError:
        pass

    from circuit_project import emit_leaf_component_line

    catalog = {
        "devices": [{
            "device_id": "M",
            "spice": {
                "primitive": "M",
                "model": "sg13_lv_nmos",
                "pin_order": ["D", "G", "S", "B"],
                "format": "{name} {D} {G} {S} {B} {model} w={w} l={l}",
            },
        }]
    }
    mos = {
        "type": "M",
        "name": "M1",
        "value": "nmos W=2u L=0.13u",
        "pins": [
            {"id": "G", "name": "G", "net": "in"},
            {"id": "D", "name": "D", "net": "out"},
            {"id": "S", "name": "S", "net": "0"},
            {"id": "B", "name": "B", "net": "0"},
        ],
    }
    emitted = emit_leaf_component_line(mos, device_catalog=catalog)
    assert emitted == "M1 out in 0 0 sg13_lv_nmos w=2u l=0.13u"

    nmos_catalog = {
        "devices": [{
            "device_id": "nmos",
            "spice": {
                "primitive": "M",
                "model": "sg13_lv_nmos",
                "pin_order": ["D", "G", "S", "B"],
                "format": "{name} {D} {G} {S} {B} {model} w={w} l={l}",
            },
        }]
    }
    mos_by_device_id = {
        **mos,
        "value": "NMOS W=3u L=0.15u",
        "parameters": {"device_id": "nmos", "model": "sg13_lv_nmos", "w": "3u", "l": "0.15u"},
    }
    emitted_by_id = emit_leaf_component_line(mos_by_device_id, device_catalog=nmos_catalog)
    assert emitted_by_id == "M1 out in 0 0 sg13_lv_nmos w=3u l=0.15u"

    module_a = {
        "module_id": "core",
        "ports": [{"id": "in", "net": "in", "net_id": "n-in"}],
        "components": [{
            "id": "m1",
            "stable_id": "component-m1",
            "pins": [
                {"id": "G", "net": "in", "net_id": "n-in"},
                {"id": "D", "net": "out", "net_id": "n-out"},
            ],
        }],
    }
    module_b = json.loads(json.dumps(module_a))
    module_b["components"][0]["pins"][0]["net"] = "out"
    module_b["components"][0]["pins"][0]["net_id"] = "n-out"
    module_b["components"][0]["pins"][1]["net"] = "in"
    module_b["components"][0]["pins"][1]["net_id"] = "n-in"
    assert ordered_connectivity_hash(module_a) != ordered_connectivity_hash(module_b)

    comparison = compare_ordered_pin_nets(
        {"M1": ["in", "out"]},
        {"m1": ["out", "in"]},
    )
    assert comparison["ok"] is False


def _write_module(root: Path, module: dict) -> None:
    module_dir = root / "modules" / module["module_id"]
    module_dir.mkdir(parents=True, exist_ok=True)
    atomic_write_json(module_dir / "module.circuit.json", module)


def test_hierarchical_compile() -> None:
    with tempfile.TemporaryDirectory(prefix="actoviq-hier-") as temporary:
        root = Path(temporary)
        bias_ports = [
            {"id": "out", "name": "OUT", "direction": "output", "signal_type": "analog", "net": "nbias"},
            {"id": "vdd", "name": "VDD", "direction": "input", "signal_type": "power", "net": "vdd"},
            {"id": "gnd", "name": "GND", "direction": "input", "signal_type": "ground", "net": "0"},
        ]
        bias = {
            "schema": "actoviq.module.v2",
            "module_id": "bias",
            "name": "Bias",
            "revision": 1,
            "parameter_defs": [{"id": "rload", "default": "10k"}],
            "ports": bias_ports,
            "components": [{
                "id": "r1",
                "type": "R",
                "name": "R1",
                "value": "10k",
                "position": {"x": 0, "y": 0},
                "rotation": 0,
                "pins": [
                    {"id": "1", "name": "1", "net": "vdd"},
                    {"id": "2", "name": "2", "net": "nbias"},
                ],
            }],
            "wires": [],
            "annotations": [],
        }
        core_ports = [
            {"id": "vin", "name": "VIN", "direction": "input", "signal_type": "analog", "net": "vin"},
            {"id": "vout", "name": "VOUT", "direction": "output", "signal_type": "analog", "net": "vout"},
            {"id": "vdd", "name": "VDD", "direction": "input", "signal_type": "power", "net": "vdd"},
            {"id": "gnd", "name": "GND", "direction": "input", "signal_type": "ground", "net": "0"},
        ]
        instance = make_module_instance(
            component_id="xb1",
            name="Xbias",
            child_module_id="bias",
            child_ports=bias_ports,
            position={"x": 100, "y": 100},
            parameters={"rload": "20k"},
        )
        for pin in instance["pins"]:
            if pin["id"] == "out":
                pin["net"] = "nbias"
            elif pin["id"] == "vdd":
                pin["net"] = "vdd"
            elif pin["id"] == "gnd":
                pin["net"] = "0"
        core = {
            "schema": "actoviq.module.v2",
            "module_id": "core",
            "name": "Core",
            "revision": 1,
            "ports": core_ports,
            "components": [
                instance,
                {
                    "id": "r2",
                    "type": "R",
                    "name": "R2",
                    "value": "1k",
                    "position": {"x": 200, "y": 100},
                    "rotation": 0,
                    "pins": [
                        {"id": "1", "name": "1", "net": "vin"},
                        {"id": "2", "name": "2", "net": "vout"},
                    ],
                },
            ],
            "wires": [],
            "annotations": [],
        }
        project = {
            "schema": "actoviq.project.v2",
            "project_id": "hier-demo",
            "name": "Hier Demo",
            "revision": 1,
            "created_at": "2026-07-27T00:00:00Z",
            "updated_at": "2026-07-27T00:00:00Z",
            "composition": {"mode": "hierarchical", "top_module_id": "core"},
            "modules": [
                {
                    "id": "bias",
                    "name": "Bias",
                    "kind": "bias",
                    "source": "modules/bias/module.circuit.json",
                    "position": {"x": 0, "y": 0},
                    "size": {"width": 240, "height": 160},
                    "ports": bias_ports,
                },
                {
                    "id": "core",
                    "name": "Core",
                    "kind": "core",
                    "source": "modules/core/module.circuit.json",
                    "position": {"x": 300, "y": 0},
                    "size": {"width": 240, "height": 160},
                    "ports": core_ports,
                },
            ],
            "connections": [],
        }
        atomic_write_json(root / "project.circuit.json", project)
        _write_module(root, bias)
        _write_module(root, core)
        result = compile_project(root)
        assert result["ok"] is True
        netlist = (root / "build" / "system" / "design.final.cir").read_text(encoding="utf-8")
        assert ".subckt bias" in netlist
        assert ".subckt core" in netlist
        assert "Xbias" in netlist
        assert "rload=20k" in netlist
        # Xyce rejects formal .SUBCKT pins named bare "0"; ground must be a named pin.
        assert re.search(r"(?im)^\.subckt\s+\S+.*\s0(\s|$)", netlist) is None
        assert ".subckt bias out vdd gnd" in netlist or ".subckt bias" in netlist and " gnd" in netlist
        assert (root / "build" / "modules" / "core" / "design.hier.cir").is_file()
        assert (root / "build" / "modules" / "core" / "connectivity.json").is_file()


def main() -> int:
    test_symbol_geometry()
    test_pin_sync_preserves_nets()
    test_cycle_detection()
    test_hierarchy_erc()
    test_format_and_hash()
    test_hierarchical_compile()
    print(json.dumps({"ok": True, "suite": "module-hierarchy-regression"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
