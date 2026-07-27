#!/usr/bin/env python3
"""Verilog-2005 simulation/synthesis and explicit mixed-signal contracts."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from verification_contracts import validate_verification_run


HDL_SCHEMA = "actoviq.hdl-manifest.v1"
MIXED_SCHEMA = "actoviq.mixed-signal-contract.v1"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def _hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _combined_hash(paths: list[Path]) -> str:
    digest = hashlib.sha256()
    for path in sorted(paths, key=lambda item: str(item)):
        digest.update(str(path).encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _resolve_executable(configured: str, fallback: str) -> str:
    candidate = configured.strip() if configured else fallback
    located = shutil.which(candidate)
    if located:
        return str(Path(located).resolve())
    path = Path(candidate).expanduser()
    if path.is_file():
        return str(path.resolve())
    raise FileNotFoundError(f"executable not found: {candidate}")


def _command(executable: str, arguments: list[str]) -> list[str]:
    if Path(executable).suffix.casefold() == ".py":
        return [sys.executable, executable, *arguments]
    return [executable, *arguments]


def _run(
    executable: str,
    arguments: list[str],
    cwd: Path,
    timeout_seconds: float = 300.0,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        _command(executable, arguments),
        cwd=str(cwd),
        shell=False,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )


def _resolve_project_path(project_root: Path, value: str, label: str) -> Path:
    root = project_root.expanduser().resolve()
    candidate = (root / value).resolve() if not Path(value).is_absolute() else Path(value).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise ValueError(f"{label} must stay inside the project: {value}") from error
    if not candidate.is_file():
        raise ValueError(f"{label} does not exist: {candidate}")
    return candidate


def _resolve_project_directory(project_root: Path, value: str, label: str) -> Path:
    root = project_root.expanduser().resolve()
    candidate = (root / value).resolve() if not Path(value).is_absolute() else Path(value).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise ValueError(f"{label} must stay inside the project: {value}") from error
    if not candidate.is_dir():
        raise ValueError(f"{label} does not exist: {candidate}")
    return candidate


def load_hdl_manifest(project_root: Path, manifest_path: Path | None = None) -> dict[str, Any]:
    root = project_root.expanduser().resolve()
    path = (manifest_path or root / "hdl" / "manifest.json").expanduser().resolve()
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("schema") != HDL_SCHEMA:
        raise ValueError(f"HDL manifest must use {HDL_SCHEMA}")
    if manifest.get("language", "verilog-2005") != "verilog-2005":
        raise ValueError("first release supports language=verilog-2005 only")
    source_sets = manifest.get("source_sets")
    if not isinstance(source_sets, list) or not source_sets:
        raise ValueError("HDL manifest requires at least one source_set")
    ids: set[str] = set()
    for source_set in source_sets:
        identifier = str(source_set.get("id") or "").strip()
        top = str(source_set.get("top") or "").strip()
        if not identifier or identifier in ids:
            raise ValueError("HDL source_set ids must be non-empty and unique")
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_$]*", top):
            raise ValueError(f"invalid Verilog top module: {top}")
        sources = source_set.get("sources")
        if not isinstance(sources, list) or not sources:
            raise ValueError(f"source_set {identifier} requires sources")
        ids.add(identifier)
    active = str(manifest.get("active_source_set") or source_sets[0]["id"])
    if active not in ids:
        raise ValueError(f"unknown active_source_set: {active}")
    return manifest


def _source_set(manifest: dict[str, Any], identifier: str = "") -> dict[str, Any]:
    selected = identifier or str(manifest.get("active_source_set") or "")
    for source_set in manifest["source_sets"]:
        if source_set["id"] == selected or (not selected and source_set is manifest["source_sets"][0]):
            return source_set
    raise ValueError(f"unknown HDL source_set: {selected}")


def _source_paths(
    project_root: Path,
    source_set: dict[str, Any],
    include_testbench: bool,
) -> list[Path]:
    sources = [
        _resolve_project_path(project_root, str(value), "HDL source")
        for value in source_set.get("sources", [])
    ]
    if include_testbench and source_set.get("testbench"):
        sources.append(_resolve_project_path(project_root, str(source_set["testbench"]), "testbench"))
    return sources


def _verification(
    run_id: str,
    kind: str,
    provider: str,
    success: bool,
    diagnostics: list[str],
    artifacts: list[dict[str, str]],
    metadata: dict[str, Any],
) -> dict[str, Any]:
    return validate_verification_run({
        "schema": "actoviq.verification-run.v1",
        "run_id": run_id,
        "kind": kind,
        "provider_id": provider,
        "executed": True,
        "status": "passed" if success else "failed",
        "diagnostics": diagnostics,
        "artifacts": artifacts,
        "metadata": metadata,
        "finished_at": _utc_now(),
    })


class IcarusProvider:
    provider_id = "icarus"

    def __init__(self, iverilog: str = "", vvp: str = ""):
        self.iverilog = _resolve_executable(iverilog, "iverilog")
        self.vvp = _resolve_executable(vvp, "vvp")

    def simulate(
        self,
        project_root: Path,
        manifest: dict[str, Any],
        run_root: Path,
        source_set_id: str = "",
        design_sources: list[Path] | None = None,
    ) -> dict[str, Any]:
        source_set = _source_set(manifest, source_set_id)
        sources = (
            [path.expanduser().resolve() for path in design_sources]
            if design_sources is not None
            else _source_paths(project_root, source_set, include_testbench=False)
        )
        if source_set.get("testbench"):
            sources.append(
                _resolve_project_path(project_root, str(source_set["testbench"]), "testbench")
            )
        includes = [
            _resolve_project_directory(project_root, str(path), "include path")
            for path in source_set.get("include_paths", [])
        ]
        defines = source_set.get("defines", {})
        if not isinstance(defines, dict):
            raise ValueError("defines must be an object")
        run_root = run_root.expanduser().resolve()
        run_root.mkdir(parents=True, exist_ok=True)
        output = run_root / "simulation.vvp"
        simulation_top = str(source_set.get("testbench_top") or source_set["top"])
        arguments = ["-g2005", "-o", str(output), "-s", simulation_top]
        for include in includes:
            arguments.extend(["-I", str(include)])
        for key, value in sorted(defines.items()):
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_$]*", str(key)):
                raise ValueError(f"invalid Verilog define: {key}")
            arguments.append(f"-D{key}={value}")
        arguments.extend(str(path) for path in sources)
        compile_run = _run(self.iverilog, arguments, run_root)
        simulation_run = None
        if compile_run.returncode == 0:
            simulation_run = _run(self.vvp, [str(output)], run_root)
        success = bool(simulation_run and simulation_run.returncode == 0)
        diagnostics = [
            text for text in (
                compile_run.stdout.strip(),
                compile_run.stderr.strip(),
                simulation_run.stdout.strip() if simulation_run else "",
                simulation_run.stderr.strip() if simulation_run else "",
            ) if text
        ]
        artifacts: list[dict[str, str]] = []
        for kind, path in (("icarus_image", output),):
            if path.is_file():
                artifacts.append({"kind": kind, "path": str(path), "hash": _hash(path)})
        for path in sorted(run_root.glob("*.vcd")) + sorted(run_root.glob("*.fst")):
            artifacts.append({"kind": "waveform", "path": str(path), "hash": _hash(path)})
        result = _verification(
            run_root.name,
            "hdl_simulation",
            self.provider_id,
            success,
            diagnostics,
            artifacts,
            {
                "language": "verilog-2005",
                "top": simulation_top,
                "source_hash": _combined_hash(sources),
                "compile_exit_code": compile_run.returncode,
                "simulation_exit_code": simulation_run.returncode if simulation_run else None,
                "domain_verified": success,
                "ams_verified": False,
            },
        )
        _atomic_json(run_root / "run.json", result)
        return result


def run_gate_regression(
    project_root: Path,
    manifest: dict[str, Any],
    synthesis_run: dict[str, Any],
    run_root: Path,
    provider: IcarusProvider,
    source_set_id: str = "",
) -> dict[str, Any]:
    source_set = _source_set(manifest, source_set_id)
    netlist_artifact = next(
        (
            artifact for artifact in synthesis_run.get("artifacts", [])
            if artifact.get("kind") == "gate_netlist"
        ),
        None,
    )
    if not netlist_artifact:
        raise ValueError("synthesis run does not contain a gate_netlist artifact")
    sources = [Path(str(netlist_artifact["path"])).expanduser().resolve()]
    sources.extend(
        _resolve_project_path(project_root, str(path), "gate simulation library")
        for path in source_set.get("gate_libraries", [])
    )
    result = provider.simulate(
        project_root,
        manifest,
        run_root,
        source_set_id,
        design_sources=sources,
    )
    result["kind"] = "hdl_gate_regression"
    result["metadata"]["synthesis_run_id"] = synthesis_run.get("run_id")
    result["metadata"]["synthesis_script_hash"] = synthesis_run.get("metadata", {}).get("script_hash", "")
    _atomic_json(run_root.expanduser().resolve() / "run.json", result)
    return result


def _yosys_quote(path: Path) -> str:
    value = str(path).replace("\\", "/").replace('"', '\\"')
    if "\n" in value or "\r" in value:
        raise ValueError(f"unsupported newline in Yosys path: {path}")
    return f'"{value}"'


class YosysProvider:
    provider_id = "yosys"

    def __init__(self, executable: str = ""):
        self.executable = _resolve_executable(executable, "yosys")

    def synthesize(
        self,
        project_root: Path,
        manifest: dict[str, Any],
        run_root: Path,
        source_set_id: str = "",
    ) -> dict[str, Any]:
        source_set = _source_set(manifest, source_set_id)
        sources = _source_paths(project_root, source_set, include_testbench=False)
        liberty = (
            _resolve_project_path(project_root, str(source_set["liberty"]), "Liberty file")
            if source_set.get("liberty") else None
        )
        constraints = (
            _resolve_project_path(project_root, str(source_set["constraints"]), "constraint file")
            if source_set.get("constraints") else None
        )
        if constraints:
            raise ValueError(
                "YosysProvider does not apply timing constraints; remove source_set.constraints "
                "or run a provider with explicit SDC support"
            )
        run_root = run_root.expanduser().resolve()
        run_root.mkdir(parents=True, exist_ok=True)
        netlist = run_root / "netlist.v"
        json_netlist = run_root / "netlist.json"
        script = run_root / "synthesis.ys"
        read = "read_verilog " + " ".join(_yosys_quote(path) for path in sources)
        lines = [
            read,
            f"hierarchy -check -top {source_set['top']}",
            "proc",
            "opt",
            "memory",
            "opt",
        ]
        if liberty:
            lines.extend([
                f"read_liberty -lib {_yosys_quote(liberty)}",
                f"dfflibmap -liberty {_yosys_quote(liberty)}",
                f"abc -liberty {_yosys_quote(liberty)}",
                "clean",
            ])
        lines.extend([
            f"write_verilog -noattr {_yosys_quote(netlist)}",
            f"write_json {_yosys_quote(json_netlist)}",
            "stat",
            "",
        ])
        script.write_text("\n".join(lines), encoding="utf-8")
        completed = _run(self.executable, ["-q", "-s", str(script)], run_root)
        success = completed.returncode == 0 and netlist.is_file() and json_netlist.is_file()
        artifacts = [
            {"kind": "yosys_script", "path": str(script), "hash": _hash(script)},
        ]
        for kind, path in (("gate_netlist", netlist), ("yosys_json", json_netlist)):
            if path.is_file():
                artifacts.append({"kind": kind, "path": str(path), "hash": _hash(path)})
        result = _verification(
            run_root.name,
            "hdl_synthesis",
            self.provider_id,
            success,
            [text for text in (completed.stdout.strip(), completed.stderr.strip()) if text],
            artifacts,
            {
                "language": "verilog-2005",
                "top": source_set["top"],
                "source_hash": _combined_hash(sources),
                "liberty_hash": _hash(liberty) if liberty else "",
                "constraints_hash": "",
                "constraints_status": "not_declared",
                "constraints_applied": False,
                "technology_mapped": bool(liberty),
                "script_hash": _hash(script),
                "domain_verified": success,
                "ams_verified": False,
            },
        )
        _atomic_json(run_root / "run.json", result)
        return result


class OpenRoadProvider:
    """Explicit, experimental handoff to a user/PDK-owned OpenROAD Tcl flow."""

    provider_id = "openroad"

    def __init__(self, executable: str = ""):
        self.executable = _resolve_executable(executable, "openroad")

    def run_script(
        self,
        project_root: Path,
        script_path: Path,
        run_root: Path,
    ) -> dict[str, Any]:
        script = _resolve_project_path(project_root, str(script_path), "OpenROAD script")
        if script.suffix.casefold() != ".tcl":
            raise ValueError("OpenROAD flow input must be an explicit .tcl script")
        run_root = run_root.expanduser().resolve()
        run_root.mkdir(parents=True, exist_ok=True)
        completed = _run(self.executable, ["-exit", str(script)], run_root)
        artifacts = [{"kind": "openroad_script", "path": str(script), "hash": _hash(script)}]
        for path in sorted(run_root.iterdir()):
            if path.is_file() and path.suffix.casefold() in {".def", ".gds", ".odb", ".rpt", ".json"}:
                artifacts.append({
                    "kind": f"openroad_{path.suffix.casefold().lstrip('.')}",
                    "path": str(path),
                    "hash": _hash(path),
                })
        result = _verification(
            run_root.name,
            "rtl_to_gds",
            self.provider_id,
            completed.returncode == 0,
            [text for text in (completed.stdout.strip(), completed.stderr.strip()) if text],
            artifacts,
            {
                "script_hash": _hash(script),
                "qualification": "experimental",
                "executed_by_explicit_user_action": True,
            },
        )
        _atomic_json(run_root / "run.json", result)
        return result


def verify_mixed_signal_contract(
    contract_path: Path,
    run_root: Path,
    analog_run: dict[str, Any] | None = None,
    digital_run: dict[str, Any] | None = None,
) -> dict[str, Any]:
    contract_path = contract_path.expanduser().resolve()
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    if contract.get("schema") != MIXED_SCHEMA:
        raise ValueError(f"mixed-signal contract must use {MIXED_SCHEMA}")
    boundaries = contract.get("boundaries")
    if not isinstance(boundaries, list) or not boundaries:
        raise ValueError("mixed-signal contract requires boundaries")
    diagnostics: list[str] = []
    boundary_results: list[dict[str, Any]] = []
    identifiers: set[str] = set()
    for boundary in boundaries:
        identifier = str(boundary.get("id") or "").strip()
        if not identifier or identifier in identifiers:
            raise ValueError("boundary ids must be non-empty and unique")
        identifiers.add(identifier)
        for required in ("analog_net", "digital_signal", "direction", "conversion_model"):
            if not str(boundary.get(required) or "").strip():
                raise ValueError(f"boundary {identifier} requires {required}")
        supply = boundary.get("supply_domain")
        threshold = boundary.get("threshold")
        sampling = boundary.get("sampling")
        if not isinstance(supply, dict) or not all(
            isinstance(supply.get(key), (int, float)) for key in ("vss", "vdd")
        ):
            raise ValueError(f"boundary {identifier} requires numeric supply_domain vss/vdd")
        if float(supply["vdd"]) <= float(supply["vss"]):
            raise ValueError(f"boundary {identifier} requires vdd > vss")
        if not isinstance(threshold, dict) or not all(
            isinstance(threshold.get(key), (int, float)) for key in ("low_max", "high_min")
        ):
            raise ValueError(f"boundary {identifier} requires numeric low_max/high_min")
        if not float(threshold["low_max"]) < float(threshold["high_min"]):
            raise ValueError(f"boundary {identifier} requires low_max < high_min")
        if not isinstance(sampling, dict) or sampling.get("mode") not in {"edge", "periodic", "continuous"}:
            raise ValueError(f"boundary {identifier} requires an explicit sampling mode")
        vector_results: list[dict[str, Any]] = []
        for vector in boundary.get("vectors", []):
            voltage = float(vector["analog_voltage"])
            digital = int(vector["digital_value"])
            passed = (
                digital == 0 and voltage <= float(threshold["low_max"])
            ) or (
                digital == 1 and voltage >= float(threshold["high_min"])
            )
            vector_results.append({**vector, "passed": passed})
            if not passed:
                diagnostics.append(f"boundary {identifier} vector violates threshold contract")
        boundary_results.append({
            "id": identifier,
            "passed": all(item["passed"] for item in vector_results),
            "vectors": vector_results,
        })
    contract_ok = all(item["passed"] for item in boundary_results)
    analog_ok = analog_run is None or analog_run.get("status") == "passed" or analog_run.get("ok") is True
    digital_ok = digital_run is None or digital_run.get("status") == "passed" or digital_run.get("ok") is True
    domain_verified = analog_run is not None and digital_run is not None and analog_ok and digital_ok
    interface_verified = contract_ok and domain_verified
    run_root = run_root.expanduser().resolve()
    run_root.mkdir(parents=True, exist_ok=True)
    result = _verification(
        run_root.name,
        "mixed_signal_contract",
        "actoviq-interface-contract",
        contract_ok and analog_ok and digital_ok,
        diagnostics,
        [{"kind": "interface_contract", "path": str(contract_path), "hash": _hash(contract_path)}],
        {
            "contract_hash": _hash(contract_path),
            "boundaries": boundary_results,
            "domain_verified": domain_verified,
            "interface_verified": interface_verified,
            "ams_verified": False,
        },
    )
    _atomic_json(run_root / "run.json", result)
    return result
