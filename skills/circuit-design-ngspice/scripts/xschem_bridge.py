#!/usr/bin/env python3
"""Controlled Xschem export/pull support with explicit ownership modes."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any
from verification_contracts import validate_verification_run
from module_hierarchy import (
    compare_ordered_pin_nets,
    ordered_connectivity_hash,
    spice_name_for_subckt,
)


BINDING_SCHEMA = "actoviq.schematic-peer-binding.v1"
SIDECAR_SCHEMA = "actoviq.xschem-sidecar.v1"
MODES = {"native", "bridge", "external"}
SAFE_PARAMETERS = {"w", "l", "m", "nf"}
COMPONENT_RE = re.compile(
    r"^\s*C\s+\{([^}]*)\}\s+([-+.\deE]+)\s+([-+.\deE]+)\s+(\d+)\s+(\d+)\s+\{(.*)\}\s*$"
)
WIRE_RE = re.compile(
    r"^\s*N\s+([-+.\deE]+)\s+([-+.\deE]+)\s+([-+.\deE]+)\s+([-+.\deE]+)\s+\{(.*)\}\s*$"
)

# Relative pin centers for stock xschem devices (origin = component placement).
_SYMBOL_PIN_OFFSETS: dict[str, dict[str, tuple[float, float]]] = {
    "devices/res.sym": {"a": (0.0, -30.0), "1": (0.0, -30.0), "b": (0.0, 30.0), "2": (0.0, 30.0)},
    "devices/capa.sym": {"a": (0.0, -30.0), "1": (0.0, -30.0), "p": (0.0, -30.0), "b": (0.0, 30.0), "2": (0.0, 30.0), "m": (0.0, 30.0)},
    "devices/ind.sym": {"a": (0.0, -30.0), "1": (0.0, -30.0), "b": (0.0, 30.0), "2": (0.0, 30.0)},
    "devices/diode.sym": {"a": (0.0, -20.0), "A": (0.0, -20.0), "b": (0.0, 20.0), "K": (0.0, 20.0)},
    "devices/vsource.sym": {"p": (0.0, -30.0), "+": (0.0, -30.0), "n": (0.0, 30.0), "-": (0.0, 30.0)},
    "devices/isource.sym": {"p": (0.0, -30.0), "+": (0.0, -30.0), "n": (0.0, 30.0), "-": (0.0, 30.0)},
    "devices/nmos4.sym": {"D": (20.0, -30.0), "G": (-20.0, 0.0), "S": (20.0, 30.0), "B": (20.0, 0.0)},
    "devices/pmos4.sym": {"D": (20.0, 30.0), "G": (-20.0, 0.0), "S": (20.0, -30.0), "B": (20.0, 0.0)},
}


def _rotate_offset(dx: float, dy: float, rotation_steps: int) -> tuple[float, float]:
    steps = rotation_steps % 4
    if steps == 1:
        return -dy, dx
    if steps == 2:
        return -dx, -dy
    if steps == 3:
        return dy, -dx
    return dx, dy


def default_xschem_library_path() -> Path | None:
    executable = shutil.which("xschem")
    candidates: list[Path] = []
    if executable:
        prefix = Path(executable).resolve().parent.parent
        candidates.append(prefix / "share" / "xschem" / "xschem_library")
    candidates.append(Path("/usr/share/xschem/xschem_library"))
    for candidate in candidates:
        if (candidate / "devices").is_dir():
            return candidate
    return None


def _ensure_xschem_rc(run_root: Path) -> Path | None:
    library = default_xschem_library_path()
    if library is None:
        return None
    rcfile = run_root / "xschemrc"
    rcfile.write_text(
        f"set XSCHEM_LIBRARY_PATH [list {{{library}}}]\n",
        encoding="utf-8",
    )
    return rcfile


def _canonical_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def module_hash(module: dict[str, Any]) -> str:
    return _canonical_hash({
        "module_id": module.get("module_id"),
        "ports": module.get("ports", []),
        "components": module.get("components", []),
        "nets": module.get("nets", []),
        "wires": module.get("wires", []),
    })


def connectivity_hash(module: dict[str, Any]) -> str:
    return ordered_connectivity_hash(module)


def compare_reference_netlist(module: dict[str, Any], netlist_text: str) -> dict[str, Any]:
    actual_instances: dict[str, list[str]] = {}
    subcircuit_ports: list[str] | None = None
    for raw_line in netlist_text.splitlines():
        line = raw_line.strip()
        if not line or line[0] in {"*", ";", "+", "."}:
            if line.casefold().startswith(".subckt "):
                tokens = line.split()
                subcircuit_ports = [token.casefold() for token in tokens[2:]]
            continue
        try:
            tokens = shlex.split(line, posix=True)
        except ValueError:
            tokens = line.split()
        if len(tokens) >= 2:
            # Drop trailing model/param tokens for leaf instances by keeping only
            # as many nodes as the schematic instance declares.
            actual_instances[tokens[0].casefold()] = [token.casefold() for token in tokens[1:]]

    expected_by_instance: dict[str, list[str]] = {}
    for component in module.get("components", []):
        name = str(component.get("name") or component.get("id") or "").strip()
        if not name:
            continue
        expected_by_instance[name] = [
            str(pin.get("net") or pin.get("net_id") or "").strip().casefold()
            for pin in component.get("pins", [])
            if str(pin.get("net") or pin.get("net_id") or "").strip()
        ]

    # Trim actual nodes to expected pin arity before order-sensitive compare.
    trimmed_actual: dict[str, list[str]] = {}
    for name, expected in expected_by_instance.items():
        actual = actual_instances.get(name.casefold())
        if actual is None:
            continue
        trimmed_actual[name.casefold()] = actual[: len(expected)]

    comparison = compare_ordered_pin_nets(expected_by_instance, trimmed_actual)
    diagnostics = list(comparison["diagnostics"])

    expected_ports = [
        str(port.get("net") or port.get("name") or "").strip().casefold()
        for port in module.get("ports", [])
        if str(port.get("net") or port.get("name") or "").strip()
    ]
    if subcircuit_ports is not None and subcircuit_ports != expected_ports:
        diagnostics.append(
            f"subcircuit ports differ: expected {expected_ports}, reference has {subcircuit_ports}"
        )
    return {
        "ok": not diagnostics,
        "source_connectivity_hash": connectivity_hash(module),
        "compared_instance_count": comparison["compared_instance_count"],
        "expected_instance_count": len(module.get("components", [])),
        "diagnostics": diagnostics,
    }


def _atomic_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False
    ) as handle:
        handle.write(content)
        temporary = Path(handle.name)
    os.replace(temporary, path)


def _atomic_json(path: Path, value: Any) -> None:
    _atomic_text(path, json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n")


def sidecar_path(peer_file: Path) -> Path:
    return peer_file.with_suffix(peer_file.suffix + ".actoviq.json")


def validate_binding(binding: Any) -> dict[str, Any]:
    if not isinstance(binding, dict) or binding.get("schema") != BINDING_SCHEMA:
        raise ValueError(f"schematic peer binding must use {BINDING_SCHEMA}")
    mode = str(binding.get("mode") or "")
    if mode not in MODES:
        raise ValueError(f"schematic peer mode must be one of {sorted(MODES)}")
    peer_file = str(binding.get("peer_file") or "").strip()
    if mode != "native" and not peer_file:
        raise ValueError(f"xschem {mode} mode requires peer_file")
    if peer_file and Path(peer_file).suffix.casefold() != ".sch":
        raise ValueError("Xschem peer file must use .sch")
    return json.loads(json.dumps(binding))


def make_binding(mode: str, peer_file: str = "") -> dict[str, Any]:
    return validate_binding({
        "schema": BINDING_SCHEMA,
        "peer_kind": "xschem",
        "mode": mode,
        "peer_file": str(Path(peer_file).expanduser().resolve()) if peer_file else "",
        "base_module_hash": "",
        "base_peer_hash": "",
        "base_connectivity_hash": "",
    })


def headless_validate(
    schematic_file: Path,
    run_root: Path,
    executable: str = "",
    source_module: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Validate an exported Xschem ``.sch`` against a module (Import/Export handoff).

    ``schematic_file`` is a file produced by ``schematic-export`` / ``render_xschem``,
    not a live peer binding. Topology is never written back.
    """
    peer = schematic_file.expanduser().resolve()
    if not peer.is_file() or peer.suffix.casefold() != ".sch":
        raise ValueError(f"Xschem validation requires an existing .sch file: {peer}")
    candidate = executable.strip() or "xschem"
    located = shutil.which(candidate)
    resolved_executable = str(Path(located).resolve()) if located else str(Path(candidate).expanduser().resolve())
    if not Path(resolved_executable).is_file():
        raise FileNotFoundError(f"Xschem executable not found: {candidate}")
    run_root = run_root.expanduser().resolve()
    run_root.mkdir(parents=True, exist_ok=True)
    netlist = run_root / "reference.spice"
    command = [
        resolved_executable,
        "-n",
        "-q",
        "-x",
        "-o",
        str(run_root),
        "-N",
        netlist.name,
        "-s",
        str(peer),
    ]
    rcfile = _ensure_xschem_rc(run_root)
    if rcfile is not None:
        command[1:1] = ["--rcfile", str(rcfile)]
    env = os.environ.copy()
    library = default_xschem_library_path()
    if library is not None:
        env["XSCHEM_LIBRARY_PATH"] = str(library)
    if Path(resolved_executable).suffix.casefold() == ".py":
        command = [sys.executable, *command]
    completed = subprocess.run(
        command,
        cwd=str(run_root),
        shell=False,
        check=False,
        capture_output=True,
        text=True,
        timeout=120,
        env=env,
    )
    diagnostics = [
        text for text in (completed.stdout.strip(), completed.stderr.strip()) if text
    ]
    comparison = (
        compare_reference_netlist(
            source_module,
            netlist.read_text(encoding="utf-8", errors="replace"),
        )
        if source_module is not None and netlist.is_file()
        else None
    )
    if comparison:
        diagnostics.extend(comparison["diagnostics"])
    success = completed.returncode == 0 and netlist.is_file() and (
        comparison is None or comparison["ok"]
    )
    artifacts = [{"kind": "xschem_schematic", "path": str(peer), "hash": file_hash(peer)}]
    if netlist.is_file():
        artifacts.append({"kind": "reference_netlist", "path": str(netlist), "hash": file_hash(netlist)})
    result = validate_verification_run({
        "schema": "actoviq.verification-run.v1",
        "run_id": run_root.name,
        "kind": "schematic_export_reference_netlist",
        "provider_id": "xschem",
        "executed": True,
        "status": "passed" if success else "failed",
        "diagnostics": diagnostics,
        "artifacts": artifacts,
        "metadata": {
            "handoff": "schematic-export",
            "schematic_path": str(peer),
            "peer_hash": file_hash(peer),  # retained for older consumers
            "reference_netlist_hash": file_hash(netlist) if netlist.is_file() else "",
            "connectivity_comparison": comparison,
            "source_module_id": str(source_module.get("module_id") or "") if source_module else "",
            "source_module_hash": module_hash(source_module) if source_module else "",
            "source_connectivity_hash": connectivity_hash(source_module) if source_module else "",
            "topology_writeback": False,
        },
    })
    _atomic_json(run_root / "run.json", result)
    return result


