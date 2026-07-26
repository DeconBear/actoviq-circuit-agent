#!/usr/bin/env python3
"""Open-source simulator and Verilog-A provider helpers."""

from __future__ import annotations

import csv
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


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


def _resolve_executable(configured: str, fallback: str) -> str:
    candidate = configured.strip() if configured else fallback
    located = shutil.which(candidate)
    if located:
        return str(Path(located).resolve())
    path = Path(candidate).expanduser()
    if path.is_file():
        return str(path.resolve())
    raise FileNotFoundError(f"executable not found: {candidate}")


def _run(
    executable: str,
    arguments: list[str],
    cwd: Path,
    timeout_seconds: float = 120.0,
) -> subprocess.CompletedProcess[str]:
    command = [executable, *arguments]
    if Path(executable).suffix.casefold() == ".py":
        command = [sys.executable, executable, *arguments]
    return subprocess.run(
        command,
        cwd=str(cwd),
        shell=False,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )


def _probe_version(executable: str, flags: Iterable[list[str]]) -> str:
    for arguments in flags:
        try:
            completed = _run(executable, arguments, Path.cwd(), timeout_seconds=10.0)
        except (OSError, subprocess.TimeoutExpired):
            continue
        text = "\n".join((completed.stdout, completed.stderr)).strip()
        if text:
            return text.splitlines()[0][:240]
    return Path(executable).name


def inject_ngspice_osdi(deck: str, osdi_paths: Iterable[Path]) -> str:
    """Insert controlled pre_osdi commands without treating source text as shell."""
    resolved = [str(Path(path).expanduser().resolve()) for path in osdi_paths]
    if not resolved:
        return deck
    commands = [f"pre_osdi {path}" for path in resolved]
    control = re.search(r"(?im)^\s*\.control\s*$", deck)
    if control:
        insertion = control.end()
        return deck[:insertion] + "\n" + "\n".join(commands) + deck[insertion:]
    return deck.rstrip() + "\n.control\n" + "\n".join(commands) + "\n.endc\n"


