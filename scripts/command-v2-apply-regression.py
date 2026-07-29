#!/usr/bin/env python3
"""M2 closure: confirm the backend applies every command.v2 operation
natively and atomically with project and module revision guards.

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

        # Apply all v2 operation kinds in one atomic transaction. Later
        # operations intentionally depend on earlier ones so this also proves
        # in-transaction ordering.
        v2_command = {
            "schema": "actoviq.command.v2",
            "command_id": "v2-apply-test",
            "actor": "regression",
            "project_id": project_id,
            "module_id": "filter",
            "base_revision": base_revision,
            "expected_module_revision": 0,
            "message": "native v2 operation coverage",
            "operations": [
                {
                    "op": "place_component",
                    "component": {
                        "id": "r_new",
                        "type": "R",
                        "name": "RNEW",
                        "value": "1k",
                        "position": {"x": 300, "y": 300},
                        "rotation": 0,
                        "pins": [
                            {"id": "a", "name": "1", "net": "in"},
                            {"id": "b", "name": "2", "net": "out"},
                        ],
                    },
                },
                {"op": "update_component", "component_id": "r_new", "value": "2k", "parameters": {"tolerance": "1%"}},
                {"op": "move_entities", "entity_ids": ["r_new"], "delta": {"x": 10, "y": 0}, "mode": "free"},
                {
                    "op": "place_component",
                    "component": {
                        "id": "r_delete",
                        "type": "R",
                        "name": "RDELETE",
                        "value": "1k",
                        "position": {"x": 700, "y": 300},
                        "rotation": 0,
                        "pins": [
                            {"id": "a", "name": "1", "net": "in"},
                            {"id": "b", "name": "2", "net": "out"},
                        ],
                    },
                },
                {"op": "delete_entities", "entity_ids": ["r_delete"]},
                {
                    "op": "upsert_port",
                    "port": {
                        "id": "debug",
                        "name": "DEBUG",
                        "direction": "output",
                        "signal_type": "analog",
                        "net": "out",
                    },
                },
                {"op": "delete_entities", "entity_ids": ["port:debug"]},
                {
                    "op": "create_wire",
                    "wire_id": "w1",
                    "points": [{"x": 0, "y": 0}, {"x": 310, "y": 0}, {"x": 310, "y": 300}],
                    "from": {"x": 0, "y": 0, "port_id": "input"},
                    "to": {"x": 310, "y": 300, "component_id": "r_new", "pin_id": "a"},
                    "net": "in",
                    "net_id": "net_in",
                },
                {
                    "op": "edit_wire_path",
                    "wire_id": "w1",
                    "points": [{"x": 0, "y": 0}, {"x": 0, "y": 300}, {"x": 310, "y": 300}],
                },
                {"op": "split_wire", "wire_id": "w1", "point": {"x": 0, "y": 150}, "junction_id": "j_split"},
                {"op": "join_wires", "wire_ids": ["w1", "w1__j_split"]},
                {
                    "op": "create_wire",
                    "wire_id": "w2",
                    "points": [{"x": 400, "y": 0}, {"x": 500, "y": 0}],
                    "from": {"x": 400, "y": 0, "junction_id": "j_w2_left"},
                    "to": {"x": 500, "y": 0, "junction_id": "j_w2_right"},
                    "net": "in",
                    "net_id": "net_in",
                },
                {"op": "upsert_junction", "junction_id": "j_w2_mid", "point": {"x": 450, "y": 0}, "net": "in"},
                {"op": "rename_net", "old_net": "in", "new_net": "input_main"},
                {
                    "op": "place_module_instance",
                    "component_id": "amp_instance",
                    "module_ref": {"module_id": "amplifier", "revision": 0},
                    "position": {"x": 600, "y": 200},
                    "pins": [{"id": "out", "name": "OUT", "net": "out"}],
                },
                {"op": "set_module_metadata", "name": "V2 edited filter"},
            ],
        }
        apply_result = run_skill([
            "apply",
            "--project-root", project_root,
            "--command-json", json.dumps(v2_command),
        ])
        assert apply_result.get("ok") is True, f"v2 apply failed: {apply_result}"

        summary = run_skill(["summary", "--project-root", project_root])
        assert summary["project"]["revision"] == base_revision + 1, "v2 apply did not advance revision"

        # Every operation family must be reflected in the saved module.
        module = json.loads((Path(project_root) / "modules" / "filter" / "module.circuit.json").read_text(encoding="utf-8"))
        r_new = next((c for c in module["components"] if c["id"] == "r_new"), None)
        assert r_new is not None, "place_component did not persist r_new"
        assert r_new["value"] == "2k" and r_new["position"]["x"] == 310, "update/move did not persist"
        assert not any(c["id"] == "r_delete" for c in module["components"]), "delete_entities did not remove component"
        assert not any(p["id"] == "debug" for p in module["ports"]), "delete_entities did not remove port"
        assert any(c["id"] == "amp_instance" and c["type"] == "MODULE" for c in module["components"]), "module instance missing"
        assert module["name"] == "V2 edited filter", "set_module_metadata did not persist"
        assert any(net["name"] == "input_main" for net in module["nets"]), "rename_net did not update net table"
        assert any(wire["id"] == "w1" for wire in module["wires"]), "split/join did not preserve w1"
        assert any(wire["id"] == "w2__j_w2_mid" for wire in module["wires"]), "upsert_junction did not split w2"

        # A failing later operation must not persist an earlier operation or
        # advance either revision.
        atomic_failure = {
            **v2_command,
            "command_id": "v2-atomic-failure",
            "base_revision": base_revision + 1,
            "expected_module_revision": 1,
            "operations": [
                {
                    "op": "place_component",
                    "component": {
                        "id": "r_atomic",
                        "type": "R",
                        "name": "RATOMIC",
                        "value": "1k",
                        "position": {"x": 0, "y": 0},
                        "rotation": 0,
                        "pins": [{"id": "a", "name": "1", "net": "out"}],
                    },
                },
                {"op": "split_wire", "wire_id": "missing", "point": {"x": 0, "y": 0}},
            ],
        }
        try:
            run_skill(["apply", "--project-root", project_root, "--command-json", json.dumps(atomic_failure)])
            assert False, "failing v2 transaction was accepted"
        except subprocess.CalledProcessError:
            pass
        unchanged = run_skill(["summary", "--project-root", project_root])
        assert unchanged["project"]["revision"] == base_revision + 1, "failed transaction advanced project revision"
        module_after_failure = json.loads((Path(project_root) / "modules" / "filter" / "module.circuit.json").read_text(encoding="utf-8"))
        assert not any(c["id"] == "r_atomic" for c in module_after_failure["components"]), "failed transaction partially persisted"
        assert not (Path(project_root) / "revisions" / "000002").exists(), (
            "failed transaction left a revision snapshot"
        )

        # Stale base_revision must be rejected.
        stale_command = dict(v2_command, command_id="v2-stale", base_revision=base_revision)
        try:
            run_skill(["apply", "--project-root", project_root, "--command-json", json.dumps(stale_command)])
            assert False, "stale v2 base_revision was accepted"
        except subprocess.CalledProcessError:
            pass  # expected: stale revision rejected

        # A stale module precondition must reject even when the project
        # revision is current.
        unsupported = dict(
            v2_command,
            command_id="v2-stale-module",
            base_revision=base_revision + 1,
            expected_module_revision=0,
            operations=[{"op": "set_module_metadata", "name": "must not apply"}],
        )
        try:
            run_skill(["apply", "--project-root", project_root, "--command-json", json.dumps(unsupported)])
            assert False, "stale module revision was accepted"
        except subprocess.CalledProcessError:
            pass

        missing_module_revision = dict(
            v2_command,
            command_id="v2-missing-module-revision",
            base_revision=base_revision + 1,
            operations=[{"op": "set_module_metadata", "name": "must not apply"}],
        )
        missing_module_revision.pop("expected_module_revision", None)
        try:
            run_skill([
                "apply",
                "--project-root",
                project_root,
                "--command-json",
                json.dumps(missing_module_revision),
            ])
            assert False, "v2 command without expected_module_revision was accepted"
        except subprocess.CalledProcessError:
            pass

        print(json.dumps({
            "ok": True,
            "suite": "command-v2-apply-regression",
            "all_v2_operations_persisted": True,
            "revision_after_v2": base_revision + 1,
            "stale_rejected": True,
            "stale_module_rejected": True,
            "missing_module_revision_rejected": True,
            "atomic_rollback": True,
        }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
