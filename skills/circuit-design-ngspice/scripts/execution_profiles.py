"""Resolve project simulation profiles without copying machine paths into projects."""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any


REGISTRY_SCHEMA = "actoviq.execution-profile-registry.v1"
PROFILE_SCHEMA = "actoviq.execution-profile.v1"
OPEN_SIMULATORS = {"ngspice", "xyce"}


def registry_path(path: str | Path | None = None) -> Path:
    if path:
        return Path(path).expanduser().resolve()
    configured = os.environ.get("ACTOVIQ_EXECUTION_PROFILE_REGISTRY", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return Path.home() / ".actoviq" / "execution-profiles.json"


def load_registry(path: str | Path | None = None) -> dict[str, Any]:
    target = registry_path(path)
    if not target.is_file():
        return {"schema": REGISTRY_SCHEMA, "profiles": []}
    value = json.loads(target.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("schema") != REGISTRY_SCHEMA:
        raise ValueError(f"unsupported execution profile registry: {target}")
    profiles = value.get("profiles")
    if not isinstance(profiles, list):
        raise ValueError("execution profile registry profiles must be an array")
    return value


def _resolve_executable(configured: str, fallback: str) -> str:
    candidate = configured.strip() or fallback
    located = shutil.which(candidate)
    if located:
        return str(Path(located).resolve())
    selected = Path(candidate).expanduser()
    if selected.is_file():
        return str(selected.resolve())
    raise FileNotFoundError(f"executable not found: {candidate}")


def simulation_profile_id(project: dict[str, Any]) -> str:
    profile = project.get("analog_ic_profile")
    if isinstance(profile, dict):
        configured = str(profile.get("simulation_profile_id") or "").strip()
        if configured:
            return configured
    return "ngspice-local"


def resolve_simulation_profile(
    project: dict[str, Any],
    *,
    legacy_ngspice: str = "",
    path: str | Path | None = None,
) -> dict[str, Any]:
    identifier = simulation_profile_id(project)
    registry = load_registry(path)
    stored = next(
        (entry for entry in registry["profiles"] if str(entry.get("id") or "") == identifier),
        None,
    )
    if stored is None:
        if identifier != "ngspice-local":
            raise ValueError(f"execution profile not found: {identifier}")
        return {
            "schema": PROFILE_SCHEMA,
            "id": identifier,
            "providerId": "ngspice",
            "target": "local_windows" if os.name == "nt" else "local_linux",
            "executable": _resolve_executable(legacy_ngspice, "ngspice"),
            "qualification": "configured",
            "source": "legacy_default",
        }
    if not isinstance(stored, dict) or stored.get("schema") != PROFILE_SCHEMA:
        raise ValueError(f"execution profile {identifier} has an unsupported schema")
    provider = str(stored.get("providerId") or "").strip().casefold()
    if provider not in OPEN_SIMULATORS:
        raise ValueError(
            f"execution profile {identifier} uses {provider or 'an unknown provider'}, "
            "which is not an open project simulator"
        )
    target = str(stored.get("target") or "")
    expected_target = "local_windows" if os.name == "nt" else "local_linux"
    if target != expected_target:
        raise ValueError(
            f"execution profile {identifier} targets {target}; this project runner requires {expected_target}"
        )
    fallback = "ngspice" if provider == "ngspice" else "Xyce"
    return {
        **stored,
        "providerId": provider,
        "executable": _resolve_executable(str(stored.get("executable") or ""), fallback),
        "source": "registry",
    }


def assert_profile_path(profile: dict[str, Any], value: str | Path) -> Path:
    resolved = Path(value).expanduser().resolve()
    if profile.get("source") == "legacy_default":
        return resolved
    roots = profile.get("allowedRoots")
    if not isinstance(roots, list) or not roots:
        raise ValueError(f"execution profile {profile.get('id', '')} requires allowedRoots")
    for root in roots:
        candidate = Path(str(root)).expanduser().resolve()
        try:
            resolved.relative_to(candidate)
            return resolved
        except ValueError:
            continue
    raise ValueError(f"simulation input is outside execution profile allowedRoots: {resolved}")
