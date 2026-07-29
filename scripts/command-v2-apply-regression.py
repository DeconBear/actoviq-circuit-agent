#!/usr/bin/env python3
"""M2-02: confirm the backend accepts v2 transactions via the adapter and
applies them atomically with the same base_revision guard as v1.

The adapter translates v2 ops to v1 ops (place_component -> add_component,
delete_entities -> remove_component, etc.) so the GUI can start emitting v2
without waiting for the engine to grow native v2 ops (M2-03).

Run:  python scripts/command-v2-apply-regression.py
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
            "--name", "v2 apply regression",
        ])
        project_root = created["project_root"]
        project_id = created["project"]["project_id"]
        base_revision = created["project"]["revision"]

        # Apply a v2 transaction that places a component.
        v2_command = {
            "schema": "actoviq.command.v2",
            "command_id": "v2-apply-test",
            "actor": "regression",
            "project_id": project_id,
            "module_id": "filter",
            "base_revision": base_revision,
            "message": "v2 place_component via adapter",
            "operations": [{
                "op": "place_component",
                "component": {
                    "id": "r_new",
                    "type": "R",
                    "name": "RNEW",
                    "value": "1k",
                    "position": {"x": 300, "y": 300},
                    "rotation": 0,
                    "pins": [{"id": "a", "name": "1", "net": "in"}, {"id": "b", "name": "2", "net": "out"}],
                },
            }],
        }
        apply_result = run_skill([
            "apply",
            "--project-root", project_root,
            "--command-json", json.dumps(v2_command),
        ])
        assert apply_result.get("ok") is True, f"v2 apply failed: {apply_result}"

        summary = run_skill(["summary", "--project-root", project_root])
        assert summary["project"]["revision"] == base_revision + 1, "v2 apply did not advance revision"

        # The placed component must be in the saved module.
        module = json.loads((Path(project_root) / "modules" / "filter" / "module.circuit.json").read_text(encoding="utf-8"))
        assert any(c["id"] == "r_new" for c in module["components"]), "v2 place_component did not persist r_new"

        # Stale base_revision must be rejected.
        stale_command = dict(v2_command, command_id="v2-stale", base_revision=base_revision)
        try:
            run_skill(["apply", "--project-root", project_root, "--command-json", json.dumps(stale_command)])
            assert False, "stale v2 base_revision was accepted"
        except subprocess.CalledProcessError:
            pass  # expected: stale revision rejected

        # v2 op with no adapter (e.g. split_wire) must raise, not silently pass.
        unsupported = dict(v2_command, command_id="v2-unsupported", base_revision=base_revision + 1,
                           operations=[{"op": "split_wire", "wire_id": "w1", "point": {"x": 0, "y": 0}}])
        try:
            run_skill(["apply", "--project-root", project_root, "--command-json", json.dumps(unsupported)])
            assert False, "unsupported v2 op was silently accepted"
        except subprocess.CalledProcessError:
            pass  # expected: adapter raises for unsupported v2 ops

        print(json.dumps({
            "ok": True,
            "suite": "command-v2-apply-regression",
            "v2_place_accepted": True,
            "revision_after_v2": base_revision + 1,
            "stale_rejected": True,
            "unsupported_op_rejected": True,
        }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
