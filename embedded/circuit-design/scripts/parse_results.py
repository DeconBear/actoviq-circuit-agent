#!/usr/bin/env python3
"""Parse ngspice log output and extract measured scalar metrics."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


CONTEXT_RE = re.compile(r"^\s*Measurements\s+for\s+(.+?)\s+Analysis\s*$", re.IGNORECASE)
MEAS_LINE_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")
MEAS_FAILED_RE = re.compile(
    r"^\s*\.meas(?:ure)?\s+([A-Za-z]+)\s+([A-Za-z_][A-Za-z0-9_]*).*\bfailed!\s*$",
    re.IGNORECASE,
)
NUMERIC_TOKEN_RE = re.compile(r"^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\b")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Parse ngspice result log")
    parser.add_argument("--log-path", required=True, help="Path to ngspice log file")
    parser.add_argument(
        "--metric",
        action="append",
        default=[],
        help="Metric name filter (repeatable). If omitted, return all parsed metrics.",
    )
    return parser


def parse_measurements(text: str, wanted: set[str]) -> dict:
    metrics: dict[str, float] = {}
    failed_metrics: dict[str, dict] = {}
    raw_measure_lines: list[str] = []
    analysis_context: dict[str, str] = {}
    warnings: list[str] = []

    current_context = "unknown"

    lines = text.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        ctx_match = CONTEXT_RE.match(line)
        if ctx_match:
            current_context = ctx_match.group(1).strip().lower()
            index += 1
            continue

        failed_match = MEAS_FAILED_RE.match(line)
        if failed_match:
            name = failed_match.group(2).strip()
            if not wanted or name in wanted:
                raw_measure_lines.append(line.strip())
                analysis_context[name] = failed_match.group(1).strip().lower()
                failed_metrics[name] = {
                    "reason": line.strip(),
                    "analysis": failed_match.group(1).strip().lower(),
                }
            index += 1
            continue

        meas_match = MEAS_LINE_RE.match(line)
        if not meas_match:
            index += 1
            continue

        name = meas_match.group(1).strip()
        raw_value = meas_match.group(2).strip()
        if not raw_value:
            next_index = index + 1
            while next_index < len(lines):
                candidate = lines[next_index].strip()
                if not candidate:
                    next_index += 1
                    continue
                raw_value = candidate
                index = next_index
                break
            if not raw_value:
                index += 1
                continue

        if wanted and name not in wanted:
            index += 1
            continue

        raw_measure_lines.append(line.strip())
        analysis_context[name] = current_context

        numeric_match = NUMERIC_TOKEN_RE.match(raw_value)
        if numeric_match:
            try:
                metrics[name] = float(numeric_match.group(1))
            except ValueError:
                warnings.append(f"failed to parse metric value for {name}: {raw_value}")
                failed_metrics[name] = {
                    "reason": raw_value,
                    "analysis": current_context,
                }
            index += 1
            continue

        # Preserve the failure reason, for example "Error: Bad value."
        failed_metrics[name] = {
            "reason": raw_value,
            "analysis": current_context,
        }
        index += 1

    return {
        "metrics": metrics,
        "failed_metrics": failed_metrics,
        "raw_measure_lines": raw_measure_lines,
        "analysis_context": analysis_context,
        "warnings": warnings,
    }


def main() -> int:
    args = build_parser().parse_args()
    log_path = Path(args.log_path).resolve()
    wanted = {name.strip() for name in args.metric if name.strip()}

    result = {
        "metrics": {},
        "failed_metrics": {},
        "raw_measure_lines": [],
        "analysis_context": {},
        "warnings": [],
    }

    if not log_path.exists():
        result["warnings"].append(f"log not found: {log_path}")
        print(json.dumps(result, ensure_ascii=False))
        return 1

    parsed = parse_measurements(log_path.read_text(encoding="utf-8-sig", errors="ignore"), wanted)
    result.update(parsed)

    missing_metrics: list[str] = []
    failed_requested_metrics: list[str] = []
    if wanted:
        present = set(result["metrics"])
        failed = set(result["failed_metrics"])
        missing_metrics = sorted(wanted - present - failed)
        failed_requested_metrics = sorted(wanted & failed)
        if missing_metrics:
            result["warnings"].append(
                "requested metrics missing from log: " + ", ".join(missing_metrics)
            )
        if failed_requested_metrics:
            result["warnings"].append(
                "requested metrics failed to evaluate: " + ", ".join(failed_requested_metrics)
            )

    if not result["metrics"] and not result["failed_metrics"]:
        result["warnings"].append("no measurements parsed from log")

    if wanted:
        result["requested_metrics"] = sorted(wanted)
        result["missing_metrics"] = missing_metrics
        result["failed_requested_metrics"] = failed_requested_metrics

    print(json.dumps(result, ensure_ascii=False))

    if wanted:
        ok = (not missing_metrics) and (not failed_requested_metrics)
        return 0 if ok else 1

    return 0 if result["metrics"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
