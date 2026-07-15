#!/usr/bin/env python3
"""Regression coverage for deterministic EDA IR and multi-target exports."""

from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
SKILL_SCRIPTS = REPO / "skills" / "circuit-design-ngspice" / "scripts"
sys.path.insert(0, str(SKILL_SCRIPTS))

from eda_export import (  # noqa: E402
    PATCH_SCHEMA,
    SYMBOL_MAP_SCHEMA,
    _layout_candidates,
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
            # Ideal sources without an explicit design_include policy are bench
            # objects.  Design export must omit them while simulation keeps them.
            component("vin_source", "V", "DC 5", 80, 240, [pin("p", "vin"), pin("n", "0")]),
            component("iload", "I", "DC 1m", 720, 300, [pin("p", "out"), pin("n", "0")]),
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


def kicad_instance_for_refdes(schematic: str, refdes: str) -> str:
    marker = f'(property "Reference" "{refdes}"'
    marker_index = schematic.find(marker)
    assert marker_index >= 0, f"KiCad instance for {refdes} is missing"
    start = schematic.rfind("  (symbol (lib_id ", 0, marker_index)
    assert start >= 0, f"KiCad instance block for {refdes} is missing"
    end = schematic.find("\n  (symbol (lib_id ", marker_index)
    if end < 0:
        end = len(schematic)
    return schematic[start:end]


def assert_eda_semantics(ir: dict) -> None:
    components = [entry for page in ir["pages"] for entry in page["components"]]
    refdes = []
    for entry in components:
        semantics = entry.get("eda")
        assert isinstance(semantics, dict), f"{entry['id']} is missing EDA semantics"
        assert semantics.get("device_class"), f"{entry['id']} has no EDA device class"
        assert semantics.get("subtype"), f"{entry['id']} has no EDA subtype"
        assert semantics.get("refdes_prefix"), f"{entry['id']} has no refdes prefix"
        assert re.fullmatch(r"[A-Z]+[1-9][0-9]*", str(semantics.get("refdes", ""))), f"invalid refdes for {entry['id']}"
        source_pin_ids = {str(pin_value["id"]) for pin_value in entry.get("pins", [])}
        assert set(semantics.get("pin_roles", {})) == source_pin_ids, f"incomplete pin roles for {entry['id']}"
        for pin_value in entry.get("pins", []):
            pin_semantics = pin_value.get("eda")
            assert isinstance(pin_semantics, dict) and pin_semantics.get("role"), f"{entry['id']}.{pin_value['id']} has no terminal role"
            assert pin_semantics.get("side") in {"left", "right", "top", "bottom"}
            assert isinstance(pin_semantics.get("order"), int)
        refdes.append(semantics["refdes"])
    assert len(refdes) == len(set(refdes)), "EDA refdes must be unique across the export"


def main() -> int:
    output = REPO / "output" / "eda-export-regression"
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    project, modules = project_fixture()
    orientation_candidates = _layout_candidates(modules["pmos_ldo"], "design")
    assert any(
        next(entry for entry in candidate if entry["id"] == "mpass")["rotation"] in {90, 270}
        for candidate in orientation_candidates
    ), "multi-pin devices must receive orthogonal orientation candidates"
    document_hash = "a" * 64
    expected_hash = connectivity_hash(project, modules, view="design")
    ir, quality = build_eda_ir(project, modules, scope="project", module_id=None, view="design", document_hash=document_hash)
    assert ir["schema"] == "actoviq.eda-ir.v1"
    assert ir["connectivity"]["hash"] == expected_hash
    assert_eda_semantics(ir)
    repeated_ir, _ = build_eda_ir(project, modules, scope="project", module_id=None, view="design", document_hash=document_hash)
    first_refdes = {f"{page['id']}:{entry['id']}": entry["eda"]["refdes"] for page in ir["pages"] for entry in page["components"]}
    repeated_refdes = {f"{page['id']}:{entry['id']}": entry["eda"]["refdes"] for page in repeated_ir["pages"] for entry in page["components"]}
    assert repeated_refdes == first_refdes, "refdes allocation must be deterministic"
    ldo = next(page for page in ir["pages"] if page["id"] == "pmos_ldo")
    assert {entry["id"] for entry in ldo["components"]} == {"mpass", "rpu", "rload"}, "design view must implicitly exclude unforced V/I sources"
    rpu = next(entry for entry in ldo["components"] if entry["id"] == "rpu")
    mpass = next(entry for entry in ldo["components"] if entry["id"] == "mpass")
    assert rpu["eda"]["device_class"] == "resistor"
    assert mpass["eda"]["subtype"].lower() == "pmos", "PMOS model semantics were not inferred"
    assert rpu["eda"]["refdes"].startswith("R") and mpass["eda"]["refdes"].startswith("M")
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
    simulation_ir, _ = build_eda_ir(project, modules, scope="project", module_id=None, view="simulation", document_hash=document_hash)
    simulation_ldo = next(page for page in simulation_ir["pages"] if page["id"] == "pmos_ldo")
    assert {"vin_source", "iload"} <= {entry["id"] for entry in simulation_ldo["components"]}, "simulation view must retain ideal sources"

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
        assert manifest["targets"][target]["status"] != "import_ready", "native-convert=never must not claim vendor import readiness"

    kicad_schematics = sorted((export_root / "kicad").glob("*.kicad_sch"))
    assert all(balanced(path.read_text(encoding="utf-8")) for path in kicad_schematics)
    kicad_text = "\n".join(path.read_text(encoding="utf-8") for path in kicad_schematics)
    standard_symbols = export_root / "kicad" / "Actoviq_Standard.kicad_sym"
    assert standard_symbols.is_file(), "KiCad export must ship the standard project-local symbol library"
    symbol_text = standard_symbols.read_text(encoding="utf-8")
    assert "Actoviq_Standard:" in kicad_text and "Actoviq_Generic:" not in kicad_text
    assert "PMOS_4PIN" in symbol_text and "(polyline " in symbol_text and ("(arc " in symbol_text or "(circle " in symbol_text), "standard library must contain recognizable device graphics"
    assert '(number "1"' in symbol_text and '(number "2"' in symbol_text
    assert not re.search(r'\((?:number|pin) "(?:a|b)"', kicad_text + "\n" + symbol_text), "source pin IDs must not leak into KiCad target pin numbers"
    for physical in (mpass, rpu, next(entry for entry in ldo["components"] if entry["id"] == "rload")):
        instance = kicad_instance_for_refdes(kicad_text, physical["eda"]["refdes"])
        assert "(on_board yes)" in instance, f"physical component {physical['id']} must be on_board"

    orcad_text = next((export_root / "orcad").glob("*.edf")).read_text(encoding="utf-8")
    assert balanced(orcad_text)
    assert re.search(r"\(design\s", orcad_text, re.IGNORECASE), "OrCAD EDIF must contain a top-level design"
    assert re.search(r"\(figure\s", orcad_text, re.IGNORECASE), "OrCAD EDIF symbols/schematic must include figure graphics"
    assert re.search(r"\(property\s+REFDES\b", orcad_text, re.IGNORECASE)
    assert re.search(r"\(property\s+VALUE\b", orcad_text, re.IGNORECASE)

    virtuoso_map = (export_root / "virtuoso" / "device-map.json").read_text(encoding="utf-8").lower()
    virtuoso_skill = (export_root / "virtuoso" / "create_schematic.il").read_text(encoding="utf-8").lower()
    assert "pmos4" in virtuoso_map and "pmos4" in virtuoso_skill, "PMOS instances must map to analogLib/pmos4"
    virtuoso_spice = next((export_root / "virtuoso").glob("*.spice")).read_text(encoding="utf-8")
    block_line = next(line for line in virtuoso_spice.splitlines() if "ERROR_AMP" in line)
    assert block_line.split()[0].upper().startswith("X") and not block_line.upper().startswith("BLOCK"), "BLOCK SPICE instance names must start with X"

    altium_readme = (export_root / "altium" / "IMPORT_ALTIUM.md").read_text(encoding="utf-8")
    assert "KiCad" in altium_readme and "Import Wizard" in altium_readme and ".kicad_pro" in altium_readme
    for source in (export_root / "kicad").iterdir():
        if source.is_file() and (source.suffix in {".kicad_pro", ".kicad_sch", ".kicad_sym"} or source.name == "sym-lib-table"):
            copied = export_root / "altium" / source.name
            assert copied.is_file() and copied.read_bytes() == source.read_bytes(), f"Altium package must preserve KiCad import source {source.name}"
    assert all((export_root / relative_path).is_file() for relative_path in manifest["files"])

    custom_mapping = output / "custom-symbol-map.json"
    custom_mapping.write_text(json.dumps({
        "schema": SYMBOL_MAP_SCHEMA,
        "targets": {"kicad": {"components": {"pmos_ldo:rpu": {
            "library": "Fixture_Lib", "cell": "Mapped_Resistor", "view": "symbol",
            "pin_map": {"a": "11", "b": "22"},
        }}}},
    }), encoding="utf-8")
    custom_result = export_eda(
        output / "custom-map-run", project, modules,
        {"blocking": False, "summary": {"errors": 0}}, document_hash,
        scope="module", module_id="pmos_ldo", targets=["kicad"], view="design",
        mapping_file=str(custom_mapping), native_convert="never", strict_layout=False, source_revision=7,
    )
    custom_root = Path(custom_result["export_root"])
    resolved_mapping = (custom_root / "ir" / "symbol-map.resolved.json").read_text(encoding="utf-8")
    custom_kicad = "\n".join(path.read_text(encoding="utf-8") for path in (custom_root / "kicad").glob("*.kicad_sch"))
    assert "Fixture_Lib" in resolved_mapping and "Mapped_Resistor" in resolved_mapping
    assert 'Fixture_Lib:Mapped_Resistor' in custom_kicad, "custom KiCad library/cell mapping was not consumed"
    for target_pin in ("11", "22"):
        assert re.search(rf'\((?:pin|number) "{target_pin}"', custom_kicad), f"custom KiCad pin {target_pin} was not consumed"

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
