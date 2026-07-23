#!/usr/bin/env python3
"""Regression checks for analog-IC sizing and external benchmark integration."""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL_ROOT = ROOT / "skills" / "circuit-design-ngspice"
sys.path.insert(0, str(SKILL_ROOT / "scripts"))

from analog_ic import (  # noqa: E402
    AUDIT_SCHEMA,
    PROFILE_SCHEMA,
    audit_project,
    extract_mos_devices,
    load_project,
    rewrite_model_paths,
    validate_profile,
)
from project_kinds import ensure_project_kind, kind_summary  # noqa: E402
from razavi_bench import inspect_checkout  # noqa: E402
from validate_netlist_primitives import validate_netlist_text  # noqa: E402
import circuit_project  # noqa: E402
from circuit_project import module_from_netlist_notebook  # noqa: E402
from eda_export import SYMBOL_MAP_SCHEMA, _write_virtuoso  # noqa: E402
from eda_portable_validate import validate_virtuoso_package  # noqa: E402
from eda_symbols import resolve_symbol_map  # noqa: E402


def assert_kind_matrix() -> None:
    simulation = kind_summary("simulation")
    analog = kind_summary("analog_ic")
    pcb = kind_summary("pcb_schematic")
    assert simulation["requires_simulation"] is True
    assert analog["requires_simulation"] is True
    assert analog["supports_lcsc_binding"] is False
    assert analog["supports_eda_bridge"] is False
    assert analog["supports_virtuoso_export"] is True
    assert pcb["requires_simulation"] is False
    assert pcb["supports_lcsc_binding"] is True
    assert pcb["supports_eda_bridge"] is True
    assert pcb["supports_virtuoso_export"] is False
    migrated: dict = {}
    assert ensure_project_kind(migrated) == "simulation"
    assert migrated["project_kind"] == "simulation"
    try:
        ensure_project_kind({"project_kind": "analog_icc"})
        raise AssertionError("an explicit invalid project_kind was silently accepted")
    except ValueError:
        pass


def assert_netlist_kind_gate() -> None:
    forbidden = validate_netlist_text("X1 in out packaged_part\n.end\n", "simulation")
    assert forbidden["ok"] is False
    assert forbidden["violations"][0]["kind"] == "forbidden_instance"
    include = validate_netlist_text("R1 in out 1k\n.include forbidden.lib\n.end\n", "simulation")
    assert include["ok"] is False
    assert any(item["kind"] == "forbidden_directive" for item in include["violations"])
    empty_module = {
        "schema": "actoviq.module.v2",
        "module_id": "core",
        "name": "Core",
        "revision": 0,
        "ports": [],
        "components": [],
        "nets": [],
        "wires": [],
        "annotations": [],
    }
    try:
        module_from_netlist_notebook("core", "```spice\nX1 in out packaged_part\n.end\n```", empty_module, "simulation")
        raise AssertionError("simulation transaction accepted an X instance")
    except ValueError as error:
        assert "not allowed" in str(error)

    analog = module_from_netlist_notebook(
        "core",
        "```spice\nM1 d g s b nmos W=1u L=0.15u\n"
        "X2 d2 g2 s2 b2 pmos_fet PARAMS: W=2u L=0.18u NF=2\n.end\n```",
        empty_module,
        "analog_ic",
    )
    assert {component["type"] for component in analog["components"]} == {"M", "X"}


def assert_set_module_schematic_kind_gate(root: Path) -> None:
    project = {
        "schema": "actoviq.project.v2",
        "project_id": "simulation-kind-gate",
        "name": "Simulation kind gate",
        "project_kind": "simulation",
        "revision": 0,
        "modules": [{"id": "core", "ports": []}],
        "connections": [],
    }
    module = {
        "schema": "actoviq.module.v2",
        "module_id": "core",
        "name": "Core",
        "revision": 0,
        "ports": [],
        "components": [],
        "nets": [],
        "wires": [],
        "annotations": [],
    }
    rejected_sources = (
        ("X1 in out packaged_part\n.end", "instance 'X1'"),
        (".include forbidden.lib\nR1 in out 1k\n.end", "directive '.include'"),
    )
    for source, expected_message in rejected_sources:
        operation = {
            "op": "set_module_schematic",
            "module_id": "core",
            "components": [],
            "ports": [],
            "nets": [],
            "wires": [],
            "annotations": [],
            "netlist_notebook": f"```spice\n{source}\n```",
        }
        try:
            circuit_project.apply_operation(
                root,
                project,
                {"core": json.loads(json.dumps(module))},
                operation,
                set(),
                {},
                {},
            )
            raise AssertionError(f"set_module_schematic accepted forbidden simulation source: {source}")
        except ValueError as error:
            assert expected_message in str(error), error


