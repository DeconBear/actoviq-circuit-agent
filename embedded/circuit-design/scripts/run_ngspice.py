#!/usr/bin/env python3
"""Run ngspice in batch mode and return a JSON result."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run ngspice batch simulation")
    parser.add_argument("--netlist-path", required=True, help="Path to .cir/.spice netlist")
    parser.add_argument("--work-dir", default=".", help="Working directory")
    parser.add_argument("--timeout-sec", type=int, default=60, help="Process timeout in seconds")
    parser.add_argument("--ngspice-bin", default="", help="ngspice executable name/path")
    parser.add_argument("--log-file", default="ngspice.log", help="Log file name under work dir")
    return parser


def load_configured_ngspice_bin() -> str:
    """
    Read ngspice path from skill-level tool_paths.json.
    """
    skill_root = Path(__file__).resolve().parents[1]
    config_path = skill_root / "tool_paths.json"
    if not config_path.exists():
        return ""
    try:
        data = json.loads(config_path.read_text(encoding="utf-8-sig"))
    except Exception:
        return ""
    value = str(data.get("ngspice_bin", "")).strip()
    return value


def resolve_ngspice_bin(cli_value: str) -> tuple[str, str]:
    """
    Resolve ngspice path in priority order:
    1) CLI --ngspice-bin
    2) NGSPICE_BIN env var
    3) skill tool_paths.json (ngspice_bin)
    4) PATH lookup for "ngspice"
    """
    cli_value = (cli_value or "").strip()
    if cli_value:
        return cli_value, "cli"

    env_value = os.getenv("NGSPICE_BIN", "").strip()
    if env_value:
        return env_value, "env"

    cfg_value = load_configured_ngspice_bin().strip()
    if cfg_value:
        return cfg_value, "skill_config"

    return "ngspice", "path"


def main() -> int:
    args = build_parser().parse_args()
    netlist = Path(args.netlist_path).resolve()
    work_dir = Path(args.work_dir).resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    log_path = (work_dir / args.log_file).resolve()

    result = {
        "ok": False,
        "return_code": None,
        "log_path": str(log_path),
        "stderr": "",
        "artifacts": [],
    }

    if not netlist.exists():
        result["stderr"] = f"netlist not found: {netlist}"
        print(json.dumps(result, ensure_ascii=False))
        return 1

    ngspice_bin, source = resolve_ngspice_bin(args.ngspice_bin)
    resolved_executable = ""
    if Path(ngspice_bin).exists():
        resolved_executable = str(Path(ngspice_bin).resolve())
    else:
        resolved_executable = shutil.which(ngspice_bin) or ""

    if not resolved_executable:
        result["stderr"] = (
            f"ngspice executable not found (source={source}): {ngspice_bin}. "
            "Set --ngspice-bin, NGSPICE_BIN, or skill tool_paths.json."
        )
        print(json.dumps(result, ensure_ascii=False))
        return 1

    cmd = [
        resolved_executable,
        "-b",
        "-o",
        str(log_path),
        str(netlist),
    ]

    try:
        completed = subprocess.run(
            cmd,
            cwd=str(work_dir),
            capture_output=True,
            text=True,
            timeout=max(1, args.timeout_sec),
            check=False,
        )
    except subprocess.TimeoutExpired:
        result["stderr"] = f"ngspice timeout after {args.timeout_sec}s"
        if log_path.exists():
            result["artifacts"].append(str(log_path))
        print(json.dumps(result, ensure_ascii=False))
        return 1

    result["return_code"] = completed.returncode
    result["stderr"] = completed.stderr.strip()
    if log_path.exists():
        result["artifacts"].append(str(log_path))
    raw_candidates = list(work_dir.glob("*.raw")) + list(work_dir.glob("*.csv"))
    result["artifacts"].extend(str(p.resolve()) for p in raw_candidates)
    result["ok"] = completed.returncode == 0

    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
