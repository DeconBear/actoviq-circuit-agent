#!/usr/bin/env python3
"""Read-only Razavi-Bench provenance preflight.

Razavi-Bench's benchmark-material terms prohibit incorporation into a third-
party evaluation suite without written permission.  This module therefore
does not read tasks, expose task paths, prepare answer-agent context, or run
any upstream code.  It only records the provenance needed to enable a future
licensed adapter without vendoring benchmark material.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path
from typing import Any


SCHEMA = "actoviq.razavi-bench-preflight.v1"
UPSTREAM_LICENSE = "https://github.com/Arcadia-1/razavi-bench/blob/main/LICENSE"
EXPECTED_REMOTE_RE = re.compile(
    r"^(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)"
    r"Arcadia-1/razavi-bench(?:\.git)?/?$",
    re.IGNORECASE,
)
REQUIRED_PUBLIC_FILES = ("README.md", "LICENSE")


def _git(root: Path, *args: str) -> tuple[int, str]:
    try:
        completed = subprocess.run(
            ["git", "-c", f"safe.directory={root.as_posix()}", "-C", str(root), *args],
            capture_output=True,
            text=True,
            check=False,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        return 1, ""
    return completed.returncode, completed.stdout.strip()


def inspect_checkout(root: Path) -> dict[str, Any]:
    """Inspect only public provenance files; never enumerate benchmark tasks."""
    checkout = root.resolve()
    missing = [relative for relative in REQUIRED_PUBLIC_FILES if not (checkout / relative).is_file()]
    remote_status, remote = _git(checkout, "remote", "get-url", "origin")
    revision_status, revision = _git(checkout, "rev-parse", "--verify", "HEAD")
    dirty_status, dirty = _git(checkout, "status", "--porcelain", "--untracked-files=no")
    license_path = checkout / "LICENSE"
    license_sha256 = hashlib.sha256(license_path.read_bytes()).hexdigest() if license_path.is_file() else ""

    errors: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    if missing:
        errors.append({"code": "checkout_incomplete", "message": f"missing public files: {', '.join(missing)}"})
    if remote_status != 0 or not EXPECTED_REMOTE_RE.fullmatch(remote):
        errors.append({"code": "unexpected_remote", "message": "checkout origin is not the canonical Razavi-Bench repository"})
    if revision_status != 0 or not re.fullmatch(r"[0-9a-fA-F]{40}", revision):
        errors.append({"code": "revision_unavailable", "message": "checkout has no immutable Git revision"})
    if dirty_status != 0:
        warnings.append({"code": "worktree_status_unavailable", "message": "Git worktree status could not be read"})
    elif dirty:
        warnings.append({"code": "tracked_changes_present", "message": "checkout has tracked changes; results would not be revision-reproducible"})

    return {
        "schema": SCHEMA,
        "ok": not errors,
        "remote": remote if EXPECTED_REMOTE_RE.fullmatch(remote) else "",
        "revision": revision if re.fullmatch(r"[0-9a-fA-F]{40}", revision) else "",
        "license_sha256": license_sha256,
        "errors": errors,
        "warnings": warnings,
        "policy": {
            "materials_bundled": False,
            "task_materials_accessed": False,
            "upstream_code_executed": False,
            "evaluation_integration": "blocked_pending_written_permission",
            "upstream_license": UPSTREAM_LICENSE,
            "next_step": "Obtain written permission from the benchmark authors before enabling an Actoviq evaluation adapter.",
        },
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Read-only Razavi-Bench provenance check; evaluation integration is license-blocked"
    )
    parser.add_argument("--repo", required=True, help="Local canonical upstream checkout")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    result = inspect_checkout(Path(args.repo))
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
