#!/usr/bin/env python3
"""Normalize spec targets and derive metric aliases across units."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Normalize spec targets")
    parser.add_argument("--spec-path", required=True, help="Input spec JSON path")
    parser.add_argument("--output-path", default="", help="Output path (default: overwrite spec)")
    parser.add_argument(
        "--evaluation-mode",
        choices=["original", "all"],
        default="original",
        help="Which targets evaluator should enforce by default",
    )
    parser.add_argument(
        "--no-derive-counterparts",
        action="store_true",
        help="Disable linear<->dB counterpart derivation",
    )
    return parser


def db_to_lin(db_value: float) -> float:
    return 10 ** (db_value / 20.0)


def lin_to_db(lin_value: float) -> float:
    return 20.0 * math.log10(lin_value)


def derive_name(metric_name: str) -> tuple[str | None, str | None]:
    if "_db_" in metric_name:
        return metric_name.replace("_db_", "_lin_", 1), "db_to_lin"
    if "_lin_" in metric_name:
        return metric_name.replace("_lin_", "_db_", 1), "lin_to_db"
    if metric_name.endswith("_db"):
        return metric_name[: -len("_db")] + "_lin", "db_to_lin"
    if metric_name.endswith("_lin"):
        return metric_name[: -len("_lin")] + "_db", "lin_to_db"
    return None, None


def convert_rule(rule: dict, direction: str) -> tuple[dict | None, str | None]:
    converted: dict[str, float] = {}
    if direction == "db_to_lin":
        if "min" in rule:
            converted["min"] = db_to_lin(float(rule["min"]))
        if "max" in rule:
            converted["max"] = db_to_lin(float(rule["max"]))
        return converted, None
    if direction == "lin_to_db":
        if "min" in rule:
            value = float(rule["min"])
            if value <= 0:
                return None, "min <= 0 cannot be converted to dB"
            converted["min"] = lin_to_db(value)
        if "max" in rule:
            value = float(rule["max"])
            if value <= 0:
                return None, "max <= 0 cannot be converted to dB"
            converted["max"] = lin_to_db(value)
        return converted, None
    return None, f"unknown conversion direction: {direction}"


def main() -> int:
    args = build_parser().parse_args()
    spec_path = Path(args.spec_path).resolve()
    output_path = Path(args.output_path).resolve() if args.output_path else spec_path

    result = {"ok": False, "output_path": str(output_path), "warnings": [], "derived_metrics": []}

    if not spec_path.exists():
        result["warnings"].append(f"spec not found: {spec_path}")
        print(json.dumps(result, ensure_ascii=False))
        return 1

    spec = json.loads(spec_path.read_text(encoding="utf-8-sig"))
    targets = spec.get("targets")
    if not isinstance(targets, dict):
        result["warnings"].append("spec.targets must be an object")
        print(json.dumps(result, ensure_ascii=False))
        return 1

    original_targets = {str(k): v for k, v in targets.items()}
    normalized_targets = dict(original_targets)
    metric_aliases: dict[str, list[str]] = {}

    derive_counterparts = not args.no_derive_counterparts

    if derive_counterparts:
        for metric_name, rule in original_targets.items():
            if not isinstance(rule, dict):
                result["warnings"].append(f"metric {metric_name}: invalid rule format")
                continue
            counterpart, direction = derive_name(metric_name)
            if counterpart is None or direction is None:
                continue
            converted_rule, error = convert_rule(rule, direction)
            if error:
                result["warnings"].append(f"metric {metric_name}: {error}")
                continue
            if counterpart in normalized_targets:
                metric_aliases.setdefault(metric_name, [])
                if counterpart not in metric_aliases[metric_name]:
                    metric_aliases[metric_name].append(counterpart)
                continue
            normalized_targets[counterpart] = converted_rule
            metric_aliases.setdefault(metric_name, [])
            metric_aliases[metric_name].append(counterpart)
            result["derived_metrics"].append(
                {
                    "from": metric_name,
                    "to": counterpart,
                    "direction": direction,
                }
            )

    if args.evaluation_mode == "all":
        targets_eval = normalized_targets
    else:
        targets_eval = original_targets

    spec["targets"] = normalized_targets
    spec["targets_eval"] = targets_eval
    if metric_aliases:
        existing_aliases = spec.get("metric_aliases", {})
        if not isinstance(existing_aliases, dict):
            existing_aliases = {}
        for key, values in metric_aliases.items():
            merged = list(dict.fromkeys(existing_aliases.get(key, []) + values))
            existing_aliases[key] = merged
        spec["metric_aliases"] = existing_aliases
    spec["normalization"] = {
        "evaluation_mode": args.evaluation_mode,
        "derived_counterparts_enabled": derive_counterparts,
        "derived_metrics": result["derived_metrics"],
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8")

    result["ok"] = True
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