def assert_profile_sizing_cannot_be_disabled() -> None:
    profile = {
        "schema": PROFILE_SCHEMA,
        "simulator": "ngspice",
        "pdk": {"name": "synthetic", "model_library": "models/mock.lib", "corner": "tt"},
        "sizing": {"require_explicit_w_l": True, "require_scale_suffix": True},
    }
    expected_codes = {
        "require_explicit_w_l": "profile_explicit_w_l_required",
        "require_scale_suffix": "profile_scale_suffix_required",
    }
    for field, expected_code in expected_codes.items():
        invalid = json.loads(json.dumps(profile))
        invalid["sizing"][field] = False
        assert expected_code in {error["code"] for error in validate_profile(invalid)}


def assert_compiled_controlled_source_references(root: Path) -> None:
    project = {
        "schema": "actoviq.project.v2",
        "project_id": "controlled-reference-regression",
        "name": "Controlled reference regression",
        "project_kind": "analog_ic",
        "revision": 0,
        "modules": [{"id": "core", "ports": []}],
        "connections": [],
        "analyses": {"ac": {"enabled": False}},
    }

    def component(component_id: str, component_type: str, name: str, value: str, positive: str) -> dict:
        return {
            "id": component_id,
            "type": component_type,
            "name": name,
            "value": value,
            "position": {"x": 100, "y": 100},
            "rotation": 0,
            "pins": [
                {"id": "p", "name": "+", "net": positive},
                {"id": "n", "name": "-", "net": "0"},
            ],
        }

    module = {
        "schema": "actoviq.module.v2",
        "module_id": "core",
        "name": "Core",
        "revision": 0,
        "ports": [],
        "components": [
            component("sense", "V", "Vsense", "DC 0", "sense+"),
            component("fcopy", "F", "Fcopy", "VSENSE 2", "f-out"),
            component("hcopy", "H", "Hcopy", "vsense 10", "h-out"),
            component(
                "bmath",
                "B",
                "Bmath",
                "V=V(sense+, 0) + I(VSENSE) + v(f-out)",
                "b-out",
            ),
        ],
        "nets": [],
        "wires": [],
        "annotations": [],
    }
    module_dir = root / "modules" / "core"
    module_dir.mkdir(parents=True, exist_ok=True)
    (root / "project.circuit.json").write_text(json.dumps(project), encoding="utf-8")
    (module_dir / "module.circuit.json").write_text(json.dumps(module), encoding="utf-8")

    original_renderer = circuit_project.render_module_schematic
    circuit_project.render_module_schematic = lambda *_args, **_kwargs: {
        "ok": False,
        "svg_path": "",
        "renderer": "regression-stub",
    }
    try:
        result = circuit_project.compile_project(root)
    finally:
        circuit_project.render_module_schematic = original_renderer

    system_netlist = Path(result["netlist_path"]).read_text(encoding="utf-8")
    module_netlist = (root / "build" / "modules" / "core" / "design.cir").read_text(encoding="utf-8")
    assert "Fcore_Fcopy core_f_out 0 Vcore_Vsense 2" in system_netlist
    assert "Hcore_Hcopy core_h_out 0 Vcore_Vsense 10" in system_netlist
    assert "Bcore_Bmath core_b_out 0 V=V(core_sense,0) + I(Vcore_Vsense) + v(core_f_out)" in system_netlist
    assert "Fcore_Fcopy f_out 0 Vcore_Vsense 2" in module_netlist
    assert "Hcore_Hcopy h_out 0 Vcore_Vsense 10" in module_netlist
    assert "Bcore_Bmath b_out 0 V=V(sense,0) + I(Vcore_Vsense) + v(f_out)" in module_netlist


