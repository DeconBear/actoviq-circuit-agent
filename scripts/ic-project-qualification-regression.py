#!/usr/bin/env python3
"""Deterministic contract tests for IC project qualification evidence."""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from jsonschema import Draft202012Validator


ROOT = Path(__file__).resolve().parents[1]
SKILL_SCRIPTS = ROOT / "skills" / "circuit-design-ngspice" / "scripts"
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(SKILL_SCRIPTS))

import ic_project_qualification as qualification_module  # noqa: E402
from circuit_project import project_document_hash  # noqa: E402
from ic_project_qualification import (  # noqa: E402
    build_report,
    tool_record_matches_environment,
)
from module_hierarchy import ordered_connectivity_hash  # noqa: E402
from xschem_bridge import module_hash as xschem_module_hash  # noqa: E402


HASH_A = "a" * 64
HASH_B = "b" * 64


def write_json(path: Path, value: object) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    return path


def simulation(provider: str) -> dict:
    return {
        "schema": "actoviq.simulation.v3",
        "run_id": f"{provider}-run",
        "scope": "project",
        "source_revision": 7,
        "document_hash": "",
        "ok": True,
        "execution_status": "success",
        "measurement_status": "success",
        "specification_status": "passed",
        "verified": True,
        "analysis_count": 1,
        "analyses": [{
            "id": "tran",
            "type": "tran",
            "status": "completed",
            "metrics": [{"name": "gain", "value": 10.0}],
            "tables": {
                "wave.csv": {
                    "time": [0.0, 1e-9, 2e-9],
                    "v(out)": [0.0, 0.5, 1.0],
                },
            },
        }],
        "metrics": [{"name": "gain", "value": 10.0}],
        "provider": {
            "id": provider,
            "executable": f"/opt/{provider}",
            "version": f"{provider} fixture 1.0",
        },
        "execution_target": "local_linux",
        "verification": {
            "executed": True,
            "measured": True,
            "spec_passed": True,
            "lvs_clean": None,
            "ams_verified": False,
        },
    }


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="actoviq-ic-qualification-") as temporary:
        root = Path(temporary)
        project_root = root / "project"
        child_ports = [
            {"id": "out", "name": "OUT", "direction": "output", "signal_type": "analog", "net": "out"},
            {"id": "vdd", "name": "VDD", "direction": "input", "signal_type": "power", "net": "vdd"},
            {"id": "gnd", "name": "GND", "direction": "input", "signal_type": "ground", "net": "0"},
        ]
        child = {
            "schema": "actoviq.module.v2",
            "module_id": "gain",
            "name": "PDK gain stage",
            "revision": 1,
            "ports": child_ports,
            "components": [{
                "id": "m1",
                "stable_id": "gain-m1",
                "type": "M",
                "name": "M1",
                "value": "sg13_lv_nmos W=1u L=0.13u NF=1 M=1",
                "position": {"x": 100, "y": 100},
                "rotation": 0,
                "pins": [
                    {"id": "D", "name": "D", "net": "out"},
                    {"id": "G", "name": "G", "net": "in"},
                    {"id": "S", "name": "S", "net": "0"},
                    {"id": "B", "name": "B", "net": "0"},
                ],
                "parameters": {
                    "device_id": "nmos",
                    "model": "sg13_lv_nmos",
                    "w": "1u",
                    "l": "0.13u",
                    "nf": "1",
                    "m": "1",
                    "corner": "tt",
                },
            }],
            "wires": [],
            "annotations": [],
        }
        top = {
            "schema": "actoviq.module.v2",
            "module_id": "top",
            "name": "Top",
            "revision": 1,
            "ports": [],
            "components": [{
                "id": "xgain",
                "stable_id": "top-xgain",
                "type": "MODULE",
                "name": "XGAIN",
                "value": "gain",
                "position": {"x": 200, "y": 100},
                "rotation": 0,
                "module_ref": {"module_id": "gain", "revision": 1},
                "pins": [
                    {"id": "out", "name": "OUT", "net": "out"},
                    {"id": "vdd", "name": "VDD", "net": "vdd"},
                    {"id": "gnd", "name": "GND", "net": "0"},
                ],
            }],
            "wires": [],
            "annotations": [],
        }
        project = {
            "schema": "actoviq.project.v2",
            "project_id": "qualified-gain-stage",
            "name": "Qualified gain stage",
            "project_kind": "analog_ic",
            "revision": 7,
            "created_at": "2026-07-30T00:00:00Z",
            "updated_at": "2026-07-30T00:00:00Z",
            "composition": {"mode": "hierarchical", "top_module_id": "top"},
            "analog_ic_profile": {
                "schema": "actoviq.analog-ic-profile.v2",
                "simulation_profile_id": "ngspice-native",
                "pdk_binding": {
                    "schema": "actoviq.pdk-binding.v1",
                    "pdk_ref": "ihp-sg13g2",
                    "fingerprint": HASH_A,
                    "default_corner": "tt",
                },
            },
            "modules": [
                {
                    "id": "gain",
                    "name": "PDK gain stage",
                    "kind": "core",
                    "source": "modules/gain/module.circuit.json",
                    "position": {"x": 0, "y": 0},
                    "size": {"width": 240, "height": 160},
                    "ports": child_ports,
                },
                {
                    "id": "top",
                    "name": "Top",
                    "kind": "top",
                    "source": "modules/top/module.circuit.json",
                    "position": {"x": 300, "y": 0},
                    "size": {"width": 240, "height": 160},
                    "ports": [],
                },
            ],
            "connections": [],
        }
        write_json(project_root / "project.circuit.json", project)
        write_json(project_root / "modules" / "gain" / "module.circuit.json", child)
        write_json(project_root / "modules" / "top" / "module.circuit.json", top)
        document_hash = project_document_hash(project, {"gain": child, "top": top})

        lock_path = write_json(root / "lock.json", {
            "schema": "actoviq.ic-qualification-lock.v1",
            "environment": {
                "platform": "native_linux",
                "distribution": "ubuntu",
                "version": "24.04",
                "wsl": False,
            },
            "golden_pdk": "ihp-sg13g2",
            "required_tools": ["ngspice", "xyce", "openvaf", "xschem"],
            "open_pdks": {
                "ihp-sg13g2": {
                    "repository": "https://example.invalid/ihp",
                    "revision": "fixture-revision",
                    "required": True,
                },
            },
        })
        pdk_path = write_json(root / "pdk-scan.json", {
            "ok": True,
            "installation": {
                "schema": "actoviq.pdk-installation.v1",
                "logical_id": "ihp-sg13g2",
                "source_kind": "open",
                "revision": "fixture-revision",
                "fingerprint": HASH_A,
                "license_hash": HASH_B,
                "root": str(root / "pdk"),
                "device_catalog": {
                    "schema": "actoviq.pdk-device-catalog.v1",
                    "devices": [{
                        "device_id": "nmos",
                        "spice": {
                            "model": "sg13_lv_nmos",
                            "pin_order": ["D", "G", "S", "B"],
                        },
                    }],
                },
            },
        })
        tool_path = write_json(root / "tool-record.json", {
            "schema": "actoviq.ic-tool-qualification.v1",
            "qualified_at": "2026-07-30T00:00:00Z",
            "platform": "linux",
            "platform_release": "6.8.0-fixture",
            "native_eligible": True,
            "wsl": False,
            "required": ["ngspice", "xyce", "openvaf", "xschem"],
            "passed": True,
            "tools": {
                tool: {
                    "available": True,
                    "executable": f"/opt/{tool}",
                    "version": f"{tool} fixture 1.0",
                    "exit_code": 0,
                }
                for tool in ("ngspice", "xyce", "openvaf", "xschem")
            },
            "smoke": {
                "ngspice": {"passed": True},
                "xyce": {"passed": True},
            },
            "missing": [],
            "failed_smoke": [],
            "ineligible_environment": False,
        })
        erc_path = write_json(project_root / "build" / "erc.json", {
            "schema": "actoviq.erc.v1",
            "source_revision": 7,
            "document_hash": document_hash,
            "status": "clean",
            "blocking": False,
            "summary": {"errors": 0, "warnings": 0, "infos": 0},
            "diagnostics": [],
        })
        netlist_path = project_root / "build" / "system" / "design.final.cir"
        netlist_path.parent.mkdir(parents=True)
        netlist_path.write_text(
            ".subckt gain out vdd 0\nM1 out in 0 0 sg13_lv_nmos W=1u L=0.13u\n.ends gain\n",
            encoding="utf-8",
        )
        ngspice_run = simulation("ngspice")
        ngspice_run["document_hash"] = document_hash
        xyce_run = simulation("xyce")
        xyce_run["document_hash"] = document_hash
        ngspice_path = write_json(project_root / "build" / "ngspice-run.json", ngspice_run)
        xyce_path = write_json(project_root / "build" / "xyce-run.json", xyce_run)
        dual_path = write_json(project_root / "build" / "dual-run.json", {
            "schema": "actoviq.verification-run.v1",
            "run_id": "dual-run",
            "kind": "dual_simulation_comparison",
            "provider_id": "actoviq",
            "executed": True,
            "status": "passed",
            "diagnostics": [],
            "artifacts": [],
            "metadata": {
                "source_revision": 7,
                "document_hash": document_hash,
                "left_profile_id": "ngspice-native",
                "right_profile_id": "xyce-native",
                "left_run_id": "ngspice-run",
                "right_run_id": "xyce-run",
                "comparison": {
                    "ok": True,
                    "comparisons": [{
                        "metric": "gain",
                        "left": 10.0,
                        "right": 10.0,
                        "delta": 0.0,
                        "tolerance": 0.01,
                        "passed": True,
                    }],
                },
            },
        })
        xschem_path = write_json(project_root / "build" / "xschem-run.json", {
            "schema": "actoviq.verification-run.v1",
            "run_id": "xschem-run",
            "kind": "schematic_reference_netlist",
            "provider_id": "xschem",
            "executed": True,
            "status": "passed",
            "diagnostics": [],
            "artifacts": [],
            "metadata": {
                "connectivity_comparison": {
                    "ok": True,
                    "compared_instance_count": 1,
                },
                "source_module_id": "gain",
                "source_module_hash": xschem_module_hash(child),
                "source_connectivity_hash": ordered_connectivity_hash(child),
                "topology_writeback": False,
            },
        })

        arguments = {
            "project_root": project_root,
            "pdk_scan_path": pdk_path,
            "lock_path": lock_path,
            "tool_record_path": tool_path,
            "erc_path": erc_path,
            "netlist_path": netlist_path,
            "ngspice_run_path": ngspice_path,
            "xyce_run_path": xyce_path,
            "dual_run_path": dual_path,
            "xschem_run_path": xschem_path,
            "allow_fixture": True,
            "commercial_attested": False,
        }
        report = build_report(**arguments)
        assert report["passed"] is True
        assert report["qualification"] == "fixture_verified"
        assert report["project"]["module_instance_count"] == 1
        assert report["project"]["pdk_device_count"] == 1
        assert report["pdk"]["revision"] == "fixture-revision"
        assert {gate["status"] for gate in report["gates"]} == {"passed"}
        assert all(len(item["sha256"]) == 64 for item in report["artifacts"])
        native_environment = {
            "platform": "linux",
            "release": "6.8.0-fixture",
        }
        tool_record = json.loads(tool_path.read_text(encoding="utf-8"))
        assert tool_record_matches_environment(tool_record, native_environment, False)
        ineligible_tool_record = json.loads(json.dumps(tool_record))
        ineligible_tool_record["native_eligible"] = False
        ineligible_tool_record["wsl"] = True
        ineligible_tool_record["ineligible_environment"] = True
        assert not tool_record_matches_environment(
            ineligible_tool_record,
            native_environment,
            False,
        )
        tool_schema = json.loads(
            (
                ROOT
                / "skills"
                / "circuit-design-ngspice"
                / "schemas"
                / "ic-tool-qualification.schema.json"
            ).read_text(encoding="utf-8")
        )
        tool_errors = list(Draft202012Validator(tool_schema).iter_errors(tool_record))
        assert not tool_errors, tool_errors

        original_environment_state = qualification_module.environment_state
        qualification_module.environment_state = lambda _allow_fixture: {
            "platform": "linux",
            "release": "6.8.0-fixture",
            "distribution": "ubuntu",
            "distribution_version": "24.04",
            "native_linux": True,
            "wsl": False,
            "eligible": True,
        }
        try:
            native_arguments = {**arguments, "allow_fixture": False}
            native = build_report(**native_arguments)
            assert native["passed"] is True
            assert native["qualification"] == "native_verified"
            write_json(tool_path, ineligible_tool_record)
            rejected_tool_record = build_report(**native_arguments)
            assert rejected_tool_record["passed"] is False
            assert next(
                gate for gate in rejected_tool_record["gates"]
                if gate["id"] == "tool_versions_and_smoke"
            )["status"] == "failed"
        finally:
            qualification_module.environment_state = original_environment_state
            write_json(tool_path, tool_record)

        schema = json.loads(
            (
                ROOT
                / "skills"
                / "circuit-design-ngspice"
                / "schemas"
                / "ic-project-qualification.schema.json"
            ).read_text(encoding="utf-8")
        )
        errors = list(Draft202012Validator(schema).iter_errors(report))
        assert not errors, errors

        broken_xyce = simulation("xyce")
        broken_xyce["document_hash"] = document_hash
        broken_xyce["analyses"][0]["tables"] = {}
        write_json(xyce_path, broken_xyce)
        broken = build_report(**arguments)
        assert broken["passed"] is False
        assert next(gate for gate in broken["gates"] if gate["id"] == "xyce_waveform")["status"] == "failed"

        restored_xyce = simulation("xyce")
        restored_xyce["document_hash"] = document_hash
        write_json(xyce_path, restored_xyce)
        linked_dual = json.loads(dual_path.read_text(encoding="utf-8"))
        unlinked_dual = json.loads(json.dumps(linked_dual))
        unlinked_dual["metadata"]["left_run_id"] = "unrelated-run"
        write_json(dual_path, unlinked_dual)
        unlinked = build_report(**arguments)
        assert unlinked["passed"] is False
        assert next(
            gate for gate in unlinked["gates"]
            if gate["id"] == "archived_run_linkage"
        )["status"] == "failed"
        write_json(dual_path, linked_dual)
        mismatched_provider = json.loads(ngspice_path.read_text(encoding="utf-8"))
        mismatched_provider["provider"]["version"] = "different ngspice build"
        write_json(ngspice_path, mismatched_provider)
        mismatched = build_report(**arguments)
        assert mismatched["passed"] is False
        assert next(
            gate for gate in mismatched["gates"]
            if gate["id"] == "archived_run_linkage"
        )["status"] == "failed"
        write_json(ngspice_path, ngspice_run)
        commercial_scan = json.loads(pdk_path.read_text(encoding="utf-8"))
        commercial_scan["installation"]["source_kind"] = "commercial"
        write_json(pdk_path, commercial_scan)
        commercial = build_report(**arguments)
        assert commercial["passed"] is False
        assert next(
            gate for gate in commercial["gates"]
            if gate["id"] == "commercial_pdk_boundary"
        )["status"] == "failed"

    print(json.dumps({
        "ok": True,
        "suite": "ic-project-qualification",
        "positive": "fixture_verified",
        "negative": [
            "ineligible_tool_record",
            "missing_waveform",
            "unlinked_dual_run",
            "provider_version_mismatch",
            "commercial_boundary_unattested",
        ],
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
