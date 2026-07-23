#!/usr/bin/env python3
"""Focused regression for PCB project gates and LCSC C-number binding."""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL_ROOT = ROOT / "skills" / "circuit-design-ngspice"
sys.path.insert(0, str(SKILL_ROOT / "scripts"))

from circuit_project import bridge_import_cold, load_project, module_path, persist_bridge_pull  # noqa: E402
from lcsc_search import bind_part_to_component, default_cache_dir, get_part  # noqa: E402
from project_kinds import kind_summary  # noqa: E402


def main() -> int:
    pcb = kind_summary("pcb_schematic")
    analog = kind_summary("analog_ic")
    assert pcb["supports_lcsc_binding"] and pcb["supports_eda_bridge"]
    assert not analog["supports_lcsc_binding"] and not analog["supports_eda_bridge"]
    assert SKILL_ROOT.resolve() not in default_cache_dir().resolve().parents

    with tempfile.TemporaryDirectory(prefix="actoviq-lcsc-regression-") as temp:
        temp_root = Path(temp)
        cache = temp_root / "cache"
        invalid = get_part("21190", use_fallback=True, cache_dir=cache)
        assert invalid["ok"] is False
        result = get_part("c21190", use_fallback=True, cache_dir=cache)
        assert result["ok"] is True
        no_credentials = get_part("C21190", use_fallback=False, cache_dir=cache)
        assert no_credentials["ok"] is False, "mock fallback cache must not satisfy a production lookup"
        assert no_credentials.get("source") != "mock_fallback"
        component = {"id": "r1", "type": "R", "name": "R1", "value": "1k"}
        bind_part_to_component(component, result["part"])
        assert component["eda"]["lcsc_id"] == "C21190"
        assert component["eda"]["mpn"] and component["eda"]["footprint_hint"]

        projects_root = temp_root / "projects"
        projects_root.mkdir()

        jlceda_peer = temp_root / "jlceda-peer"
        jlceda_peer.mkdir()
        (jlceda_peer / "ordinary.easyeda.json").write_text(
            json.dumps(
                {
                    "head": {"docType": "3", "title": "普通嘉立创原理图"},
                    "shape": [
                        [
                            "LIB",
                            "ordinary-resistor",
                            "R普通",
                            25.4,
                            50.8,
                            90,
                            0,
                            {},
                            {"Reference": "R普通", "Value": "10k中文"},
                            [],
                        ]
                    ],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        jlceda_cold = bridge_import_cold(
            projects_root=projects_root,
            peer_kind="jlceda",
            peer_root=jlceda_peer,
            name="JLCEDA cold import",
        )
        assert jlceda_cold["ok"], jlceda_cold
        _jlceda_project, jlceda_modules = load_project(Path(jlceda_cold["project_root"]))
        jlceda_components = jlceda_modules["sheet1"]["components"]
        assert len(jlceda_components) == 1 and jlceda_components[0]["type"] == "BLOCK"
        assert jlceda_components[0]["eda"]["foreign_symbol"] == "ordinary-resistor"
        assert jlceda_components[0]["value"] == "10k中文"
        assert jlceda_components[0]["eda"]["refdes"] == "R普通"
        assert jlceda_components[0]["pins"][0]["net"] == "NC"

        jlceda_root = Path(jlceda_cold["project_root"])
        project_before, modules_before = load_project(jlceda_root)
        project_revision_before = int(project_before["revision"])
        module_revision_before = int(modules_before["sheet1"]["revision"])
        project_bytes_before = (jlceda_root / "project.circuit.json").read_bytes()
        module_bytes_before = module_path(jlceda_root, "sheet1").read_bytes()
        peer_edit = json.loads(json.dumps(modules_before["sheet1"]))
        peer_edit["components"][0]["position"] = {"x": 640, "y": 480}

        review_result = persist_bridge_pull(
            jlceda_root,
            {
                "ok": True,
                "policy": "manual_review",
                "conflicts": [{"code": "unknown_component", "message": "review required"}],
                "updated_modules": {"sheet1": peer_edit},
            },
        )
        assert review_result["persisted"] is False and review_result["requires_review"] is True
        assert (jlceda_root / "project.circuit.json").read_bytes() == project_bytes_before
        assert module_path(jlceda_root, "sheet1").read_bytes() == module_bytes_before
        project_after_review, modules_after_review = load_project(jlceda_root)
        assert int(project_after_review["revision"]) == project_revision_before
        assert int(modules_after_review["sheet1"]["revision"]) == module_revision_before

        persisted_result = persist_bridge_pull(
            jlceda_root,
            {
                "ok": True,
                "policy": "layout_wins",
                "conflicts": [],
                "updated_modules": {"sheet1": peer_edit},
            },
        )
        assert persisted_result["persisted"] is True
        project_after_pull, modules_after_pull = load_project(jlceda_root)
        assert int(project_after_pull["revision"]) == project_revision_before + 1
        assert int(modules_after_pull["sheet1"]["revision"]) == module_revision_before + 1
        assert modules_after_pull["sheet1"]["components"][0]["position"] == {"x": 640, "y": 480}

        kicad_peer = temp_root / "kicad-peer"
        kicad_peer.mkdir()
        (kicad_peer / "ordinary.kicad_sch").write_text(
            """(kicad_sch (version 20231120) (generator eeschema)
  (symbol (lib_id \"Device:R\") (at 25.4 50.8 90)
    (property \"Reference\" \"R普通\")
    (property \"Value\" \"10k中文\")
    (uuid 11111111-1111-1111-1111-111111111111)
  )
)\n""",
            encoding="utf-8",
        )
        kicad_cold = bridge_import_cold(
            projects_root=projects_root,
            peer_kind="kicad",
            peer_root=kicad_peer,
            name="KiCad cold import",
        )
        assert kicad_cold["ok"], kicad_cold
        assert kicad_cold["pull"]["cold_start_created"] == 1
        _kicad_project, kicad_modules = load_project(Path(kicad_cold["project_root"]))
        kicad_component = kicad_modules["sheet1"]["components"][0]
        assert kicad_component["type"] == "BLOCK"
        assert kicad_component["value"] == "10k中文"
        assert kicad_component["eda"]["refdes"] == "R普通"

        empty_jlceda = temp_root / "empty-jlceda"
        empty_jlceda.mkdir()
        (empty_jlceda / "empty.json").write_text(
            json.dumps({"head": {"docType": "3"}, "shape": []}),
            encoding="utf-8",
        )
        empty_result = bridge_import_cold(
            projects_root=projects_root,
            peer_kind="jlceda",
            peer_root=empty_jlceda,
            name="Empty cold import",
        )
        assert not empty_result["ok"], "empty cold import must not report success"

        empty_kicad = temp_root / "empty-kicad"
        empty_kicad.mkdir()
        (empty_kicad / "empty.kicad_sch").write_text(
            "(kicad_sch (version 20231120) (generator eeschema))\n",
            encoding="utf-8",
        )
        empty_kicad_result = bridge_import_cold(
            projects_root=projects_root,
            peer_kind="kicad",
            peer_root=empty_kicad,
            name="Empty KiCad cold import",
        )
        assert not empty_kicad_result["ok"], "empty KiCad cold import must not report success"

    print(json.dumps({"ok": True, "suite": "pcb-integration-regression"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