def assert_lib_section_markers_are_not_includes(root: Path) -> None:
    from analog_ic import _include_records, rewrite_model_paths

    model = root / "models" / "cmos_demo.lib.spice"
    model.parent.mkdir(parents=True, exist_ok=True)
    model.write_text(
        "* demo\n.lib tt\n.model nmos nmos (LEVEL=1)\n.endl tt\n",
        encoding="utf-8",
    )
    source = '.lib "models/cmos_demo.lib.spice" tt\n'
    records = _include_records(source, root)
    assert len(records) == 1
    assert records[0]["path"] == "models/cmos_demo.lib.spice"
    assert records[0]["suffix"] == "tt"
    nested = _include_records(model.read_text(encoding="utf-8"), model.parent)
    assert nested == []
    rewritten = rewrite_model_paths(".lib tt\n.lib \"models/cmos_demo.lib.spice\" tt\n", root)
    assert rewritten.splitlines()[0] == ".lib tt"
    assert str(model.resolve().as_posix()) in rewritten


def assert_system_dc_directive_rewrites_prefixed_sources(root: Path) -> None:
    project = {
        "schema": "actoviq.project.v2",
        "project_id": "dc-rewrite-regression",
        "name": "DC rewrite regression",
        "project_kind": "analog_ic",
        "revision": 0,
        "modules": [{"id": "core", "ports": []}],
        "connections": [],
        "analyses": {"ac": {"enabled": False}},
    }
    module = {
        "schema": "actoviq.module.v2",
        "module_id": "core",
        "name": "Core",
        "revision": 0,
        "ports": [],
        "components": [
            {
                "id": "vin",
                "type": "V",
                "name": "VIN",
                "value": "DC 0",
                "position": {"x": 100, "y": 100},
                "rotation": 0,
                "pins": [
                    {"id": "p", "name": "+", "net": "vin"},
                    {"id": "n", "name": "-", "net": "0"},
                ],
            },
            {
                "id": "rout",
                "type": "R",
                "name": "Rout",
                "value": "1k",
                "position": {"x": 200, "y": 100},
                "rotation": 0,
                "pins": [
                    {"id": "a", "name": "A", "net": "vin"},
                    {"id": "b", "name": "B", "net": "out"},
                ],
            },
        ],
        "nets": [],
        "wires": [],
        "annotations": [],
        "spice": {
            "source": "VIN vin 0 DC 0\nRout vin out 1k\n.dc VIN 0 1 0.1\n.print dc v(out)\n.end\n",
            "directives": [".dc VIN 0 1 0.1", ".print dc v(out)"],
            "models": [],
            "opaque": [],
        },
    }
    module_dir = root / "modules" / "core"
    module_dir.mkdir(parents=True, exist_ok=True)
    (root / "project.circuit.json").write_text(json.dumps(project), encoding="utf-8")
    (module_dir / "module.circuit.json").write_text(json.dumps(module), encoding="utf-8")
    (module_dir / "netlist-notebook.md").write_text(
        "```spice\nVIN vin 0 DC 0\nRout vin out 1k\n.dc VIN 0 1 0.1\n.print dc v(out)\n.end\n```\n",
        encoding="utf-8",
    )

    original_renderer = circuit_project.render_module_schematic
    circuit_project.render_module_schematic = lambda *_args, **_kwargs: {
        "ok": False,
        "svg_path": "",
        "renderer": "regression-stub",
    }
    try:
        result = circuit_project.compile_project(root)
    finally:
        circuit_project.render_module_schematic = original_renderer

    system_netlist = Path(result["netlist_path"]).read_text(encoding="utf-8")
    assert "Vcore_VIN" in system_netlist
    assert ".dc Vcore_VIN 0 1 0.1" in system_netlist
    assert ".print dc v(core_out)" in system_netlist
    assert ".dc VIN 0 1 0.1" not in system_netlist


def analog_fixture(root: Path, source: str) -> tuple[dict, dict[str, dict]]:
    model = root / "models" / "mock.lib"
    model.parent.mkdir(parents=True, exist_ok=True)
    model.write_text("* synthetic regression model\n", encoding="utf-8")
    project = {
        "schema": "actoviq.project.v2",
        "project_id": "analog-regression",
        "name": "Synthetic analog regression",
        "project_kind": "analog_ic",
        "revision": 3,
        "analog_ic_profile": {
            "schema": PROFILE_SCHEMA,
            "simulator": "ngspice",
            "pdk": {
                "name": "synthetic-pdk",
                "model_library": "models/mock.lib",
                "corner": "tt",
                "temperature_c": 27,
            },
            "sizing": {
                "require_explicit_w_l": True,
                "require_scale_suffix": True,
            },
        },
        "modules": [{"id": "core"}],
        "connections": [],
    }
    parsed_devices = extract_mos_devices(source)
    module = {
        "schema": "actoviq.module.v2",
        "module_id": "core",
        "name": "Core",
        "revision": 3,
        "ports": [],
        "components": [
            {
                "id": str(device["reference"]).casefold(),
                "type": "M" if device["kind"] == "mos_primitive" else "X",
                "name": device["reference"],
                "value": " ".join([
                    device["model"],
                    *(f"{key}={value}" for key, value in device["parameters"].items()),
                ]),
            }
            for device in parsed_devices
        ],
        "spice": {"source": source},
    }
    notebook = root / "modules" / "core" / "netlist-notebook.md"
    notebook.parent.mkdir(parents=True, exist_ok=True)
    notebook.write_text(f"```spice\n{source.strip()}\n```\n", encoding="utf-8")
    return project, {"core": module}


