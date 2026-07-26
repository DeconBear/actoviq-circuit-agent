#!/usr/bin/env python3
"""Local-only PDK discovery and registry for Actoviq IC projects."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


INSTALLATION_SCHEMA = "actoviq.pdk-installation.v1"
BINDING_SCHEMA = "actoviq.pdk-binding.v1"
REGISTRY_SCHEMA = "actoviq.pdk-registry.v1"
ADAPTERS: dict[str, dict[str, Any]] = {
    "ihp-sg13g2": {
        "name": "IHP SG13G2",
        "vendor": "IHP",
        "process": "SG13G2",
        "source_kind": "open",
        "license": "Apache-2.0",
        "status": "supported",
        "roots": ("ihp-sg13g2", "."),
        "views": {
            "model_library": ("libs.tech/ngspice/**/*.lib", "libs.tech/ngspice/**/*.spice"),
            "xschem": ("libs.tech/xschem",),
            "klayout": ("libs.tech/klayout",),
            "magic": ("libs.tech/magic",),
            "netgen": ("libs.tech/netgen",),
            "verilog_a": ("libs.tech/verilog-a",),
            "xyce": ("libs.tech/xyce",),
            "liberty": ("libs.ref/**/*.lib",),
            "lef": ("libs.ref/**/*.lef",),
            "gds": ("libs.ref/**/*.gds",),
        },
    },
    "sky130": {
        "name": "SkyWater SKY130",
        "vendor": "SkyWater",
        "process": "SKY130",
        "source_kind": "open",
        "license": "Apache-2.0",
        "status": "experimental",
        "roots": ("sky130A", "sky130", "."),
        "views": {
            "model_library": ("libs.tech/ngspice/*.lib.spice", "libs.tech/ngspice/**/*.spice"),
            "xschem": ("libs.tech/xschem",),
            "klayout": ("libs.tech/klayout",),
            "magic": ("libs.tech/magic",),
            "netgen": ("libs.tech/netgen",),
            "verilog_a": ("libs.tech/verilog-a",),
            "liberty": ("libs.ref/**/*.lib",),
            "lef": ("libs.ref/**/*.lef",),
            "gds": ("libs.ref/**/*.gds",),
        },
    },
    "gf180mcu": {
        "name": "GlobalFoundries GF180MCU",
        "vendor": "GlobalFoundries",
        "process": "GF180MCU",
        "source_kind": "open",
        "license": "Apache-2.0",
        "status": "experimental_archived_upstream",
        "roots": ("gf180mcuD", "gf180mcuC", "gf180mcu", "."),
        "views": {
            "model_library": ("libs.tech/ngspice/*.lib", "libs.tech/ngspice/**/*.spice"),
            "xschem": ("libs.tech/xschem",),
            "klayout": ("libs.tech/klayout",),
            "magic": ("libs.tech/magic",),
            "netgen": ("libs.tech/netgen",),
            "verilog_a": ("libs.tech/verilog-a",),
            "liberty": ("libs.ref/**/*.lib",),
            "lef": ("libs.ref/**/*.lef",),
            "gds": ("libs.ref/**/*.gds",),
        },
    },
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def registry_path(explicit: str | Path | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    configured = os.environ.get("ACTOVIQ_PDK_REGISTRY", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return Path.home() / ".actoviq" / "pdk-installations.json"


def _atomic_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False
    ) as handle:
        handle.write(content)
        temporary = Path(handle.name)
    os.replace(temporary, path)


def load_registry(path: str | Path | None = None) -> dict[str, Any]:
    target = registry_path(path)
    if not target.is_file():
        return {"schema": REGISTRY_SCHEMA, "installations": []}
    value = json.loads(target.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("schema") != REGISTRY_SCHEMA:
        raise ValueError(f"unsupported PDK registry: {target}")
    if not isinstance(value.get("installations"), list):
        raise ValueError("PDK registry installations must be an array")
    return value


def _safe_relative(root: Path, path: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def _first_existing_root(root: Path, candidates: tuple[str, ...]) -> Path:
    for candidate in candidates:
        path = (root / candidate).resolve()
        if path.is_dir():
            return path
    return root.resolve()


def _discover(root: Path, patterns: tuple[str, ...]) -> list[str]:
    matches: list[Path] = []
    for pattern in patterns:
        if any(token in pattern for token in ("*", "?", "[")):
            matches.extend(path for path in root.glob(pattern) if path.exists())
        else:
            path = root / pattern
            if path.exists():
                matches.append(path)
    unique = sorted({path.resolve() for path in matches}, key=lambda path: path.as_posix().casefold())
    return [_safe_relative(root, path) for path in unique[:256]]


def load_mapping_pack(path: str | Path) -> dict[str, Any]:
    target = Path(path).expanduser().resolve()
    value = json.loads(target.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("schema") != "actoviq.pdk-mapping-pack.v1":
        raise ValueError("commercial PDK mapping pack must use actoviq.pdk-mapping-pack.v1")
    for field in ("id", "name", "vendor", "process"):
        if not str(value.get(field) or "").strip():
            raise ValueError(f"commercial PDK mapping pack requires {field}")
    views = value.get("views")
    if not isinstance(views, dict):
        raise ValueError("commercial PDK mapping pack views must be an object")
    for patterns in views.values():
        if not isinstance(patterns, list) or not all(isinstance(pattern, str) for pattern in patterns):
            raise ValueError("mapping-pack view patterns must be string arrays")
        if any(Path(pattern).is_absolute() or ".." in Path(pattern).parts for pattern in patterns):
            raise ValueError("mapping-pack patterns must remain relative to the selected PDK root")
    return value


def scan_installation(
    root: str | Path,
    adapter_id: str,
    *,
    version: str = "",
    revision: str = "",
    mapping_file: str | Path | None = None,
) -> dict[str, Any]:
    selected_root = Path(root).expanduser().resolve()
    if not selected_root.is_dir():
        raise ValueError(f"PDK root does not exist: {selected_root}")
    if adapter_id == "commercial":
        if not mapping_file:
            raise ValueError("commercial PDK scan requires --mapping-file")
        mapping = load_mapping_pack(mapping_file)
        spec = {
            "name": mapping["name"],
            "vendor": mapping["vendor"],
            "process": mapping["process"],
            "source_kind": "commercial",
            "license": str(mapping.get("license") or "proprietary"),
            "status": "user_supplied",
            "roots": (".",),
            "views": {
                name: tuple(patterns)
                for name, patterns in mapping["views"].items()
            },
        }
        logical_id = str(mapping["id"])
    else:
        spec = ADAPTERS.get(adapter_id)
        if spec is None:
            raise ValueError(f"unsupported PDK adapter: {adapter_id}")
        logical_id = adapter_id
    pdk_root = _first_existing_root(selected_root, tuple(spec["roots"]))
    views = {
        name: _discover(pdk_root, tuple(patterns))
        for name, patterns in spec["views"].items()
    }
    capabilities = {name: bool(paths) for name, paths in views.items()}
    fingerprint_input = {
        "logical_id": logical_id,
        "version": version,
        "revision": revision,
        "views": views,
    }
    fingerprint = hashlib.sha256(
        json.dumps(fingerprint_input, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    installation_id = re.sub(r"[^a-z0-9_.-]+", "-", f"{logical_id}-{fingerprint[:12]}".casefold()).strip("-")
    return {
        "schema": INSTALLATION_SCHEMA,
        "installation_id": installation_id,
        "logical_id": logical_id,
        "name": spec["name"],
        "vendor": spec["vendor"],
        "process": spec["process"],
        "version": version,
        "revision": revision,
        "fingerprint": fingerprint,
        "root": str(pdk_root),
        "source_kind": spec["source_kind"],
        "license": spec["license"],
        "support_status": spec["status"],
        "views": views,
        "capabilities": capabilities,
        "probe_status": "available" if capabilities.get("model_library") else "partial",
        "diagnostics": [] if capabilities.get("model_library") else ["no model library was discovered"],
    }


def register_installation(
    installation: dict[str, Any],
    *,
    license_accepted: bool,
    path: str | Path | None = None,
) -> dict[str, Any]:
    if installation.get("schema") != INSTALLATION_SCHEMA:
        raise ValueError(f"installation schema must be {INSTALLATION_SCHEMA}")
    if not license_accepted:
        raise ValueError("PDK registration requires explicit license acceptance")
    registry = load_registry(path)
    saved = {**installation, "registered_at": utc_now(), "license_accepted": True}
    entries = [
        entry for entry in registry["installations"]
        if entry.get("installation_id") != saved["installation_id"]
    ]
    entries.append(saved)
    registry["installations"] = sorted(entries, key=lambda entry: str(entry["installation_id"]))
    _atomic_write(registry_path(path), registry)
    return saved


def resolve_binding(
    binding: dict[str, Any],
    *,
    path: str | Path | None = None,
) -> dict[str, Any]:
    if not isinstance(binding, dict) or binding.get("schema") != BINDING_SCHEMA:
        raise ValueError(f"PDK binding schema must be {BINDING_SCHEMA}")
    logical_id = str(binding.get("pdk_ref") or "").strip()
    if not logical_id:
        raise ValueError("PDK binding requires pdk_ref")
    expected = str(binding.get("fingerprint") or "").strip()
    matches = [
        entry for entry in load_registry(path)["installations"]
        if entry.get("logical_id") == logical_id
        and (not expected or entry.get("fingerprint") == expected)
    ]
    if not matches:
        raise ValueError(f"no local PDK installation satisfies binding: {logical_id}")
    selected = sorted(matches, key=lambda entry: str(entry.get("registered_at", "")), reverse=True)[0]
    root = Path(str(selected["root"])).resolve()
    model_paths = list((selected.get("views") or {}).get("model_library") or [])
    model_set = str(binding.get("model_set") or "").strip()
    if model_set:
        model_paths = [value for value in model_paths if model_set.casefold() in value.casefold()]
    model_library = str((root / model_paths[0]).resolve()) if model_paths else ""
    return {
        "installation": selected,
        "model_library": model_library,
        "corner": str(binding.get("default_corner") or ""),
        "temperature_c": binding.get("temperature_c"),
    }