def _safe_property(value: Any) -> str:
    return str(value or "").replace("\\", "\\\\").replace('"', '\\"').replace("\r", " ").replace("\n", " ")


def _component_symbol(component: dict[str, Any]) -> str:
    eda = component.get("eda") if isinstance(component.get("eda"), dict) else {}
    configured = str(eda.get("xschem_symbol") or "").strip()
    if configured:
        return configured
    component_type = str(component.get("type") or "BLOCK").casefold()
    standard = {
        "r": "devices/res.sym",
        "c": "devices/capa.sym",
        "l": "devices/ind.sym",
        "d": "devices/diode.sym",
        "m": "devices/nmos4.sym",
        "q": "devices/npn.sym",
        "v": "devices/vsource.sym",
        "i": "devices/isource.sym",
        "module": "devices/subcircuit.sym",
        "block": "devices/subcircuit.sym",
    }
    return standard.get(component_type, "devices/subcircuit.sym")


def render_xschem(module: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    lines = [
        "v {xschem version=3.4.5 file_version=1.2}",
        "G {}",
        "K {}",
        "V {}",
        "S {}",
        "E {}",
    ]
    components: dict[str, Any] = {}
    lab_index = 0
    for component in module.get("components", []):
        stable_id = str(component.get("stable_id") or component.get("id") or "").strip()
        if not stable_id:
            raise ValueError("all Xschem-exported components require stable_id")
        position = component.get("position") or {}
        x = float(position.get("x", 0))
        y = float(position.get("y", 0))
        rotation = int(round(float(component.get("rotation", 0)) / 90.0)) % 4
        symbol = _component_symbol(component)
        name = _safe_property(component.get("name") or component.get("id"))
        value = _safe_property(component.get("value"))
        props = [
            f'name="{name}"',
            f'value="{value}"',
            f'ACTOVIQ_ID="{_safe_property(stable_id)}"',
        ]
        if str(component.get("type") or "").upper() == "MODULE":
            child_id = str((component.get("module_ref") or {}).get("module_id") or component.get("value") or "")
            props.append(f'ACTOVIQ_MODULE_REF="{_safe_property(child_id)}"')
            props.append(f'ACTOVIQ_SUBCKT="{_safe_property(spice_name_for_subckt(child_id))}"')
        lines.append(
            f'C {{{symbol}}} {x:.3f} {y:.3f} {rotation} 0 {{{" ".join(props)}}}'
        )
        # Emit net labels at known pin offsets so headless xschem can resolve connectivity.
        pin_offsets = None
        for key, value_offsets in _SYMBOL_PIN_OFFSETS.items():
            if key.casefold() == symbol.casefold():
                pin_offsets = value_offsets
                break
        if pin_offsets:
            for pin in component.get("pins", []) or []:
                net = str(pin.get("net") or "").strip()
                if not net:
                    continue
                pin_key = str(pin.get("id") or pin.get("name") or "").strip()
                offset = pin_offsets.get(pin_key)
                if offset is None:
                    for alias, candidate in pin_offsets.items():
                        if alias.casefold() == pin_key.casefold():
                            offset = candidate
                            break
                if offset is None:
                    continue
                dx, dy = _rotate_offset(offset[0], offset[1], rotation)
                lab_index += 1
                lab_name = f"lab_{stable_id}_{pin_key}_{lab_index}".replace("-", "_")
                # Flip=1 when label sits on the lower/right side so text stays readable.
                flip = 1 if dy > 0 or dx < 0 else 0
                lines.append(
                    f'C {{devices/lab_pin.sym}} {x + dx:.3f} {y + dy:.3f} 0 {flip} '
                    f'{{name="{_safe_property(lab_name)}" lab="{_safe_property(net)}"}}'
                )
        components[stable_id] = {
            "component_id": component.get("id"),
            "symbol": symbol,
            "type": component.get("type"),
            "module_ref": (component.get("module_ref") or {}).get("module_id"),
        }
    wires: dict[str, Any] = {}
    for wire in module.get("wires", []):
        wire_id = str(wire.get("id") or "").strip()
        points = wire.get("points") or []
        if not wire_id or len(points) < 2:
            continue
        net = str(wire.get("net") or "")
        net_id = str(wire.get("net_id") or net)
        for segment_index, (start, end) in enumerate(zip(points, points[1:])):
            lines.append(
                f'N {float(start["x"]):.3f} {float(start["y"]):.3f} '
                f'{float(end["x"]):.3f} {float(end["y"]):.3f} '
                f'{{lab="{_safe_property(net)}" ACTOVIQ_NET_ID="{_safe_property(net_id)}" '
                f'ACTOVIQ_WIRE_ID="{_safe_property(wire_id)}" ACTOVIQ_SEGMENT="{segment_index}"}}'
            )
        wires[wire_id] = {"segment_count": len(points) - 1, "net_id": net_id}
    return "\n".join(lines) + "\n", {
        "components": components,
        "wires": wires,
    }


def push(module: dict[str, Any], binding: dict[str, Any], source_revision: int) -> dict[str, Any]:
    binding = validate_binding(binding)
    if binding["mode"] == "external":
        raise ValueError("cannot push Vibe Analog content while Xschem is authoritative")
    peer_file = Path(str(binding.get("peer_file") or "")).expanduser().resolve()
    if not str(binding.get("peer_file") or ""):
        raise ValueError("Xschem push requires peer_file")
    content, identity = render_xschem(module)
    _atomic_text(peer_file, content)
    peer_digest = file_hash(peer_file)
    next_binding = {
        **binding,
        "base_module_hash": module_hash(module),
        "base_peer_hash": peer_digest,
        "base_connectivity_hash": connectivity_hash(module),
    }
    sidecar = {
        "schema": SIDECAR_SCHEMA,
        "module_id": module.get("module_id"),
        "source_revision": source_revision,
        "module_hash": next_binding["base_module_hash"],
        "peer_hash": peer_digest,
        "connectivity_hash": next_binding["base_connectivity_hash"],
        **identity,
    }
    _atomic_json(sidecar_path(peer_file), sidecar)
    return {
        "ok": True,
        "peer_file": str(peer_file),
        "sidecar": str(sidecar_path(peer_file)),
        "binding": next_binding,
        "connectivity_hash": next_binding["base_connectivity_hash"],
    }


def link_existing(module: dict[str, Any], binding: dict[str, Any], source_revision: int) -> dict[str, Any]:
    """Link an existing ID-bearing Xschem file without overwriting it."""
    binding = validate_binding(binding)
    peer_file = Path(binding["peer_file"]).expanduser().resolve()
    if not peer_file.is_file():
        raise ValueError(f"Xschem peer file does not exist: {peer_file}")
    parsed = parse_xschem(peer_file)
    local_ids = {
        str(component.get("stable_id") or component.get("id"))
        for component in module.get("components", [])
    }
    local_wire_ids = {
        str(wire.get("id")) for wire in module.get("wires", []) if wire.get("id")
    }
    if set(parsed["components"]) != local_ids or set(parsed["wires"]) != local_wire_ids:
        raise ValueError(
            "existing Xschem file must carry matching ACTOVIQ_ID and ACTOVIQ_WIRE_ID properties"
        )
    _rendered, identity = render_xschem(module)
    digest = file_hash(peer_file)
    next_binding = {
        **binding,
        "base_module_hash": module_hash(module),
        "base_peer_hash": digest,
        "base_connectivity_hash": connectivity_hash(module),
    }
    _atomic_json(sidecar_path(peer_file), {
        "schema": SIDECAR_SCHEMA,
        "module_id": module.get("module_id"),
        "source_revision": source_revision,
        "module_hash": next_binding["base_module_hash"],
        "peer_hash": digest,
        "connectivity_hash": next_binding["base_connectivity_hash"],
        **identity,
    })
    return {
        "ok": True,
        "peer_file": str(peer_file),
        "sidecar": str(sidecar_path(peer_file)),
        "binding": next_binding,
    }


def _properties(source: str) -> dict[str, str]:
    try:
        tokens = shlex.split(source, posix=True)
    except ValueError:
        tokens = source.split()
    result: dict[str, str] = {}
    for token in tokens:
        if "=" not in token:
            continue
        key, value = token.split("=", 1)
        result[key] = value.strip('"')
    return result


def parse_xschem(peer_file: Path) -> dict[str, Any]:
    components: dict[str, Any] = {}
    wire_segments: dict[str, dict[int, tuple[dict[str, float], dict[str, float]]]] = {}
    unknown_records: list[str] = []
    for raw in peer_file.read_text(encoding="utf-8", errors="replace").splitlines():
        component = COMPONENT_RE.match(raw)
        if component:
            props = _properties(component.group(6))
            stable_id = props.get("ACTOVIQ_ID", "")
            if stable_id:
                components[stable_id] = {
                    "symbol": component.group(1),
                    "x": float(component.group(2)),
                    "y": float(component.group(3)),
                    "rotation": (int(component.group(4)) % 4) * 90,
                    "name": props.get("name", ""),
                    "value": props.get("value", ""),
                }
            continue
        wire = WIRE_RE.match(raw)
        if wire:
            props = _properties(wire.group(5))
            wire_id = props.get("ACTOVIQ_WIRE_ID", "")
            if wire_id:
                segment = int(props.get("ACTOVIQ_SEGMENT", "0"))
                wire_segments.setdefault(wire_id, {})[segment] = (
                    {"x": float(wire.group(1)), "y": float(wire.group(2))},
                    {"x": float(wire.group(3)), "y": float(wire.group(4))},
                )
            continue
        if raw[:1] not in {"v", "G", "K", "V", "S", "E"}:
            unknown_records.append(raw)
    wires: dict[str, list[dict[str, float]]] = {}
    for wire_id, segments in wire_segments.items():
        ordered = [segments[index] for index in sorted(segments)]
        if ordered:
            wires[wire_id] = [ordered[0][0], *[segment[1] for segment in ordered]]
    return {"components": components, "wires": wires, "unknown_records": unknown_records}


def _assignments(value: str) -> dict[str, str]:
    return {
        name.casefold(): raw
        for name, raw in re.findall(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\s]+)", value)
    }