def assert_analog_audit(root: Path) -> None:
    valid_source = """\
.lib models/mock.lib tt
.temp 27
.param WN=1.2u LN=0.15u
M1 out in 0 0 nmos w={WN} l={LN} m=2
X2 out bias vdd vdd pmos_fet w=2.4u l=0.18u nf=4
"""
    project, modules = analog_fixture(root, valid_source)
    result = audit_project(root, project, modules)
    assert result["schema"] == AUDIT_SCHEMA
    assert result["ok"] is True, result
    assert result["summary"]["mos_device_count"] == 2
    assert result["devices"][0]["w_over_l"] == 8.0

    gui_source = valid_source.replace("M1 out", "Mcore_M1 out")
    gui_project, gui_modules = analog_fixture(root, gui_source)
    gui_modules["core"]["components"][0]["name"] = "M1"
    gui_modules["core"]["components"][0]["id"] = "m1"
    gui_modules["core"]["components"][0]["stable_id"] = "component-m1"
    gui_result = audit_project(root, gui_project, gui_modules)
    assert gui_result["ok"] is True, gui_result
    assert gui_result["devices"][0]["structured_id"] == "component-m1"

    invalid_source = """\
.lib models/mock.lib tt
Mbad out in 0 0 nmos w=1 l=0.15u
"""
    bad_project, bad_modules = analog_fixture(root, invalid_source)
    bad = audit_project(root, bad_project, bad_modules)
    assert bad["ok"] is False
    assert "missing_scale_suffix_w" in {item["code"] for item in bad["errors"]}

    unsafe_project, unsafe_modules = analog_fixture(root, valid_source + ".control\nshell echo unsafe\n.endc\n")
    unsafe = audit_project(root, unsafe_project, unsafe_modules)
    assert "unsafe_control_block" in {item["code"] for item in unsafe["errors"]}

    params_devices = extract_mos_devices("X1 d g s b sky130_fd_pr__nfet_01v8 PARAMS: W=1u L=0.15u\n")
    assert params_devices[0]["model"] == "sky130_fd_pr__nfet_01v8"
    rewritten = rewrite_model_paths(valid_source, root)
    assert (root / "models" / "mock.lib").resolve().as_posix() in rewritten


def assert_nested_control_and_subcircuit_audit(root: Path) -> None:
    included_control = root / "included-control" / "models" / "unsafe.inc"
    included_control.parent.mkdir(parents=True, exist_ok=True)
    included_control.write_text(".control\nshell echo unsafe\n.endc\n", encoding="utf-8")
    include_source = """\
.lib models/mock.lib tt
.include models/unsafe.inc
M1 out in 0 0 nmos W=1u L=0.15u
"""
    include_project, include_modules = analog_fixture(root / "included-control", include_source)
    include_result = audit_project(root / "included-control", include_project, include_modules)
    assert "unsafe_included_control_block" in {error["code"] for error in include_result["errors"]}

    subckt_source = """\
.lib models/mock.lib tt
.subckt local_stage in out
M1 out in 0 0 nmos W=1u L=0.15u
.ends local_stage
"""
    subckt_project, subckt_modules = analog_fixture(root / "embedded-subckt", subckt_source)
    subckt_result = audit_project(root / "embedded-subckt", subckt_project, subckt_modules)
    assert "embedded_subcircuit_scope_unsupported" in {
        error["code"] for error in subckt_result["errors"]
    }


def write_synthetic_benchmark(root: Path) -> None:
    for relative in ("README.md", "LICENSE"):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("synthetic regression fixture\n", encoding="utf-8")


