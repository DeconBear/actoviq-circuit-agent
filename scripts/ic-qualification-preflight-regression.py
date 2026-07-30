#!/usr/bin/env python3
"""Deterministic positive and negative tests for IC qualification preflight."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from ic_qualification_preflight import EVIDENCE_PATHS, build_preflight


REVISION = "22f2a25f1734796de3debbbf29cf697cbbc54081"
HASH_A = "a" * 64
HASH_B = "b" * 64


def write_json(path: Path, value: object) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    return path


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="actoviq-ic-preflight-") as temporary:
        root = Path(temporary)
        lock_path = write_json(root / "lock.json", {
            "schema": "actoviq.ic-qualification-lock.v1",
            "environment": {
                "platform": "native_linux",
                "distribution": "ubuntu",
                "version": "24.04",
                "wsl": False,
            },
            "golden_pdk": "ihp-sg13g2",
            "open_pdks": {
                "ihp-sg13g2": {
                    "revision": REVISION,
                    "required": True,
                },
            },
        })
        project_root = root / "project"
        write_json(project_root / "project.circuit.json", {
            "schema": "actoviq.project.v2",
            "project_id": "native-golden",
            "project_kind": "analog_ic",
            "modules": [{"id": "top"}, {"id": "core"}],
        })
        pdk_scan = write_json(root / "pdk-scan.json", {
            "installation": {
                "logical_id": "ihp-sg13g2",
                "revision": REVISION,
                "fingerprint": HASH_A,
                "license_hash": HASH_B,
            },
        })
        path_values = {
            "project_root": str(project_root),
            "pdk_scan": str(pdk_scan),
        }
        for path_id in set(EVIDENCE_PATHS) - set(path_values):
            path = root / f"{path_id}.json"
            if path_id == "netlist":
                path.write_text("R1 in 0 1k\n", encoding="utf-8")
            else:
                write_json(path, {})
            path_values[path_id] = str(path)
        native_environment = {
            "platform": "linux",
            "release": "6.8.0-native",
            "distribution": "ubuntu",
            "distribution_version": "24.04",
            "native_linux": True,
            "wsl": False,
        }

        ready = build_preflight(
            lock_path=lock_path,
            path_values=path_values,
            environment=native_environment,
        )
        assert ready["ready"] is True
        assert {item["status"] for item in ready["checks"]} == {"passed"}

        missing_path_values = {**path_values, "xyce_run": str(root / "missing.json")}
        missing = build_preflight(
            lock_path=lock_path,
            path_values=missing_path_values,
            environment=native_environment,
        )
        assert missing["ready"] is False
        assert next(
            item for item in missing["checks"] if item["id"] == "path_xyce_run"
        )["status"] == "blocked"

        wsl_environment = {**native_environment, "native_linux": False, "wsl": True}
        wsl = build_preflight(
            lock_path=lock_path,
            path_values=path_values,
            environment=wsl_environment,
        )
        assert wsl["ready"] is False
        assert next(
            item for item in wsl["checks"] if item["id"] == "native_environment"
        )["status"] == "blocked"

        invalid_lock = json.loads(lock_path.read_text(encoding="utf-8"))
        invalid_lock["schema"] = "actoviq.ic-qualification-lock.invalid"
        invalid_lock_path = write_json(root / "invalid-lock.json", invalid_lock)
        invalid_lock_report = build_preflight(
            lock_path=invalid_lock_path,
            path_values=path_values,
            environment=native_environment,
        )
        assert invalid_lock_report["ready"] is False
        assert next(
            item for item in invalid_lock_report["checks"]
            if item["id"] == "qualification_lock"
        )["status"] == "blocked"

        mismatched_scan = json.loads(pdk_scan.read_text(encoding="utf-8"))
        mismatched_scan["installation"]["revision"] = "wrong-revision"
        write_json(pdk_scan, mismatched_scan)
        mismatched = build_preflight(
            lock_path=lock_path,
            path_values=path_values,
            environment=native_environment,
        )
        assert mismatched["ready"] is False
        assert next(
            item for item in mismatched["checks"] if item["id"] == "locked_pdk_scan"
        )["status"] == "blocked"

    print(json.dumps({
        "ok": True,
        "suite": "ic-qualification-preflight",
        "positive": "ready",
        "negative": [
            "missing_evidence",
            "wsl_ineligible",
            "invalid_lock",
            "pdk_revision_mismatch",
        ],
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
