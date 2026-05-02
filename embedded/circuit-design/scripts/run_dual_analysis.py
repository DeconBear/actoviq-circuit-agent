#!/usr/bin/env python3
"""Run split AC/power analyses and merge metrics."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from parse_results import parse_measurements
from run_ngspice import resolve_ngspice_bin


MAX_LOG_BYTES = 2_000_000


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run AC and power analyses separately")
    parser.add_argument("--work-dir", required=True, help="Working directory")
    parser.add_argument("--netlist-path", default="", help="Single source netlist to split")
    parser.add_argument("--ac-netlist-path", default="", help="Pre-split AC netlist path")
    parser.add_argument("--power-netlist-path", default="", help="Pre-split power netlist path")
    parser.add_argument("--spec-path", default="", help="Optional spec path for evaluation")
    parser.add_argument("--timeout-sec", type=int, default=90, help="Timeout per simulation")
    parser.add_argument("--ngspice-bin", default="", help="ngspice executable")
    parser.add_argument("--metric-ac", action="append", default=[], help="AC metric filter")
    parser.add_argument("--metric-power", action="append", default=[], help="Power metric filter")
    parser.add_argument(
        "--power-analysis",
        default="tran",
        choices=["tran", "op", "dc"],
        help="Power analysis mode when auto-splitting",
    )
    parser.add_argument("--supply-source", default="VDD", help="Supply source name for power split helper")
    parser.add_argument(
        "--supply-voltage-expr",
        default="VDD_SUPPLY",
        help="Voltage expression for power computation in split helper",
    )
    return parser


def resolve_executable(cli_value: str) -> str:
    exe, _ = resolve_ngspice_bin(cli_value)
    if Path(exe).exists():
        return str(Path(exe).resolve())
    from shutil import which

    return which(exe) or ""


def read_text_limited(path: Path, max_bytes: int = MAX_LOG_BYTES) -> str:
    if not path.exists():
        return ""
    size = path.stat().st_size
    if size <= max_bytes:
        return path.read_text(encoding="utf-8-sig", errors="ignore")

    head_bytes = max_bytes // 2
    tail_bytes = max_bytes - head_bytes
    with path.open("rb") as handle:
        head = handle.read(head_bytes)
        handle.seek(max(0, size - tail_bytes))
        tail = handle.read(tail_bytes)
    marker = (
        f"\n\n* actoviq log truncated for parsing: original_bytes={size}, "
        f"kept_head={head_bytes}, kept_tail={tail_bytes}\n\n"
    )
    return (
        head.decode("utf-8", errors="ignore")
        + marker
        + tail.decode("utf-8", errors="ignore")
    )


def cap_text_file(path: Path, max_bytes: int = MAX_LOG_BYTES) -> None:
    if not path.exists() or path.stat().st_size <= max_bytes:
        return
    sampled = read_text_limited(path, max_bytes)
    path.write_text(sampled, encoding="utf-8")


def suppress_bulk_output(netlist_path: Path) -> None:
    if not netlist_path.exists():
        return
    lines = netlist_path.read_text(encoding="utf-8-sig", errors="ignore").splitlines()
    updated: list[str] = []
    changed = False
    for line in lines:
        stripped = line.strip().lower()
        tokens = stripped.split()
        directive = tokens[0] if tokens else ""
        analysis = tokens[1] if len(tokens) > 1 else ""
        # Keep compact AC/DC/OP prints because ngspice needs saved vectors for
        # some .meas forms. Transient prints are the usual source of huge logs.
        if directive in {".print", ".plot"} and analysis in {"", "tran"}:
            updated.append(f"* actoviq suppressed bulk output: {line}")
            changed = True
            continue
        updated.append(line)
    if changed:
        netlist_path.write_text("\n".join(updated) + "\n", encoding="utf-8")


def infer_supply_settings(netlist_path: Path, fallback_source: str, fallback_voltage_expr: str) -> tuple[str, str]:
    try:
        lines = netlist_path.read_text(encoding="utf-8-sig", errors="ignore").splitlines()
    except OSError:
        return fallback_source, fallback_voltage_expr

    known_params: dict[str, str] = {}
    for raw_line in lines:
        stripped = raw_line.strip()
        if not stripped.lower().startswith(".param "):
            continue
        try:
            _, remainder = stripped.split(None, 1)
            name, value = remainder.split("=", 1)
            known_params[name.strip()] = value.strip().strip("{}")
        except ValueError:
            continue

    ranked_candidates: list[tuple[int, str, str]] = []
    for raw_line in lines:
        stripped = raw_line.strip()
        if not stripped or stripped.startswith(("*", ";", "//", "$", ".")):
            continue
        tokens = stripped.split()
        name = tokens[0]
        if not name or name[0].upper() != "V" or len(tokens) < 4:
            continue

        lower_name = name.lower()
        if "pulse" in stripped.lower() or "sin" in stripped.lower():
            continue

        value_expr = ""
        if len(tokens) >= 4 and tokens[3].upper() == "DC" and len(tokens) >= 5:
            value_expr = tokens[4].strip("{}")
        elif len(tokens) >= 4 and tokens[3].upper().startswith("PWL("):
            pwl_tail = stripped[stripped.upper().find("PWL(") + 4 :].rstrip(")")
            pwl_tokens = [token for token in pwl_tail.replace("(", " ").replace(")", " ").split() if token]
            if len(pwl_tokens) >= 2:
                value_expr = pwl_tokens[1].strip("{}")
        elif len(tokens) >= 4:
            value_expr = tokens[3].strip("{}")

        if not value_expr or value_expr in {"0", "0.0"}:
            if "vin_nom" in known_params:
                value_expr = known_params["vin_nom"]
            elif "vdd" in known_params:
                value_expr = known_params["vdd"]
            elif "vin" in known_params:
                value_expr = known_params["vin"]
        if not value_expr or value_expr in {"0", "0.0"}:
            continue

        score = 1
        if any(tag in lower_name for tag in ("vdd", "vcc", "vin_src", "vin", "supply")):
            score += 10
        if "ref" in lower_name:
            score -= 5

        ranked_candidates.append((score, name, value_expr))

    if not ranked_candidates:
        return fallback_source, fallback_voltage_expr

    ranked_candidates.sort(key=lambda item: item[0], reverse=True)
    _, source_name, voltage_expr = ranked_candidates[0]
    return source_name, voltage_expr


def run_netlist(executable: str, netlist_path: Path, log_path: Path, timeout_sec: int) -> dict:
    run_result = {
        "ok": False,
        "return_code": None,
        "netlist_path": str(netlist_path),
        "log_path": str(log_path),
        "stderr": "",
    }
    try:
        completed = subprocess.run(
            [executable, "-b", "-o", str(log_path), str(netlist_path)],
            capture_output=True,
            text=True,
            timeout=max(1, timeout_sec),
            check=False,
        )
    except subprocess.TimeoutExpired:
        run_result["stderr"] = f"timeout after {timeout_sec}s"
        return run_result

    run_result["return_code"] = completed.returncode
    run_result["stderr"] = completed.stderr.strip()
    run_result["ok"] = completed.returncode == 0 and log_path.exists()
    return run_result


def metric_guess_for_spec(spec: dict) -> tuple[set[str], set[str]]:
    targets = spec.get("targets_eval") if isinstance(spec.get("targets_eval"), dict) else spec.get("targets", {})
    if not isinstance(targets, dict):
        return set(), set()

    ac: set[str] = set()
    power: set[str] = set()
    for name in targets:
        lower = str(name).lower()
        if any(key in lower for key in ("gain", "bw", "freq", "s11", "s22", "nf", "k_", "ip3", "p1db")):
            ac.add(name)
        elif any(
            key in lower
            for key in (
                "threshold",
                "delay",
                "voh",
                "vol",
                "output_low",
                "output_high",
                "_v",
            )
        ):
            power.add(name)
        elif any(key in lower for key in ("pdc", "idd", "iq", "current", "power", "_ma", "_w")):
            power.add(name)
        else:
            ac.add(name)
    return ac, power


def call_split_helper(
    *,
    source_netlist: Path,
    ac_path: Path,
    power_path: Path,
    power_analysis: str,
    supply_source: str,
    supply_voltage_expr: str,
) -> dict:
    split_script = Path(__file__).resolve().with_name("split_netlist_analyses.py")
    cmd = [
        sys.executable,
        str(split_script),
        "--netlist-path",
        str(source_netlist),
        "--ac-netlist-path",
        str(ac_path),
        "--power-netlist-path",
        str(power_path),
        "--power-analysis",
        power_analysis,
        "--supply-source",
        supply_source,
        "--supply-voltage-expr",
        supply_voltage_expr,
    ]
    completed = subprocess.run(cmd, capture_output=True, text=True, check=False)
    stdout = completed.stdout.strip() or "{}"
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError:
        payload = {"ok": False, "warnings": [f"split helper returned non-JSON: {stdout[:200]}"]}
    payload["return_code"] = completed.returncode
    if completed.returncode != 0 and completed.stderr.strip():
        payload.setdefault("warnings", []).append(completed.stderr.strip())
    return payload


def call_evaluator(spec_path: Path, metrics_path: Path) -> tuple[dict, int]:
    evaluate_script = Path(__file__).resolve().with_name("evaluate_against_spec.py")
    cmd = [
        sys.executable,
        str(evaluate_script),
        "--spec-path",
        str(spec_path),
        "--metrics-path",
        str(metrics_path),
    ]
    completed = subprocess.run(cmd, capture_output=True, text=True, check=False)
    stdout = completed.stdout.strip() or "{}"
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError:
        payload = {
            "pass": False,
            "gaps": [],
            "missing_metrics": ["evaluation_json_parse_error"],
            "failed_metrics": [{"name": "evaluation", "reason": stdout[:200]}],
        }
    return payload, completed.returncode


def main() -> int:
    args = build_parser().parse_args()

    work_dir = Path(args.work_dir).resolve()
    work_dir.mkdir(parents=True, exist_ok=True)

    result = {
        "ok": False,
        "work_dir": str(work_dir),
        "ac": {},
        "power": {},
        "metrics_path": str(work_dir / "metrics.json"),
        "evaluation_path": str(work_dir / "evaluation.json"),
        "warnings": [],
    }

    ngspice_exe = resolve_executable(args.ngspice_bin)
    if not ngspice_exe:
        result["warnings"].append("ngspice executable not found")
        print(json.dumps(result, ensure_ascii=False))
        return 1

    ac_path = Path(args.ac_netlist_path).resolve() if args.ac_netlist_path else work_dir / "design_ac.cir"
    power_path = (
        Path(args.power_netlist_path).resolve() if args.power_netlist_path else work_dir / "design_power.cir"
    )

    if args.netlist_path:
        source_netlist = Path(args.netlist_path).resolve()
        if not source_netlist.exists():
            result["warnings"].append(f"netlist not found: {source_netlist}")
            print(json.dumps(result, ensure_ascii=False))
            return 1
        supply_source, supply_voltage_expr = infer_supply_settings(
            source_netlist,
            args.supply_source,
            args.supply_voltage_expr,
        )
        result["supply_inference"] = {
            "source": supply_source,
            "voltage_expr": supply_voltage_expr,
        }
        split_payload = call_split_helper(
            source_netlist=source_netlist,
            ac_path=ac_path,
            power_path=power_path,
            power_analysis=args.power_analysis,
            supply_source=supply_source,
            supply_voltage_expr=supply_voltage_expr,
        )
        result["split"] = split_payload
        if not split_payload.get("ok"):
            result["warnings"].append("split_netlist_analyses failed")
            print(json.dumps(result, ensure_ascii=False))
            return 1
    else:
        if not ac_path.exists() or not power_path.exists():
            result["warnings"].append("provide --netlist-path or both --ac-netlist-path and --power-netlist-path")
            print(json.dumps(result, ensure_ascii=False))
            return 1

    suppress_bulk_output(ac_path)
    suppress_bulk_output(power_path)

    ac_log = work_dir / "ac_ngspice.log"
    power_log = work_dir / "power_ngspice.log"

    ac_run = run_netlist(ngspice_exe, ac_path, ac_log, args.timeout_sec)
    power_run = run_netlist(ngspice_exe, power_path, power_log, args.timeout_sec)
    result["ac"]["run"] = ac_run
    result["power"]["run"] = power_run

    ac_metrics_filter = {m.strip() for m in args.metric_ac if m.strip()}
    power_metrics_filter = {m.strip() for m in args.metric_power if m.strip()}

    spec = None
    if args.spec_path:
        spec_path = Path(args.spec_path).resolve()
        if spec_path.exists():
            spec = json.loads(spec_path.read_text(encoding="utf-8-sig"))
            if not ac_metrics_filter and not power_metrics_filter:
                guessed_ac, guessed_power = metric_guess_for_spec(spec)
                ac_metrics_filter = guessed_ac
                power_metrics_filter = guessed_power
        else:
            result["warnings"].append(f"spec not found: {spec_path}")

    ac_parsed = {"metrics": {}, "failed_metrics": {}, "analysis_context": {}, "warnings": []}
    power_parsed = {"metrics": {}, "failed_metrics": {}, "analysis_context": {}, "warnings": []}
    if ac_log.exists():
        ac_parsed = parse_measurements(read_text_limited(ac_log), ac_metrics_filter)
        cap_text_file(ac_log)
    if power_log.exists():
        power_parsed = parse_measurements(read_text_limited(power_log), power_metrics_filter)
        cap_text_file(power_log)

    result["ac"]["metrics"] = ac_parsed
    result["power"]["metrics"] = power_parsed

    merged_metrics = dict(ac_parsed.get("metrics", {}))
    merged_failed = dict(ac_parsed.get("failed_metrics", {}))
    merged_context = dict(ac_parsed.get("analysis_context", {}))
    raw_measure_lines = list(ac_parsed.get("raw_measure_lines", []))
    warnings = list(ac_parsed.get("warnings", [])) + list(power_parsed.get("warnings", []))

    for key, value in power_parsed.get("metrics", {}).items():
        if key in merged_metrics and merged_metrics[key] != value:
            warnings.append(f"metric collision: {key} overwritten by power analysis value")
        merged_metrics[key] = value
    for key, value in power_parsed.get("failed_metrics", {}).items():
        if key not in merged_failed:
            merged_failed[key] = value
    for key, value in power_parsed.get("analysis_context", {}).items():
        merged_context[key] = value
    raw_measure_lines.extend(power_parsed.get("raw_measure_lines", []))

    merged_payload = {
        "metrics": merged_metrics,
        "failed_metrics": merged_failed,
        "analysis_context": merged_context,
        "raw_measure_lines": raw_measure_lines,
        "warnings": warnings,
    }

    metrics_path = Path(result["metrics_path"])
    metrics_path.write_text(json.dumps(merged_payload, ensure_ascii=False, indent=2), encoding="utf-8")
    (work_dir / "ac_metrics.json").write_text(
        json.dumps(ac_parsed, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (work_dir / "power_metrics.json").write_text(
        json.dumps(power_parsed, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    eval_payload = {}
    eval_return_code = 0
    if args.spec_path and Path(args.spec_path).exists():
        eval_payload, eval_return_code = call_evaluator(Path(args.spec_path).resolve(), metrics_path)
        Path(result["evaluation_path"]).write_text(
            json.dumps(eval_payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        result["evaluation"] = eval_payload

    ac_ok = ac_run.get("ok", False)
    power_ok = power_run.get("ok", False)
    eval_ok = True if not eval_payload else bool(eval_payload.get("pass", False))
    result["warnings"].extend(warnings)
    result["ok"] = ac_ok and power_ok and eval_ok

    print(json.dumps(result, ensure_ascii=False))
    if not (ac_ok and power_ok):
        return 1
    if eval_payload and eval_return_code != 0:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
