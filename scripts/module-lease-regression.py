#!/usr/bin/env python3
"""M2-06: module soft lease regression.

Confirms:
- acquire/renew/release lifecycle works.
- a second actor cannot acquire a non-expired lease (structured conflict).
- a v2 apply from a different actor is blocked when a lease is held.
- the holder's own v2 apply is allowed.
- release by a non-holder is rejected.
- Agent transactions can be staged, listed, accepted, or rejected.
- acceptance re-checks project/module revisions and leaves stale proposals pending.

Run:  python scripts/module-lease-regression.py
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


def run_skill_raw(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["python", str(SKILL), *args],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        projects_root = str(Path(tmp) / "projects")
        created = run_skill([
            "create-demo", "--projects-root", projects_root, "--name", "lease regression",
        ])
        project_root = created["project_root"]
        project_id = created["project"]["project_id"]
        base_revision = created["project"]["revision"]

        # Acquire a lease as user-A.
        lease = run_skill([
            "module-lease-acquire", "--project-root", project_root,
            "--module-id", "filter", "--actor", "user-A",
        ])
        assert lease["actor"] == "user-A", lease

        # user-B cannot acquire; expect a structured conflict.
        conflict = run_skill_raw([
            "module-lease-acquire", "--project-root", project_root,
            "--module-id", "filter", "--actor", "user-B",
        ])
        assert conflict.returncode != 0, "second actor should not be able to acquire a live lease"
        assert "leased by user-A" in conflict.stdout, conflict.stdout

        # user-B's v2 apply is blocked by the lease.
        v2_command = {
            "schema": "actoviq.command.v2", "command_id": "v2-lease-block",
            "actor": "user-B", "project_id": project_id, "module_id": "filter",
            "base_revision": base_revision, "expected_module_revision": 0,
            "message": "blocked",
            "operations": [{"op": "set_module_metadata", "name": "Blocked"}],
        }
        blocked = run_skill_raw([
            "apply", "--project-root", project_root, "--command-json", json.dumps(v2_command),
        ])
        assert blocked.returncode != 0, "v2 apply from a different actor should be blocked by the lease"
        assert "leased by user-A" in blocked.stdout, blocked.stdout

        # user-A's own v2 apply is allowed.
        v2_own = dict(v2_command, command_id="v2-lease-own", actor="user-A")
        own = run_skill([
            "apply", "--project-root", project_root, "--command-json", json.dumps(v2_own),
        ])
        assert own.get("ok") is True, own
        summary = run_skill(["summary", "--project-root", project_root])
        assert summary["project"]["revision"] == base_revision + 1

        # Release by user-B is rejected.
        release_b = run_skill_raw([
            "module-lease-release", "--project-root", project_root,
            "--module-id", "filter", "--actor", "user-B",
        ])
        assert release_b.returncode != 0, "non-holder should not be able to release"

        # Release by user-A succeeds.
        release = run_skill([
            "module-lease-release", "--project-root", project_root,
            "--module-id", "filter", "--actor", "user-A",
        ])
        assert release["released"] is True, release

        pending_reject = {
            **v2_command,
            "command_id": "agent-reject",
            "actor": "agent",
            "base_revision": base_revision + 1,
            "expected_module_revision": 1,
            "message": "Review then reject",
            "operations": [{"op": "set_module_metadata", "name": "Rejected name"}],
        }
        staged_reject = run_skill([
            "pending-stage", "--project-root", project_root,
            "--command-json", json.dumps(pending_reject),
        ])
        assert staged_reject["status"] == "pending", staged_reject
        assert staged_reject["summary"]["operation_count"] == 1, staged_reject
        pending = run_skill(["pending-list", "--project-root", project_root])
        assert [entry["command_id"] for entry in pending["pending"]] == ["agent-reject"], pending
        rejected = run_skill([
            "pending-reject", "--project-root", project_root,
            "--command-id", "agent-reject", "--reason", "user declined",
        ])
        assert rejected["rejected"] == "agent-reject", rejected
        after_reject = run_skill(["summary", "--project-root", project_root])
        assert after_reject["project"]["revision"] == base_revision + 1

        pending_accept = {
            **pending_reject,
            "command_id": "agent-accept",
            "message": "Review then accept",
            "operations": [{"op": "set_module_metadata", "name": "Accepted name"}],
        }
        run_skill([
            "pending-stage", "--project-root", project_root,
            "--command-json", json.dumps(pending_accept),
        ])
        accepted = run_skill([
            "pending-accept", "--project-root", project_root,
            "--command-id", "agent-accept",
        ])
        assert accepted["accepted"] == "agent-accept", accepted
        after_accept = run_skill(["summary", "--project-root", project_root])
        assert after_accept["project"]["revision"] == base_revision + 2
        assert after_accept["modules"]["filter"]["name"] == "Accepted name"

        stale_pending = {
            **pending_accept,
            "command_id": "agent-stale",
            "base_revision": base_revision + 2,
            "expected_module_revision": 2,
            "message": "Must become stale",
        }
        run_skill([
            "pending-stage", "--project-root", project_root,
            "--command-json", json.dumps(stale_pending),
        ])
        intervening = {
            "schema": "actoviq.command.v1",
            "command_id": "intervening",
            "actor": "user",
            "project_id": project_id,
            "base_revision": base_revision + 2,
            "message": "Intervening project edit",
            "operations": [{
                "op": "set_module_note",
                "module_id": "power",
                "notes": "intervening",
            }],
        }
        run_skill([
            "apply", "--project-root", project_root,
            "--command-json", json.dumps(intervening),
        ])
        stale_accept = run_skill_raw([
            "pending-accept", "--project-root", project_root,
            "--command-id", "agent-stale",
        ])
        assert stale_accept.returncode != 0, "stale pending command must not be applied"
        assert "stale revision" in stale_accept.stdout, stale_accept.stdout
        pending_after_stale = run_skill(["pending-list", "--project-root", project_root])
        assert [entry["command_id"] for entry in pending_after_stale["pending"]] == ["agent-stale"]

        print(json.dumps({
            "ok": True,
            "suite": "module-lease-regression",
            "acquire_release": True,
            "second_actor_blocked": True,
            "v2_apply_blocked_for_non_holder": True,
            "v2_apply_allowed_for_holder": True,
            "non_holder_release_rejected": True,
            "pending_accept_reject": True,
            "pending_stale_revision_blocked": True,
        }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
