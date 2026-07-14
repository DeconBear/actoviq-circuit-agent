#!/usr/bin/env python3
"""Regression coverage for deterministic EDA IR and multi-target exports."""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
SKILL_SCRIPTS = REPO / "skills" / "circuit-design-ngspice" / "scripts"
sys.path.insert(0, str(SKILL_SCRIPTS))

from eda_export import (  # noqa: E402
    PATCH_SCHEMA,
    SYMBOL_MAP_SCHEMA,
    build_eda_ir,
    connectivity_hash,
    export_eda,
    validate_layout_patch,
)


def port(port_id: str, direction: str, signal_type: str, net: str) -> dict:
    return {"id": port_id, "name": port_id.upper(), "direction": direction, "signal_type": signal_type, "net": net}


def pin(pin_id: str, net: str, side: str | None = None) -> dict:
    value = {"id": pin_id, "name": pin_id.upper(), "net": net}
    if side:
        value["side"] = side
    return value


def component(component_id: str, kind: str, value: str, x: int, y: int, pins: list[dict], rotation: int = 0, **extra: object) -> dict:
    return {"id": component_id, "type": kind, "name": component_id.upper(), "value": value, "position": {"x": x, "y": y}, "rotation": rotation, "pins": pins, **extra}


def ldo_module() -> dict:
    return {
        "schema": "actoviq.module.v2",
        "module_id": "pmos_ldo",
        "name": "PMOS LDO Bench",
        "revision": 4,
        "ports": [
            port("in", "input", "power", "vin"),
            port("out", "output", "analog", "out"),
            port("gate", "input", "analog", "gate"),
        ],
        "components": [
            component("mpass", "M", "PMOSPASS", 360, 240, [pin("d", "out"), pin("g", "gate"), pin("s", "vin"), pin("b", "vin")]),
            component("rpu", "R", "47k", 180, 120, [pin("a", "vin"), pin("b", "gate")], 90),
            component("rload", "R", "10k", 620, 300, [pin("a", "out"), pin("b", "0")], 90),
        ],
        "nets": [
            {"id": "net_vin", "name": "vin", "kind": "power"},
            {"id": "net_out", "name": "out", "kind": "analog"},
            {"id": "net_gate", "name": "gate", "kind": "analog"},
            {"id": "net_0", "name": "0", "kind": "ground"},
        ],
        "wires": [],
        "annotations": [],
    }


def auxiliary_module() -> dict:
    return {
        "schema": "actoviq.module.v2",
        "module_id": "control",
        "name": "Control and testbench",
        "revision": 2,
        "ports": [port("sense", "input", "analog", "sense"), port("drive", "output", "analog", "drive")],
        "components": [
            component("controller", "BLOCK", "ERROR_AMP", 260, 200, [pin("sense", "sense", "left"), pin("ref", "vref", "left"), pin("drive", "drive", "right")], block={"width": 160, "height": 100}),
            component("vref", "V", "DC 1.2", 80, 340, [pin("p", "vref"), pin("n", "0")], mount_policy="testbench_exclude"),
        ],
        "nets": [
            {"id": "net_sense", "name": "sense"}, {"id": "net_drive", "name": "drive"},
            {"id": "net_vref", "name": "vref"}, {"id": "net_0", "name": "0", "kind": "ground"},
        ],
        "wires": [],
        "annotations": [],
    }


def project_fixture() -> tuple[dict, dict[str, dict]]:
    modules = {"pmos_ldo": ldo_module(), "control": auxiliary_module()}
    project = {
        "schema": "actoviq.project.v2",
        "project_id": "eda-regression",
        "name": "EDA Export Regression",
        "revision": 7,
        "modules": [
            {"id": "pmos_ldo", "name": "PMOS LDO Bench", "kind": "ldo", "source": "modules/pmos_ldo/module.circuit.json", "position": {"x": 0, "y": 0}, "size": {"width": 800, "height": 600}, "ports": modules["pmos_ldo"]["ports"]},
            {"id": "control", "name": "Control", "kind": "control", "source": "modules/control/module.circuit.json", "position": {"x": 900, "y": 0}, "size": {"width": 500, "height": 400}, "ports": modules["control"]["ports"]},
        ],
        "connections": [
            {"id": "feedback", "from": {"module_id": "pmos_ldo", "port_id": "out"}, "to": {"module_id": "control", "port_id": "sense"}, "network": "VOUT"},
            {"id": "drive", "from": {"module_id": "control", "port_id": "drive"}, "to": {"module_id": "pmos_ldo", "port_id": "gate"}, "network": "GATE"},
        ],
    }
    return project, modules


