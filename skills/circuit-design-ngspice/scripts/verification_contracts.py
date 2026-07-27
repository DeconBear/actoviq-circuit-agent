"""Small runtime validators for persisted verification and simulation results."""

from __future__ import annotations

from typing import Any


def _require_string(value: dict[str, Any], key: str) -> None:
    if not isinstance(value.get(key), str) or not str(value[key]).strip():
        raise ValueError(f"result requires non-empty {key}")


def validate_verification_run(value: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("schema") != "actoviq.verification-run.v1":
        raise ValueError("verification result must use actoviq.verification-run.v1")
    for key in ("run_id", "kind", "provider_id"):
        _require_string(value, key)
    if not isinstance(value.get("executed"), bool):
        raise ValueError("verification result executed must be boolean")
    if value.get("status") not in {"passed", "failed", "cancelled"}:
        raise ValueError("verification result status is invalid")
    diagnostics = value.get("diagnostics")
    if not isinstance(diagnostics, list) or not all(isinstance(item, str) for item in diagnostics):
        raise ValueError("verification result diagnostics must be a string array")
    artifacts = value.get("artifacts")
    if not isinstance(artifacts, list):
        raise ValueError("verification result artifacts must be an array")
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            raise ValueError("verification artifact must be an object")
        _require_string(artifact, "kind")
        _require_string(artifact, "path")
    return value


def validate_simulation_run(value: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("schema") != "actoviq.simulation.v3":
        raise ValueError("simulation result must use actoviq.simulation.v3")
    for key in ("run_id", "scope", "execution_status", "measurement_status", "specification_status"):
        _require_string(value, key)
    if not isinstance(value.get("ok"), bool):
        raise ValueError("simulation result ok must be boolean")
    verification = value.get("verification")
    if not isinstance(verification, dict):
        raise ValueError("simulation result requires verification state")
    for key in ("executed", "measured", "spec_passed", "ams_verified"):
        if not isinstance(verification.get(key), bool):
            raise ValueError(f"simulation verification {key} must be boolean")
    if verification.get("lvs_clean") not in {True, False, None}:
        raise ValueError("simulation verification lvs_clean must be boolean or null")
    if not isinstance(value.get("analyses"), list) or not isinstance(value.get("metrics"), list):
        raise ValueError("simulation result analyses and metrics must be arrays")
    return value
