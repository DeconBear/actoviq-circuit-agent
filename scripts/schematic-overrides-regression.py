#!/usr/bin/env python3
"""M5-04..06 legacy schematic override compatibility regression."""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SKILL_SCRIPTS = ROOT / "skills" / "circuit-design-ngspice" / "scripts"
CIRCUIT_PROJECT = SKILL_SCRIPTS / "circuit_project.py"


def run_cli(arguments: list[str]) -> dict:
    completed = subprocess.run(
        ["python", str(CIRCUIT_PROJECT), *arguments],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(completed.stdout)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="actoviq-overrides-") as temporary:
        projects_root = Path(temporary) / "projects"
        created = run_cli([
            "create-demo",
            "--projects-root",
            str(projects_root),
            "--name",
            "Override compatibility",
        ])
        project_root = Path(created["project_root"])
        module_id = "filter"
        module_path = project_root / "modules" / module_id / "module.circuit.json"
        module_before = module_path.read_bytes()
        module = json.loads(module_before)
        component = module["components"][0]
        component_name = str(component["name"])
        compiled_name = f"{module_id}_{component_name}"
        if not compiled_name.upper().startswith(str(component["type"]).upper()):
            compiled_name = f"{component['type']}{compiled_name}"

        import_path = Path(temporary) / "legacy-overrides.json"
        import_path.write_text(json.dumps({
            "schema": "actoviq.schematic-overrides.v1",
            "project_id": "portable-source",
            "module_id": module_id,
            "items": {
                compiled_name: {"x": 120.5, "y": 240.25, "locked": True},
                "removed_legacy_cell": {"x": 42, "y": 84, "locked": False},
            },
        }), encoding="utf-8")

        imported = run_cli([
            "schematic-overrides-import",
            "--project-root",
            str(project_root),
            "--module-id",
            module_id,
            "--input-path",
            str(import_path),
        ])
        report = imported["migration_report"]
        assert report["compatibility_only"] is True
        assert report["module_was_modified"] is False
        assert report["summary"] == {
            "override_count": 2,
            "mapped_count": 1,
            "unmapped_count": 1,
        }
        assert report["mapped"][0]["component_id"] == component["id"]
        assert module_path.read_bytes() == module_before

        export_path = Path(temporary) / "exported-overrides.json"
        exported = run_cli([
            "schematic-overrides-export",
            "--project-root",
            str(project_root),
            "--module-id",
            module_id,
            "--output-path",
            str(export_path),
        ])
        exported_document = json.loads(export_path.read_text(encoding="utf-8"))
        assert exported["override_count"] == 2
        assert exported_document["project_id"] == created["project"]["project_id"]
        assert set(exported_document["items"]) == {compiled_name, "removed_legacy_cell"}
        assert module_path.read_bytes() == module_before

        regenerated = run_cli([
            "schematic-overrides-report",
            "--project-root",
            str(project_root),
            "--module-id",
            module_id,
        ])
        assert regenerated["summary"] == report["summary"]
        assert Path(regenerated["report_path"]).is_file()
        assert module_path.read_bytes() == module_before

        workbench_source = (
            ROOT / "renderer" / "src" / "components" / "canvas" / "CircuitWorkbench.tsx"
        ).read_text(encoding="utf-8")
        assert 'data-schematic-source="netlistsvg-compatibility"' in workbench_source
        assert "actoviq.module.v2) remains the only native edit source" in workbench_source
        for source_path in (
            ROOT / "renderer" / "src" / "components" / "canvas" / "CircuitWorkbench.tsx",
            ROOT / "renderer" / "src" / "components" / "schematic" / "SvgViewer.tsx",
        ):
            source = source_path.read_text(encoding="utf-8")
            assert "from '../../schematic/schematicDocument'" not in source
        editor_source = (
            ROOT / "renderer" / "src" / "components" / "canvas" / "SchematicEditor.tsx"
        ).read_text(encoding="utf-8")
        assert "  createSchematicDocument," not in editor_source

    print(json.dumps({
        "ok": True,
        "suite": "schematic-overrides-regression",
        "compatibility_only": True,
        "module_v2_unchanged": True,
        "ui_truth_source_audited": True,
        "mapped_count": 1,
        "unmapped_count": 1,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