def _merge_safe_parameters(local: str, peer: str) -> str:
    peer_values = _assignments(peer)
    result = local
    for key in SAFE_PARAMETERS:
        if key not in peer_values:
            continue
        pattern = re.compile(rf"(?i)(\b{re.escape(key)}\s*=\s*)[^\s]+")
        if pattern.search(result):
            result = pattern.sub(lambda match: f"{match.group(1)}{peer_values[key]}", result)
    return result


def pull(module: dict[str, Any], binding: dict[str, Any]) -> dict[str, Any]:
    binding = validate_binding(binding)
    if binding["mode"] == "native":
        raise ValueError("native mode does not pull Xschem edits")
    peer_file = Path(binding["peer_file"]).expanduser().resolve()
    sidecar_file = sidecar_path(peer_file)
    if not peer_file.is_file() or not sidecar_file.is_file():
        raise ValueError("Xschem pull requires a peer file and Vibe Analog sidecar from an earlier push/link")
    sidecar = json.loads(sidecar_file.read_text(encoding="utf-8"))
    if sidecar.get("schema") != SIDECAR_SCHEMA:
        raise ValueError("unsupported Xschem sidecar")
    parsed = parse_xschem(peer_file)
    conflicts: list[dict[str, Any]] = []
    local_changed = module_hash(module) != str(binding.get("base_module_hash") or sidecar.get("module_hash"))
    peer_changed = file_hash(peer_file) != str(binding.get("base_peer_hash") or sidecar.get("peer_hash"))
    if local_changed and peer_changed:
        conflicts.append({"kind": "concurrent_edit", "message": "Vibe Analog and Xschem both changed since the sync base"})

    local_components = {
        str(component.get("stable_id") or component.get("id")): component
        for component in module.get("components", [])
    }
    if set(local_components) != set(parsed["components"]):
        conflicts.append({"kind": "topology", "field": "components", "message": "component identities changed"})
    local_wires = {str(wire.get("id")): wire for wire in module.get("wires", []) if wire.get("id")}
    if set(local_wires) != set(parsed["wires"]):
        conflicts.append({"kind": "topology", "field": "wires", "message": "wire identities changed"})
    for stable_id in set(local_components) & set(parsed["components"]):
        expected = (sidecar.get("components") or {}).get(stable_id, {})
        if parsed["components"][stable_id]["symbol"] != expected.get("symbol"):
            conflicts.append({
                "kind": "topology",
                "component": stable_id,
                "field": "symbol",
                "message": "Xschem symbol changed",
            })
    if conflicts:
        return {
            "ok": True,
            "requires_review": True,
            "conflicts": conflicts,
            "updated_module": None,
            "opaque_record_count": len(parsed["unknown_records"]),
        }

    updated = json.loads(json.dumps(module))
    updated_components = {
        str(component.get("stable_id") or component.get("id")): component
        for component in updated.get("components", [])
    }
    applied: list[str] = []
    for stable_id, peer in parsed["components"].items():
        component = updated_components[stable_id]
        position = {"x": peer["x"], "y": peer["y"]}
        if component.get("position") != position:
            component["position"] = position
            applied.append(f"component:{stable_id}:position")
        if int(component.get("rotation", 0)) != peer["rotation"]:
            component["rotation"] = peer["rotation"]
            applied.append(f"component:{stable_id}:rotation")
        value = _merge_safe_parameters(str(component.get("value") or ""), peer["value"])
        if value != component.get("value"):
            component["value"] = value
            applied.append(f"component:{stable_id}:geometry")
    updated_wires = {str(wire.get("id")): wire for wire in updated.get("wires", []) if wire.get("id")}
    for wire_id, points in parsed["wires"].items():
        if updated_wires[wire_id].get("points") != points:
            updated_wires[wire_id]["points"] = points
            applied.append(f"wire:{wire_id}:geometry")
    next_binding = {
        **binding,
        "base_module_hash": module_hash(updated),
        "base_peer_hash": file_hash(peer_file),
        "base_connectivity_hash": connectivity_hash(updated),
    }
    updated["schematic_peer"] = next_binding
    return {
        "ok": True,
        "requires_review": False,
        "conflicts": [],
        "applied": applied,
        "updated_module": updated,
        "binding": next_binding,
        "opaque_record_count": len(parsed["unknown_records"]),
    }