def assert_benchmark_adapter(root: Path) -> None:
    write_synthetic_benchmark(root)
    check = inspect_checkout(root)
    assert check["ok"] is False
    assert check["policy"]["evaluation_integration"] == "blocked_pending_written_permission"
    serialized = json.dumps(check).casefold()
    for forbidden in ("task_count", "instruction_path", "figure_paths", "golden_solution", "evaluate_answers"):
        assert forbidden not in serialized


def assert_audit_path_containment(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "project.circuit.json").write_text(json.dumps({
        "schema": "actoviq.project.v2",
        "project_id": "escape",
        "modules": [{"id": "../outside"}],
    }), encoding="utf-8")
    try:
        load_project(root)
        raise AssertionError("module path traversal was accepted")
    except ValueError:
        pass


def assert_virtuoso_handoff(root: Path) -> None:
    project_root = root / "project"
    model = project_root / "models" / "mock.lib"
    model.parent.mkdir(parents=True, exist_ok=True)
    model.write_text("* synthetic model\n", encoding="utf-8")
    profile = {
        "schema": PROFILE_SCHEMA,
        "simulator": "ngspice",
        "pdk": {"name": "synthetic", "model_library": "models/mock.lib", "corner": "tt"},
        "sizing": {"require_explicit_w_l": True, "require_scale_suffix": True},
    }
    component = {
        "id": "m1",
        "stable_id": "component-m1",
        "type": "M",
        "name": "M1",
        "value": "nmos W=1u L=0.15u M=2 NF=2",
        "position": {"x": 100, "y": 100},
        "rotation": 0,
        "pins": [
            {"id": "d", "name": "D", "net": "d"},
            {"id": "g", "name": "G", "net": "g"},
            {"id": "s", "name": "S", "net": "s"},
            {"id": "b", "name": "B", "net": "b"},
        ],
    }
    records = [
        {"module_id": "core", "component_id": "m1", "pin_id": pin["id"], "net": pin["net"]}
        for pin in component["pins"]
    ]
    ir = {
        "schema": "actoviq.eda-ir.v1",
        "source": {
            "project_id": "analog-export",
            "revision": 4,
            "document_hash": "d" * 64,
            "scope": "project",
            "module_id": None,
            "view": "design",
        },
        "project": {
            "id": "analog-export",
            "name": "Analog export",
            "project_kind": "analog_ic",
            "analog_ic_profile": profile,
            "connections": [],
        },
        "pages": [{
            "id": "core",
            "name": "Core",
            "revision": 4,
            "components": [component],
            "ports": [],
            "nets": [{"id": pin["net"], "name": pin["net"], "endpoints": []} for pin in component["pins"]],
            "wires": [],
            "annotations": [],
            "spice": {
                "source": ".lib models/mock.lib tt\nM1 d g s b nmos W=1u L=0.15u M=2 NF=2\n.end\n",
                "models": [".lib models/mock.lib tt"],
            },
        }],
        "connectivity": {"records": records, "hash": "c" * 64},
    }
    symbol_map = resolve_symbol_map(None, ir["pages"], ["virtuoso"], SYMBOL_MAP_SCHEMA)
    export_root = root / "export"
    _write_virtuoso(export_root, "Analog_export", ir, symbol_map, project_root)
    report = validate_virtuoso_package(export_root / "virtuoso", ir, symbol_map)
    assert report["passed"] is True
    assert report["model_bindings"] == 1
    assert report["source_spice_pages"] == 1
    package = export_root / "virtuoso"
    resolved_model = model.resolve().as_posix()
    assert resolved_model in (package / "model-bindings.spice").read_text(encoding="utf-8")
    main_spice = next(path for path in package.glob("*.spice") if path.name != "model-bindings.spice")
    assert resolved_model in main_spice.read_text(encoding="utf-8")
    assert json.loads((package / "analog-ic-profile.json").read_text(encoding="utf-8")) == profile


def assert_schemas_parse() -> None:
    for name in ("analog-ic-profile.schema.json", "analog-ic-audit.schema.json"):
        json.loads((SKILL_ROOT / "schemas" / name).read_text(encoding="utf-8"))


def _erc_project(root: Path, module_id: str, components: list[dict]) -> dict:
    project = {
        "schema": "actoviq.project.v2",
        "project_id": root.name,
        "name": root.name,
        "project_kind": "simulation",
        "revision": 1,
        "modules": [{"id": module_id, "ports": []}],
        "connections": [],
        "analyses": {"ac": {"enabled": False}},
    }
    module = {
        "schema": "actoviq.module.v2",
        "module_id": module_id,
        "name": module_id,
        "revision": 0,
        "ports": [],
        "components": components,
        "nets": [],
        "wires": [],
        "annotations": [],
    }
    (root / "modules" / module_id).mkdir(parents=True, exist_ok=True)
    (root / "project.circuit.json").write_text(json.dumps(project), encoding="utf-8")
    (root / "modules" / module_id / "module.circuit.json").write_text(
        json.dumps(module), encoding="utf-8"
    )
    return circuit_project.evaluate_erc(project, {module_id: module})