def balanced(text: str) -> bool:
    depth = 0
    quoted = False
    escaped = False
    for character in text:
        if escaped:
            escaped = False
        elif character == "\\" and quoted:
            escaped = True
        elif character == '"':
            quoted = not quoted
        elif not quoted and character == "(":
            depth += 1
        elif not quoted and character == ")":
            depth -= 1
            if depth < 0:
                return False
    return depth == 0 and not quoted


def main() -> int:
    output = REPO / "output" / "eda-export-regression"
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    project, modules = project_fixture()
    document_hash = "a" * 64
    expected_hash = connectivity_hash(project, modules, view="design")
    ir, quality = build_eda_ir(project, modules, scope="project", module_id=None, view="design", document_hash=document_hash)
    assert ir["schema"] == "actoviq.eda-ir.v1"
    assert ir["connectivity"]["hash"] == expected_hash
    ldo = next(page for page in ir["pages"] if page["id"] == "pmos_ldo")
    rpu = next(entry for entry in ldo["components"] if entry["id"] == "rpu")
    rpu_records = [record for record in ir["connectivity"]["records"] if record.get("component_id") == "rpu"]
    assert len(rpu["pins"]) == 2 and {record["pin_id"] for record in rpu_records} == {"a", "b"}
    assert all(next(port_value for port_value in ldo["ports"] if port_value["id"] == port_id)["position"] for port_id in ("in", "out"))
    ldo_quality = next(report for report in quality["modules"] if report["module_id"] == "pmos_ldo")
    assert ldo_quality["metrics"]["component_overlaps"] == 0
    assert ldo_quality["metrics"]["wire_through_components"] == 0
    assert ldo_quality["metrics"]["wire_crossings"] == 0
    assert ldo_quality["readability_score"] >= 90
    control = next(page for page in ir["pages"] if page["id"] == "control")
    assert {entry["id"] for entry in control["components"]} == {"controller"}, "design view must exclude testbench components"

    result = export_eda(
        output, project, modules,
        {"blocking": False, "summary": {"errors": 0}}, document_hash,
        scope="project", module_id=None, targets=["kicad", "altium", "orcad", "virtuoso"],
        view="design", mapping_file="", native_convert="never", strict_layout=False, source_revision=7,
    )
    export_root = Path(result["export_root"])
    manifest = json.loads((export_root / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["source"]["connectivity_hash"] == expected_hash
    for target in ("kicad", "altium", "orcad", "virtuoso"):
        target_connectivity = json.loads((export_root / target / "connectivity.json").read_text(encoding="utf-8"))
        assert target_connectivity["hash"] == expected_hash
        assert manifest["targets"][target]["connectivity_hash"] == expected_hash
    assert all(balanced(path.read_text(encoding="utf-8")) for path in (export_root / "kicad").glob("*.kicad_sch"))
    assert balanced(next((export_root / "orcad").glob("*.edf")).read_text(encoding="utf-8"))
    assert all((export_root / relative_path).is_file() for relative_path in manifest["files"])

    validate_layout_patch({"schema": PATCH_SCHEMA, "operations": [
        {"op": "move_component", "component_id": "rpu", "dx_grid": 1, "dy_grid": -2},
        {"op": "rotate_component", "component_id": "rpu", "rotation": 90},
        {"op": "move_port", "port_id": "in", "dx_grid": -1, "dy_grid": 0},
    ]}, {"rpu"}, {"in"})
    try:
        validate_layout_patch({"schema": PATCH_SCHEMA, "operations": [{"op": "delete_component", "component_id": "rpu"}]}, {"rpu"}, {"in"})
        raise AssertionError("electrical layout patch mutation was accepted")
    except ValueError:
        pass

    bad_mapping = output / "bad-symbol-map.json"
    bad_mapping.write_text(json.dumps({"schema": SYMBOL_MAP_SCHEMA, "targets": {"kicad": {"components": {"rpu": {"pin_map": {"a": "1"}}}}}}), encoding="utf-8")
    try:
        export_eda(output, project, modules, {"blocking": False, "summary": {"errors": 0}}, document_hash, scope="module", module_id="pmos_ldo", targets=["kicad"], view="design", mapping_file=str(bad_mapping), native_convert="never", strict_layout=False, source_revision=7)
        raise AssertionError("incomplete pin mapping was accepted")
    except ValueError as error:
        assert "pin map" in str(error)
    for revision, erc, message in ((6, {"blocking": False}, "stale source revision"), (7, {"blocking": True, "summary": {"errors": 1}}, "blocking ERC")):
        try:
            export_eda(output, project, modules, erc, document_hash, scope="project", module_id=None, targets=["kicad"], view="design", mapping_file="", native_convert="never", strict_layout=False, source_revision=revision)
            raise AssertionError(f"{message} was accepted")
        except ValueError as error:
            assert message.split()[0] in str(error)
    print(json.dumps({"ok": True, "export_root": str(export_root), "connectivity_hash": expected_hash, "ldo_readability": ldo_quality["readability_score"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
