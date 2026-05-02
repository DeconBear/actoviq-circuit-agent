#!/usr/bin/env python3
"""Compare simulated metrics against target specs."""

from __future__ import annotations

import argparse
import json
from numbers import Number
from pathlib import Path


DEFAULT_METRIC_ALIASES = {
    "vdd_v": ["supply_v", "vdd_val", "vdd", "supply"],
    "rf_freq_hz": ["frequency_hz", "rf_frequency_hz", "f0", "freq_hz"],
    "rf_gain_db": ["gain_db", "ac_gain_db", "rf_gain", "gain", "s21_db"],
    "rf_gain_db_min": ["rf_gain_db", "gain_db", "ac_gain_db", "rf_gain", "gain", "s21_db"],
    "detector_output_min_v": ["detector_output_v", "det_v", "det_out_pk", "det_out_v"],
    "detector_output_max_v": ["detector_output_v", "det_v", "det_out_pk", "det_out_v"],
    "baseband_gain_db": ["bb_gain_db", "baseband_gain", "gain_bb_db"],
    "lpf_cutoff_hz": ["lpf_fc", "lpf_f3db", "f_3db", "cutoff_hz", "rc_cutoff_hz"],
    "vth_low_v": ["vth_low_meas", "window_low_v", "vth_l", "vth_low", "threshold_low_v", "low_threshold_v"],
    "vth_high_v": ["vth_high_meas", "window_high_v", "vth_h", "vth_high", "threshold_high_v", "high_threshold_v"],
    "window_low_v": ["vth_l", "vth_low", "threshold_low_v", "low_threshold_v"],
    "window_high_v": ["vth_h", "vth_high", "threshold_high_v", "high_threshold_v"],
    "alarm_delay_us": ["tdelay", "delay", "propagation_delay_us", "alarm_delay"],
    "alarm_response_delay_us_max": ["alarm_delay_us", "tdelay", "delay", "propagation_delay_us", "alarm_delay"],
    "supply_v": ["vdd_val", "vdd", "supply"],
    "input_impedance_ohm": ["zin_re", "zin", "rin_ohm"],
}

NON_SIMULATION_TARGETS = {
    "schematic_canonical_renderer",
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Evaluate metrics against spec")
    parser.add_argument("--spec-path", required=True, help="Path to spec JSON")
    parser.add_argument("--metrics-path", required=True, help="Path to metrics JSON")
    return parser


def pick_targets(spec: dict) -> tuple[dict, str]:
    targets_eval = spec.get("targets_eval")
    if isinstance(targets_eval, dict) and targets_eval:
        return targets_eval, "targets_eval"
    targets = spec.get("targets")
    if isinstance(targets, dict):
        return targets, "targets"
    return {}, "none"


def resolve_actual(
    name: str,
    metrics: dict,
    failed: dict,
    metric_aliases: dict[str, list[str]],
) -> tuple[object | None, str | None, str | None]:
    if name in metrics:
        return metrics[name], name, None
    if name in failed:
        reason = failed[name].get("reason", "unknown")
        return None, None, f"{name} failed: {reason}"

    aliases = [*DEFAULT_METRIC_ALIASES.get(name, []), *coerce_aliases(metric_aliases.get(name, []))]
    for alias in aliases:
        if alias in metrics:
            return normalize_units(name, alias, metrics[alias]), alias, None
        if alias in failed:
            reason = failed[alias].get("reason", "unknown")
            return None, None, f"{alias} failed (alias for {name}): {reason}"
    return None, None, None


def coerce_aliases(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str)]
    return []


def is_numeric(value: object) -> bool:
    return isinstance(value, Number) and not isinstance(value, bool)


def normalize_units(target_name: str, source_metric: str, value: object) -> object:
    # ngspice .meas delays are commonly seconds unless the metric name carries
    # an explicit unit suffix. Specs use *_us for human-facing delay targets.
    if target_name.endswith("_us") and not source_metric.endswith("_us") and is_numeric(value) and abs(value) < 1:
        return value * 1_000_000
    return value