def assert_modularity_erc_heuristics(root: Path) -> None:
    def resistor(index: int) -> dict:
        return {
            "id": f"r{index}",
            "type": "R",
            "name": f"R{index}",
            "value": "1k",
            "position": {"x": 100, "y": 100},
            "rotation": 0,
            "pins": [
                {"id": "a", "name": "1", "net": f"n{index}"},
                {"id": "b", "name": "2", "net": "0"},
            ],
        }

    source = {
        "id": "vin",
        "type": "V",
        "name": "VIN",
        "value": "DC 1",
        "position": {"x": 40, "y": 40},
        "rotation": 0,
        "pins": [
            {"id": "p", "name": "+", "net": "n0"},
            {"id": "n", "name": "-", "net": "0"},
        ],
    }

    small = _erc_project(
        root / "small-rc",
        "filter",
        [
            source,
            {
                "id": "r1",
                "type": "R",
                "name": "R1",
                "value": "1k",
                "position": {"x": 100, "y": 100},
                "rotation": 0,
                "pins": [
                    {"id": "a", "name": "1", "net": "n0"},
                    {"id": "b", "name": "2", "net": "out"},
                ],
            },
            {
                "id": "c1",
                "type": "C",
                "name": "C1",
                "value": "100n",
                "position": {"x": 200, "y": 100},
                "rotation": 0,
                "pins": [
                    {"id": "a", "name": "1", "net": "out"},
                    {"id": "b", "name": "2", "net": "0"},
                ],
            },
        ],
    )
    small_codes = {item["code"] for item in small["diagnostics"]}
    assert "oversized_module" not in small_codes
    assert "monolithic_complex_design" not in small_codes
    assert small["blocking"] is False

    oversized = _erc_project(
        root / "oversized",
        "blob",
        [source, *[resistor(i) for i in range(1, 18)]],
    )
    oversized_codes = {item["code"] for item in oversized["diagnostics"]}
    assert "oversized_module" in oversized_codes
    assert oversized["blocking"] is False
    assert any(item["code"] == "oversized_module" for item in oversized["diagnostics"])

    monolithic = _erc_project(
        root / "monolithic",
        "core",
        [source, *[resistor(i) for i in range(1, 10)]],
    )
    mono_codes = {item["code"] for item in monolithic["diagnostics"]}
    assert "monolithic_complex_design" in mono_codes
    assert "oversized_module" not in mono_codes
    assert monolithic["blocking"] is False

    summary = circuit_project.modularity_summary(
        json.loads((root / "oversized" / "project.circuit.json").read_text(encoding="utf-8")),
        {
            "blob": {
                "components": [source, *[resistor(i) for i in range(1, 18)]],
            }
        },
    )
    assert summary["module_count"] == 1
    assert summary["oversized_modules"]
    assert "Split oversized" in summary["guidance"] or "split" in summary["guidance"].lower()


def main() -> int:
    assert_kind_matrix()
    assert_netlist_kind_gate()
    assert_profile_sizing_cannot_be_disabled()
    assert_schemas_parse()
    with tempfile.TemporaryDirectory(prefix="actoviq-analog-ic-") as temp:
        temp_root = Path(temp)
        assert_set_module_schematic_kind_gate(temp_root / "transaction-gate")
        assert_analog_audit(temp_root / "project")
        assert_nested_control_and_subcircuit_audit(temp_root / "nested-source-audit")
        assert_compiled_controlled_source_references(temp_root / "controlled-references")
        assert_lib_section_markers_are_not_includes(temp_root / "lib-sections")
        assert_system_dc_directive_rewrites_prefixed_sources(temp_root / "dc-rewrite")
        assert_modularity_erc_heuristics(temp_root / "modularity-erc")
        assert_benchmark_adapter(temp_root / "razavi-bench")
        assert_audit_path_containment(temp_root / "escape-project")
        assert_virtuoso_handoff(temp_root / "virtuoso")
    print(json.dumps({"ok": True, "suite": "analog-ic-regression"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