class OpenVafProvider:
    provider_id = "openvaf"

    def __init__(self, executable: str = ""):
        self.executable = _resolve_executable(executable, "openvaf")
        self.version = _probe_version(self.executable, (["--version"], ["-V"]))

    def compile(
        self,
        source: Path,
        cache_root: Path,
        flags: list[str] | None = None,
    ) -> dict[str, Any]:
        source = source.expanduser().resolve()
        if source.suffix.casefold() != ".va" or not source.is_file():
            raise ValueError(f"OpenVAF input must be an existing .va file: {source}")
        compile_flags = list(flags or [])
        source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        cache_key = hashlib.sha256(
            json.dumps(
                {
                    "source_hash": source_hash,
                    "version": self.version,
                    "flags": compile_flags,
                    "architecture": platform.machine(),
                    "platform": platform.system(),
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        output_root = cache_root.expanduser().resolve() / cache_key
        output_root.mkdir(parents=True, exist_ok=True)
        output = output_root / f"{source.stem}.osdi"
        manifest_path = output_root / "manifest.json"
        if output.is_file() and manifest_path.is_file():
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            return {**manifest, "cache_hit": True}

        completed = _run(
            self.executable,
            [str(source), *compile_flags, "-o", str(output)],
            output_root,
        )
        manifest = {
            "schema": "actoviq.openvaf-artifact.v1",
            "provider": self.provider_id,
            "executable": self.executable,
            "version": self.version,
            "source": str(source),
            "source_hash": source_hash,
            "cache_key": cache_key,
            "architecture": platform.machine(),
            "flags": compile_flags,
            "output": str(output),
            "exit_code": completed.returncode,
            "diagnostics": "\n".join(
                part for part in (completed.stdout.strip(), completed.stderr.strip()) if part
            ),
            "compiled_at": _utc_now(),
            "cache_hit": False,
        }
        _atomic_json(manifest_path, manifest)
        if completed.returncode != 0 or not output.is_file():
            raise RuntimeError(
                f"OpenVAF compilation failed ({completed.returncode}): {manifest['diagnostics']}"
            )
        return manifest


def validate_xyce_deck(deck: str) -> list[str]:
    diagnostics: list[str] = []
    if re.search(r"(?im)^\s*\.control\s*$", deck):
        diagnostics.append("Xyce does not accept ngspice .control blocks")
    if re.search(r"(?im)^\s*pre_osdi\b", deck):
        diagnostics.append("OSDI is ngspice-only; use a Xyce/ADMS device plugin")
    if re.search(r"(?im)^\s*(?:wrdata|write)\b", deck):
        diagnostics.append("ngspice interactive output commands are not portable to Xyce")
    return diagnostics


def compare_simulation_metrics(
    left: dict[str, Any],
    right: dict[str, Any],
    relative_tolerance: float,
    absolute_tolerance: float,
) -> dict[str, Any]:
    """Compare common scalar measurements; waveform identity is intentionally not required."""
    left_metrics = {
        str(metric.get("name")): float(metric["value"])
        for metric in left.get("metrics", [])
        if metric.get("name") and isinstance(metric.get("value"), (int, float))
    }
    right_metrics = {
        str(metric.get("name")): float(metric["value"])
        for metric in right.get("metrics", [])
        if metric.get("name") and isinstance(metric.get("value"), (int, float))
    }
    comparisons: list[dict[str, Any]] = []
    for name in sorted(set(left_metrics) & set(right_metrics)):
        left_value = left_metrics[name]
        right_value = right_metrics[name]
        tolerance = max(
            absolute_tolerance,
            relative_tolerance * max(abs(left_value), abs(right_value)),
        )
        delta = abs(left_value - right_value)
        comparisons.append({
            "metric": name,
            "left": left_value,
            "right": right_value,
            "delta": delta,
            "tolerance": tolerance,
            "passed": delta <= tolerance,
        })
    return {
        "ok": bool(comparisons) and all(item["passed"] for item in comparisons),
        "relative_tolerance": relative_tolerance,
        "absolute_tolerance": absolute_tolerance,
        "comparisons": comparisons,
        "missing_from_left": sorted(set(right_metrics) - set(left_metrics)),
        "missing_from_right": sorted(set(left_metrics) - set(right_metrics)),
    }


def _parse_numeric_table(path: Path) -> dict[str, list[float]]:
    if not path.is_file():
        return {}
    lines = [
        line.strip()
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines()
        if line.strip() and not line.lstrip().startswith(("*", "#"))
    ]
    if len(lines) < 2:
        return {}
    delimiter = "," if "," in lines[0] else None
    rows = list(csv.reader(lines, delimiter=delimiter)) if delimiter else [
        re.split(r"\s+", line) for line in lines
    ]
    headers = [item.strip() for item in rows[0]]
    columns: dict[str, list[float]] = {header: [] for header in headers}
    for row in rows[1:]:
        if len(row) != len(headers):
            continue
        try:
            values = [float(item) for item in row]
        except ValueError:
            continue
        for header, value in zip(headers, values):
            columns[header].append(value)
    return columns


def _parse_measurements(text: str) -> list[dict[str, Any]]:
    metrics: list[dict[str, Any]] = []
    seen: set[str] = set()
    for name, raw_value in re.findall(
        r"(?im)^\s*([A-Za-z_][\w.:-]*)\s*=\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)\s*$",
        text,
    ):
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        metrics.append({
            "name": name,
            "value": float(raw_value),
            "measurement_status": "measured",
        })
    return metrics


class XyceProvider:
    provider_id = "xyce"

    def __init__(self, executable: str = ""):
        self.executable = _resolve_executable(executable, "Xyce")
        self.version = _probe_version(self.executable, (["-v"], ["--version"]))
        self.execution_target = "local_windows" if os.name == "nt" else "local_linux"

    def run_deck(
        self,
        deck_path: Path,
        run_root: Path,
        extra_args: list[str] | None = None,
    ) -> dict[str, Any]:
        source = deck_path.expanduser().resolve()
        deck = source.read_text(encoding="utf-8", errors="replace")
        compatibility = validate_xyce_deck(deck)
        if compatibility:
            raise ValueError("; ".join(compatibility))
        run_root.mkdir(parents=True, exist_ok=True)
        local_deck = run_root / "deck.cir"
        local_deck.write_text(deck, encoding="utf-8")
        log_path = run_root / "xyce.log"
        completed = _run(
            self.executable,
            [*(extra_args or []), "-l", str(log_path), str(local_deck)],
            run_root,
        )
        combined = "\n".join(
            part for part in (
                completed.stdout.strip(),
                completed.stderr.strip(),
                log_path.read_text(encoding="utf-8", errors="replace").strip()
                if log_path.is_file() else "",
            ) if part
        )
        metrics = _parse_measurements(combined)
        tables: dict[str, dict[str, list[float]]] = {}
        for path in sorted(run_root.iterdir()):
            if path.suffix.casefold() in {".prn", ".csv"}:
                parsed = _parse_numeric_table(path)
                if parsed:
                    tables[path.name] = parsed
        result = {
            "schema": "actoviq.simulation.v3",
            "run_id": run_root.name,
            "scope": "deck",
            "ok": completed.returncode == 0,
            "execution_status": "success" if completed.returncode == 0 else "failed",
            "measurement_status": "success" if metrics else "not_requested",
            "specification_status": "not_evaluated",
            "verified": False,
            "analysis_count": 1,
            "analyses": [{
                "id": "xyce",
                "type": "external_deck",
                "status": "completed" if completed.returncode == 0 else "failed",
                "metrics": metrics,
                "tables": tables,
                "log_path": str(log_path),
            }],
            "metrics": metrics,
            "provider": {
                "id": self.provider_id,
                "executable": self.executable,
                "version": self.version,
            },
            "execution_target": self.execution_target,
            "verification": {
                "executed": completed.returncode == 0,
                "measured": bool(metrics),
                "spec_passed": False,
                "lvs_clean": None,
                "ams_verified": False,
            },
            "simulated_at": _utc_now(),
            "diagnostics": combined,
        }
        _atomic_json(run_root / "run.json", result)
        return result
