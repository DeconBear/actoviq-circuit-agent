#!/usr/bin/env python3
"""Fail-fast readiness audit for the native IC qualification workflow."""

from __future__ import annotations

import argparse
import json
import platform
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


EVIDENCE_PATHS = {
    "project_root": "directory",
    "pdk_scan": "file",
    "erc": "file",
    "netlist": "file",
    "ngspice_run": "file",
    "xyce_run": "file",
    "dual_run": "file",
    "xschem_run": "file",
}


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("expected a JSON object")
    return value


def current_environment() -> dict[str, Any]:
    release = platform.release()
    wsl = "microsoft" in release.casefold() or "wsl" in release.casefold()
    native_linux = sys.platform.startswith("linux") and not wsl
    try:
        os_release = platform.freedesktop_os_release() if native_linux else {}
    except OSError:
        os_release = {}
    return {
        "platform": sys.platform,
        "release": release,
        "distribution": str(os_release.get("ID") or ""),
        "distribution_version": str(os_release.get("VERSION_ID") or ""),
        "native_linux": native_linux,
        "wsl": wsl,
    }


def check(check_id: str, passed: bool, diagnostic: str = "") -> dict[str, Any]:
    return {
        "id": check_id,
        "status": "passed" if passed else "blocked",
        "diagnostic": "" if passed else diagnostic,
    }


def build_preflight(
    *,
    lock_path: Path,
    path_values: dict[str, str],
    environment: dict[str, Any] | None = None,
) -> dict[str, Any]:
    lock = read_json(lock_path)
    environment = environment or current_environment()
    locked_environment = lock.get("environment")
    locked_environment = locked_environment if isinstance(locked_environment, dict) else {}
    golden_pdk = str(lock.get("golden_pdk") or "")
    locked_pdk = (lock.get("open_pdks") or {}).get(golden_pdk)
    locked_pdk = locked_pdk if isinstance(locked_pdk, dict) else {}
    checks = [
        check(
            "qualification_lock",
            bool(
                lock.get("schema") == "actoviq.ic-qualification-lock.v1"
                and locked_environment.get("platform") == "native_linux"
                and locked_environment.get("wsl") is False
                and golden_pdk
                and str(locked_pdk.get("revision") or "")
            ),
            "Qualification lock must select a revisioned golden PDK on native Linux with WSL disabled.",
        ),
        check(
            "native_environment",
            bool(
                environment.get("native_linux")
                and environment.get("wsl") is False
                and str(environment.get("distribution") or "").casefold()
                == str(locked_environment.get("distribution") or "").casefold()
                and str(environment.get("distribution_version") or "")
                == str(locked_environment.get("version") or "")
            ),
            "Runner must be the native Linux distribution/version locked by ic-qualification-lock.json; WSL is ineligible.",
        ),
    ]

    resolved_paths: dict[str, str] = {}
    path_status: dict[str, dict[str, Any]] = {}
    for path_id, kind in EVIDENCE_PATHS.items():
        raw_path = str(path_values.get(path_id) or "").strip()
        target = Path(raw_path).expanduser().resolve() if raw_path else None
        exists = bool(
            target
            and (target.is_dir() if kind == "directory" else target.is_file())
        )
        checks.append(check(
            f"path_{path_id}",
            exists,
            f"Configure an existing {kind} for {path_id}.",
        ))
        resolved_paths[path_id] = str(target) if target else ""
        path_status[path_id] = {"kind": kind, "available": exists}

    project_path = (
        Path(resolved_paths["project_root"]) / "project.circuit.json"
        if resolved_paths["project_root"]
        else None
    )
    project_ok = False
    project_diagnostic = "Qualification project is unavailable."
    if project_path and project_path.is_file():
        try:
            project = read_json(project_path)
            project_ok = bool(
                project.get("schema") == "actoviq.project.v2"
                and project.get("project_kind") in {"analog_ic", "mixed_signal_ic"}
                and len(project.get("modules") or []) >= 2
            )
            project_diagnostic = (
                "Qualification project must be actoviq.project.v2, use an IC project kind, and reference at least two modules."
            )
        except (OSError, ValueError, json.JSONDecodeError) as error:
            project_diagnostic = f"Cannot read qualification project: {error}"
    checks.append(check("hierarchical_ic_project", project_ok, project_diagnostic))

    pdk_ok = False
    pdk_diagnostic = "PDK scan is unavailable."
    pdk_scan_path = Path(resolved_paths["pdk_scan"]) if resolved_paths["pdk_scan"] else None
    if pdk_scan_path and pdk_scan_path.is_file():
        try:
            pdk_scan = read_json(pdk_scan_path)
            installation = pdk_scan.get("installation")
            installation = installation if isinstance(installation, dict) else pdk_scan
            pdk_id = str(installation.get("logical_id") or "")
            locked_pdk = (lock.get("open_pdks") or {}).get(pdk_id)
            locked_pdk = locked_pdk if isinstance(locked_pdk, dict) else {}
            pdk_ok = bool(
                pdk_id
                and pdk_id == str(lock.get("golden_pdk") or "")
                and str(installation.get("revision") or "")
                == str(locked_pdk.get("revision") or "")
                and installation.get("fingerprint")
                and installation.get("license_hash")
            )
            pdk_diagnostic = "PDK scan must match the locked golden PDK revision and include fingerprint/license hashes."
        except (OSError, ValueError, json.JSONDecodeError) as error:
            pdk_diagnostic = f"Cannot read PDK scan: {error}"
    checks.append(check("locked_pdk_scan", pdk_ok, pdk_diagnostic))

    ready = all(item["status"] == "passed" for item in checks)
    return {
        "schema": "actoviq.ic-qualification-preflight.v1",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "status": "ready" if ready else "blocked",
        "ready": ready,
        "environment": environment,
        "lock": {
            "schema": str(lock.get("schema") or ""),
            "golden_pdk": str(lock.get("golden_pdk") or ""),
        },
        "paths": path_status,
        "checks": checks,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lock", required=True)
    for path_id in EVIDENCE_PATHS:
        parser.add_argument(f"--{path_id.replace('_', '-')}", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    report = build_preflight(
        lock_path=Path(args.lock),
        path_values={
            path_id: str(getattr(args, path_id))
            for path_id in EVIDENCE_PATHS
        },
    )
    target = Path(args.output).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "ready": report["ready"],
        "status": report["status"],
        "output": target.name,
    }))
    return 0 if report["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
