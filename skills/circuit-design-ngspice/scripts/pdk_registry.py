#!/usr/bin/env python3
"""Local-only PDK discovery and registry for Vibe Analog IC projects."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


INSTALLATION_SCHEMA = "actoviq.pdk-installation.v1"
BINDING_SCHEMA = "actoviq.pdk-binding.v1"
REGISTRY_SCHEMA = "actoviq.pdk-registry.v1"
DEVICE_CATALOG_SCHEMA = "actoviq.pdk-device-catalog.v1"
INSTALL_RECEIPT_SCHEMA = "actoviq.pdk-install-receipt.v1"
OPEN_PDK_SOURCES = {
    "ihp-sg13g2": "https://github.com/IHP-GmbH/IHP-Open-PDK.git",
    "sky130": "https://github.com/google/skywater-pdk.git",
    "gf180mcu": "https://github.com/google/gf180mcu-pdk.git",
}
OPEN_PDK_HOMEPAGES = {
    "ihp-sg13g2": "https://github.com/IHP-GmbH/IHP-Open-PDK",
    "sky130": "https://github.com/google/skywater-pdk",
    "gf180mcu": "https://github.com/google/gf180mcu-pdk",
}
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

MOS_PARAMETER_CONSTRAINTS = {
    "w": {"required": True, "minimum": 0.0, "exclusive_minimum": True},
    "l": {"required": True, "minimum": 0.0, "exclusive_minimum": True},
    "m": {"required": True, "minimum": 1, "integer": True},
    "nf": {"required": True, "minimum": 1, "integer": True},
}
DEVICE_MODELS = {
    "ihp-sg13g2": {
        "nmos": "sg13_lv_nmos",
        "pmos": "sg13_lv_pmos",
    },
    "sky130": {
        "nmos": "sky130_fd_pr__nfet_01v8",
        "pmos": "sky130_fd_pr__pfet_01v8",
    },
    "gf180mcu": {
        "nmos": "gf180mcu_fd_pr__nfet_03v3",
        "pmos": "gf180mcu_fd_pr__pfet_03v3",
    },
}


def _device_catalog(logical_id: str, custom_devices: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    devices = custom_devices
    if devices is None:
        models = DEVICE_MODELS.get(logical_id, {})
        devices = [
            {
                "device_id": kind,
                "kind": kind,
                "pins": ["D", "G", "S", "B"],
                "spice": {
                    "primitive": "M",
                    "model": model,
                    "pin_order": ["D", "G", "S", "B"],
                    "format": "{name} {D} {G} {S} {B} {model} w={w} l={l}",
                },
                "parameters": MOS_PARAMETER_CONSTRAINTS,
                "views": {
                    "xschem_symbol": "",
                    "klayout_pcell": "",
                    "magic_pcell": "",
                    "generic_fallback": "mos4",
                },
                "netlist_formats": {
                    "spice": {
                        "model": model,
                        "pin_order": ["D", "G", "S", "B"],
                        "format": "{name} {D} {G} {S} {B} {model} w={w} l={l}",
                    },
                    "cdl": {
                        "model": model,
                        "pin_order": ["D", "G", "S", "B"],
                        "format": "{name} {D} {G} {S} {B} {model} w={w} l={l}",
                    },
                    "spectre": model,
                    "hspice": model,
                    "xyce": model,
                },
            }
            for kind, model in models.items()
        ]
    return {
        "schema": DEVICE_CATALOG_SCHEMA,
        "pdk_ref": logical_id,
        "devices": devices,
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


def _license_hash(root: Path) -> str:
    license_files = sorted(
        {
            path.resolve()
            for pattern in ("LICENSE", "LICENSE.*", "COPYING", "COPYING.*")
            for path in root.glob(pattern)
            if path.is_file()
        },
        key=lambda path: path.name.casefold(),
    )
    digest = hashlib.sha256()
    for path in license_files:
        digest.update(path.name.encode("utf-8"))
        digest.update(path.read_bytes())
    return digest.hexdigest() if license_files else ""


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
    devices = value.get("devices", [])
    if not isinstance(devices, list):
        raise ValueError("mapping-pack devices must be an array")
    for device in devices:
        if not isinstance(device, dict) or not str(device.get("device_id") or "").strip():
            raise ValueError("each mapping-pack device requires device_id")
        pins = device.get("pins")
        if not isinstance(pins, list) or not pins or not all(isinstance(pin, str) and pin for pin in pins):
            raise ValueError("each mapping-pack device requires a non-empty pins array")
        if not isinstance(device.get("spice"), dict) or not isinstance(device.get("views", {}), dict):
            raise ValueError("mapping-pack device spice and views must be objects")
    return value


def open_pdk_catalog() -> list[dict[str, Any]]:
    """Public metadata for Settings: official links + one-click install targets."""
    catalog: list[dict[str, Any]] = []
    for adapter_id, source_url in OPEN_PDK_SOURCES.items():
        spec = ADAPTERS[adapter_id]
        homepage = OPEN_PDK_HOMEPAGES.get(adapter_id)
        if not homepage:
            homepage = source_url[:-4] if source_url.endswith(".git") else source_url
        catalog.append({
            "adapter_id": adapter_id,
            "name": spec["name"],
            "vendor": spec["vendor"],
            "process": spec["process"],
            "license": spec["license"],
            "support_status": spec["status"],
            "source_url": source_url,
            "homepage_url": homepage,
            "notes": (
                "Experimental / large clone with recursive submodules."
                if adapter_id == "gf180mcu"
                else "Open-source PDK; clone may take several minutes and requires git."
            ),
        })
    return catalog


def install_open_pdk(
    adapter_id: str,
    destination: str | Path,
    *,
    revision: str = "",
    license_accepted: bool,
    git_bin: str = "",
) -> dict[str, Any]:
    if adapter_id not in OPEN_PDK_SOURCES:
        raise ValueError(f"open PDK installation does not support adapter: {adapter_id}")
    if not license_accepted:
        raise ValueError("open PDK installation requires explicit license acceptance")
    revision = revision.strip()
    if revision and (
        not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,159}", revision)
        or ".." in revision
    ):
        raise ValueError("PDK revision contains unsupported characters")
    target = Path(destination).expanduser().resolve()
    if target.exists() and (not target.is_dir() or any(target.iterdir())):
        raise ValueError(f"PDK install destination must be absent or empty: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    candidate = git_bin.strip() or "git"
    executable = shutil.which(candidate)
    if not executable and Path(candidate).expanduser().is_file():
        executable = str(Path(candidate).expanduser().resolve())
    if not executable:
        raise FileNotFoundError(f"git executable not found: {candidate}")
    source_url = OPEN_PDK_SOURCES[adapter_id]
    runner = [sys.executable, executable] if Path(executable).suffix.casefold() == ".py" else [executable]
    commands = [
        [*runner, "clone", "--filter=blob:none", source_url, str(target)],
    ]
    if revision:
        commands.append([*runner, "-C", str(target), "checkout", "--detach", revision])
    commands.append([*runner, "-C", str(target), "submodule", "update", "--init", "--recursive"])
    logs: list[str] = []
    for command in commands:
        completed = subprocess.run(
            command,
            cwd=str(target.parent),
            shell=False,
            check=False,
            capture_output=True,
            text=True,
            timeout=3600,
        )
        logs.extend(text for text in (completed.stdout.strip(), completed.stderr.strip()) if text)
        if completed.returncode != 0:
            raise RuntimeError(
                f"PDK source installation failed with exit code {completed.returncode}: "
                f"{logs[-1] if logs else 'no diagnostics'}"
            )
    resolved_revision = subprocess.run(
        [*runner, "-C", str(target), "rev-parse", "HEAD"],
        cwd=str(target.parent),
        shell=False,
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    ).stdout.strip()
    receipt = {
        "schema": INSTALL_RECEIPT_SCHEMA,
        "adapter_id": adapter_id,
        "source_url": source_url,
        "requested_revision": revision,
        "resolved_revision": resolved_revision,
        "destination": str(target),
        "license": ADAPTERS[adapter_id]["license"],
        "license_accepted": True,
        "installed_at": utc_now(),
        "log": logs,
    }
    _atomic_write(target / ".actoviq-install.json", receipt)
    return receipt


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
        custom_devices = list(mapping.get("devices") or [])
    else:
        spec = ADAPTERS.get(adapter_id)
        if spec is None:
            raise ValueError(f"unsupported PDK adapter: {adapter_id}")
        logical_id = adapter_id
        custom_devices = None
    pdk_root = _first_existing_root(selected_root, tuple(spec["roots"]))
    receipt_path = selected_root / ".actoviq-install.json"
    receipt: dict[str, Any] = {}
    if receipt_path.is_file():
        candidate_receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        if (
            isinstance(candidate_receipt, dict)
            and candidate_receipt.get("schema") == INSTALL_RECEIPT_SCHEMA
            and candidate_receipt.get("adapter_id") == logical_id
        ):
            receipt = candidate_receipt
            revision = revision or str(receipt.get("resolved_revision") or "")
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
        "license_hash": _license_hash(pdk_root) or _license_hash(selected_root),
        "source": {
            "url": str(receipt.get("source_url") or ""),
            "requested_revision": str(receipt.get("requested_revision") or ""),
            "receipt": _safe_relative(selected_root, receipt_path) if receipt else "",
        },
        "support_status": spec["status"],
        "views": views,
        "capabilities": capabilities,
        "device_catalog": _device_catalog(logical_id, custom_devices),
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
