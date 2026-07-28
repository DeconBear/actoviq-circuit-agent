#!/usr/bin/env python3
"""M2-07: confirm the v1 set_module_schematic op still works as an import /
compatibility batch path while v2 transactions become the normal GUI save.

The GUI save path will migrate to v2 in M2-03, but set_module_schematic must
remain accepted so existing project history and import flows keep working
(ADR-0003: v1 stays readable via adapter; no bulk migration).

Run:  python scripts/command-v1-adapter-regression.py
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / "skills" / "circuit-design-ngspice" / "scripts" / "circuit_project.py"


def run_skill(args: list[str]) -> dict:
    result = subprocess.run(
        ["python", str(SKILL), *args],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        projects_root = str(Path(tmp) / "projects")
        created = run_skill([
            "create-demo",
            "--projects-root", projects_root,
            "--name", "v1 adapter regression",
        ])
        project_root = created["project_root"]
        project_id = created["project"]["project_id"]
        base_revision = created["project"]["revision"]

        # Read the current filter module to build a v1 set_module_schematic op.
        filter_path = Path(project_root) / "modules" / "filter" / "module.circuit.json"
        module = json.loads(filter_path.read_text(encoding="utf-8"))

        # Apply a v1 command that renames the module via set_module_schematic,
        # exercising the compat batch path. This must remain accepted.
        command = {
            "schema": "actoviq.command.v1",
            "command_id": "v1-adapter-test",
            "actor": "regression",
            "project_id": project_id,
            "base_revision": base_revision,
            "message": "v1 set_module_schematic compat batch",
            "operations": [{
                "op": "set_module_schematic",
                "module_id": "filter",
                "components": module["components"],
                "ports": module["ports"],
                "nets": module.get("nets", []),
                "wires": module.get("wires", []),
                "annotations": module.get("annotations", []),
            }],
        }
        apply_result = run_skill([
            "apply",
            "--project-root", project_root,
            "--command-json", json.dumps(command),
        ])
        assert apply_result.get("ok") is True, f"v1 apply failed: {apply_result}"

        # The project revision must advance, proving the v1 op was accepted.
        summary = run_skill(["summary", "--project-root", project_root])
        assert summary["project"]["revision"] > base_revision, "v1 op did not advance revision"

        # M2-05: revision metadata must include operation_summary and affected_entities.
        revision_root = Path(project_root) / "revisions" / f"{summary['project']['revision']:06d}"
        metadata = json.loads((revision_root / "metadata.json").read_text(encoding="utf-8"))
        assert "operation_summary" in metadata, "revision metadata missing operation_summary"
        assert "affected_entities" in metadata, "revision metadata missing affected_entities"
        assert metadata["operation_summary"].get("set_module_schematic") == 1, \
            f"operation_summary missing set_module_schematic: {metadata['operation_summary']}"
        assert "filter" in metadata["affected_entities"], \
            f"filter not in affected_entities: {metadata['affected_entities']}"

        # The v2 schema must reject this command (no v2 op named set_module_schematic).
        import jsonschema
        v2_schema_path = ROOT / "skills" / "circuit-design-ngspice" / "schemas" / "command.v2.schema.json"
        v2_schema = json.loads(v2_schema_path.read_text(encoding="utf-8"))
        v2_command = dict(command, schema="actoviq.command.v2")
        validator = jsonschema.Draft202012Validator(v2_schema)
        assert not validator.is_valid(v2_command), "v1 set_module_schematic must not validate against v2 schema"

        print(json.dumps({
            "ok": True,
            "suite": "command-v1-adapter-regression",
            "v1_accepted": True,
            "revision_after_v1": summary["project"]["revision"],
            "v2_rejects_v1_op": True,
        }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
