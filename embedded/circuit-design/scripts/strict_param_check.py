#!/usr/bin/env python3
"""Fail-fast validation for primitive netlists: parameter completeness and parseability."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from netlist_to_json import (
    apply_value_resolution,
    is_control_directive,
    merge_continuation_lines,
    parse_component_line,
    parse_param_assignments,
)


VALUE_RE = re.compile(r"^\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*([A-Za-z\u00b5\u03a9]+)?\s*$")
PARAM_REF_RE = re.compile(r"^\{([A-Za-z_][A-Za-z0-9_]*)\}$")
IDENT_RE = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)\b")

KNOWN_SUFFIXES = {"", "f", "p", "n", "u", "m", "k", "meg", "g", "t"}
KNOWN_UNIT_TAILS = {"", "ohm", "f", "h", "v", "a"}
WANT_UNIT_TYPES = {"capacitor", "inductor"}
SOURCE_KEYWORDS = {"dc", "ac", "pulse", "sin", "exp", "pwl", "sffm", "am"}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Strict parameter completeness gate")
    parser.add_argument("--netlist-path", required=True, help="Input netlist path")
    parser.add_argument(
        "--allow-expression",
        action="store_true",
        help="Allow arithmetic expressions where a plain scalar is expected",
    )
    parser.add_argument(
        "--output-path",
        default="",
        help="Optional JSON output path",
    )
    return parser


def parse_scalar(token: str) -> tuple[bool, bool]:
    match = VALUE_RE.match(token.strip())
    if not match:
        return False, False
    suffix = (match.group(2) or "").replace("µ", "u").replace("Ω", "ohm").lower()
    if suffix in KNOWN_SUFFIXES:
        return True, bool(suffix)
    if suffix in KNOWN_UNIT_TAILS and suffix:
        return True, True
    if suffix.startswith("meg"):
        tail = suffix[3:]
        return (tail in KNOWN_UNIT_TAILS), bool(tail)
    if suffix and suffix[0] in {"t", "g", "k", "m", "u", "n", "p", "f"}:
        tail = suffix[1:]
        return (tail in KNOWN_UNIT_TAILS), bool(suffix)
    return False, False


def has_unresolved_ident(expr: str) -> bool:
    for ident in IDENT_RE.findall(expr):
        ident_l = ident.lower()
        if ident_l in SOURCE_KEYWORDS:
            continue
        if ident_l in {"e", "pi"}:
            continue
        return True
    return False


def source_numeric_tokens(value: str) -> list[str]:
    text = value.strip()
    if not text:
        return []
    parts = text.replace("(", " ").replace(")", " ").replace(",", " ").split()
    out: list[str] = []
    i = 0
    while i < len(parts):
        cur = parts[i]
        if cur.lower() in {"dc", "ac"} and i + 1 < len(parts):
            out.append(parts[i + 1])
            i += 2
            continue
        if cur.lower() in SOURCE_KEYWORDS:
            i += 1
            continue
        out.append(cur)
        i += 1
    return out


def check_passive(
    *,
    value: str,
    comp_type: str,
    allow_expression: bool,
) -> tuple[bool, str]:
    token = value.split()[0] if value.split() else ""
    if not token:
        return False, "missing_scalar_value"

    ok_scalar, has_unit = parse_scalar(token)
    if ok_scalar:
        if comp_type in WANT_UNIT_TYPES and not has_unit:
            return False, "missing_unit_suffix"
        return True, ""

    if allow_expression:
        if has_unresolved_ident(token):
            return False, "unresolved_expression_token"
        return True, ""

    return False, "unparseable_scalar_value"


def check_source(value: str, allow_expression: bool) -> tuple[bool, str]:
    tokens = source_numeric_tokens(value)
    if not tokens:
        return False, "missing_source_value"

    any_ok = False
    for token in tokens:
        ok_scalar, _ = parse_scalar(token)
        if ok_scalar:
            any_ok = True
            continue
        param_match = PARAM_REF_RE.match(token)
        if param_match:
            any_ok = True
            continue
        if allow_expression and not has_unresolved_ident(token):
            any_ok = True
            continue
    if not any_ok:
        return False, "source_value_not_parseable"
    return True, ""


def check_bjt_or_diode(value: str) -> tuple[bool, str]:
    token = value.split()[0] if value.split() else ""
    if not token:
        return False, "missing_model_token"
    if VALUE_RE.match(token):
        return False, "model_token_looks_numeric"
    return True, ""


def check_mos(value: str, allow_expression: bool) -> tuple[bool, str]:
    tokens = value.split()
    if not tokens:
        return False, "missing_model_token"
    model = tokens[0]
    if VALUE_RE.match(model):
        return False, "model_token_looks_numeric"

    for tok in tokens[1:]:
        if "=" not in tok:
            continue
        key, val = tok.split("=", 1)
        if not val.strip():
            return False, f"empty_assignment_{key.lower()}"
        ok_scalar, has_unit = parse_scalar(val)
        if ok_scalar:
            if key.strip().lower() in {"w", "l", "ad", "as", "pd", "ps"} and not has_unit:
                return False, f"missing_unit_suffix_{key.lower()}"
            continue
        if allow_expression and not has_unresolved_ident(val):
            continue
        return False, f"unparseable_assignment_{key.lower()}"
    return True, ""


def classify_component(comp: dict, allow_expression: bool) -> tuple[bool, str]:
    comp_type = str(comp.get("type", ""))
    value = str(comp.get("value", "")).strip()
    if not value or value == "<missing_param>":
        return False, "missing_parameter"

    if comp_type in {"resistor", "capacitor", "inductor"}:
        return check_passive(value=value, comp_type=comp_type, allow_expression=allow_expression)
    if comp_type in {"voltage_source", "current_source"}:
        return check_source(value, allow_expression)
    if comp_type in {"diode", "bjt"}:
        return check_bjt_or_diode(value)
    if comp_type == "mosfet":
        return check_mos(value, allow_expression)

    return False, "unsupported_component_type_for_strict_check"


def main() -> int:
    args = build_parser().parse_args()
    netlist_path = Path(args.netlist_path).resolve()
    output_path = Path(args.output_path).resolve() if args.output_path else None

    result = {
        "ok": False,
        "netlist_path": str(netlist_path),
        "violations": [],
        "warnings": [],
        "summary": {
            "checked_components": 0,
            "violating_components": 0,
            "skipped_components": 0,
        },
    }

    if not netlist_path.exists():
        result["violations"].append(
            {"line": 0, "ref": "", "kind": "missing_file", "message": f"netlist not found: {netlist_path}"}
        )
        payload = json.dumps(result, ensure_ascii=False)
        if output_path:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(payload + "\n", encoding="utf-8")
        print(payload)
        return 1

    content = netlist_path.read_text(encoding="utf-8-sig", errors="ignore")
    merged_lines = merge_continuation_lines(content)
    params = parse_param_assignments(merged_lines)

    warnings: list[str] = []
    components: list[dict] = []
    in_control_block = False
    for line_no, line in merged_lines:
        if is_control_directive(line, ".control"):
            in_control_block = True
            continue
        if is_control_directive(line, ".endc"):
            in_control_block = False
            continue
        if in_control_block:
            continue
        comp = parse_component_line(line, line_no, warnings)
        if not comp:
            continue
        apply_value_resolution(comp, params)
        components.append(comp)

    result["warnings"].extend(warnings)

    for comp in components:
        comp_type = str(comp.get("type", ""))
        if comp_type in {"unknown", "subckt", "vcvs", "vccs", "cccs", "ccvs", "behavioral", "xspice", "ic"}:
            result["summary"]["skipped_components"] += 1
            result["warnings"].append(
                f"skipped strict check for unsupported type: {comp.get('name', '?')} ({comp_type})"
            )
            continue

        result["summary"]["checked_components"] += 1
        ok, reason = classify_component(comp, args.allow_expression)
        if ok:
            continue
        result["summary"]["violating_components"] += 1
        result["violations"].append(
            {
                "line": comp.get("line_no", 0),
                "ref": comp.get("name", ""),
                "type": comp_type,
                "kind": reason,
                "value": comp.get("value", ""),
                "message": f"strict check failed: {reason}",
            }
        )

    result["ok"] = len(result["violations"]) == 0
    payload = json.dumps(result, ensure_ascii=False)
    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(payload + "\n", encoding="utf-8")
    print(payload)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