def normalize_rule(name: str, rule: object) -> tuple[dict | None, str | None]:
    if isinstance(rule, dict):
        return rule, None
    if name in NON_SIMULATION_TARGETS:
        return None, "non-simulation target"
    if isinstance(rule, bool) or isinstance(rule, str):
        return {"value": rule}, None
    if is_numeric(rule):
        if name.endswith("_min") or "_min_" in name:
            return {"min": rule}, None
        if name.endswith("_max") or "_max_" in name:
            return {"max": rule}, None
        tolerance = max(abs(rule) * 0.05, 1e-12)
        return {"value": rule, "tolerance": tolerance}, None
    return None, f"unsupported rule type: {type(rule).__name__}"


def evaluate_value_rule(name: str, actual: object, expected: object, tolerance: object, result: dict) -> bool:
    if is_numeric(actual) and is_numeric(expected):
        numeric_tolerance = tolerance if is_numeric(tolerance) else 0
        delta = actual - expected
        if abs(delta) <= numeric_tolerance:
            return True
        result["gaps"].append(
            {
                "name": name,
                "kind": "value",
                "target": expected,
                "actual": actual,
                "tolerance": numeric_tolerance,
                "delta": delta,
            }
        )
        return False

    if actual == expected:
        return True

    result["gaps"].append(
        {
            "name": name,
            "kind": "value",
            "target": expected,
            "actual": actual,
        }
    )
    return False


def main() -> int:
    args = build_parser().parse_args()
    spec_path = Path(args.spec_path).resolve()
    metrics_path = Path(args.metrics_path).resolve()

    result = {
        "pass": False,
        "gaps": [],
        "missing_metrics": [],
        "failed_metrics": [],
        "skipped_targets": [],
        "used_aliases": {},
        "target_source": "none",
    }

    if not spec_path.exists() or not metrics_path.exists():
        if not spec_path.exists():
            result["missing_metrics"].append(f"missing spec file: {spec_path}")
        if not metrics_path.exists():
            result["missing_metrics"].append(f"missing metrics file: {metrics_path}")
        print(json.dumps(result, ensure_ascii=False))
        return 1

    spec = json.loads(spec_path.read_text(encoding="utf-8-sig"))
    metrics_json = json.loads(metrics_path.read_text(encoding="utf-8-sig"))
    metrics = metrics_json.get("metrics", metrics_json)
    failed = metrics_json.get("failed_metrics", {})

    targets, target_source = pick_targets(spec)
    result["target_source"] = target_source
    if not targets:
        result["missing_metrics"].append("spec targets missing or invalid")
        print(json.dumps(result, ensure_ascii=False))
        return 1

    metric_aliases = spec.get("metric_aliases", {})
    if not isinstance(metric_aliases, dict):
        metric_aliases = {}

    all_pass = True
    for name, rule in targets.items():
        normalized_rule, skip_reason = normalize_rule(name, rule)
        if skip_reason:
            result["skipped_targets"].append({"name": name, "reason": skip_reason})
            continue
        if normalized_rule is None:
            result["gaps"].append({"name": name, "reason": "invalid rule format"})
            all_pass = False
            continue

        actual, source_metric, failure_reason = resolve_actual(name, metrics, failed, metric_aliases)
        if actual is None:
            if failure_reason:
                result["failed_metrics"].append({"name": name, "reason": failure_reason})
            else:
                result["missing_metrics"].append(name)
            all_pass = False
            continue

        if source_metric and source_metric != name:
            result["used_aliases"][name] = source_metric

        if "value" in normalized_rule:
            if not evaluate_value_rule(
                name,
                actual,
                normalized_rule["value"],
                normalized_rule.get("tolerance", 0),
                result,
            ):
                all_pass = False

        if "min" in normalized_rule and (not is_numeric(actual) or actual < normalized_rule["min"]):
            result["gaps"].append(
                {
                    "name": name,
                    "kind": "min",
                    "target": normalized_rule["min"],
                    "actual": actual,
                    "delta": actual - normalized_rule["min"] if is_numeric(actual) else None,
                }
            )
            all_pass = False
        if "max" in normalized_rule and (not is_numeric(actual) or actual > normalized_rule["max"]):
            result["gaps"].append(
                {
                    "name": name,
                    "kind": "max",
                    "target": normalized_rule["max"],
                    "actual": actual,
                    "delta": actual - normalized_rule["max"] if is_numeric(actual) else None,
                }
            )
            all_pass = False

    result["pass"] = all_pass
    print(json.dumps(result, ensure_ascii=False))
    return 0 if all_pass else 1


if __name__ == "__main__":
    raise SystemExit(main())
