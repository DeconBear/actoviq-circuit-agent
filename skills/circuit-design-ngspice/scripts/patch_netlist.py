#!/usr/bin/env python3
"""Apply deterministic patch plans to SPICE netlists."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


PARAM_RE_TEMPLATE = r"^(\s*\.param\s+{name}\s*=\s*)([^\s;]+)(.*)$"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Patch SPICE netlist")
    parser.add_argument("--netlist-path", required=True, help="Input netlist path")
    parser.add_argument("--patch-plan-path", required=True, help="Patch plan JSON path")
    parser.add_argument("--output-path", default="", help="Output netlist path; default overwrite")
    return parser


def apply_set_param(text: str, set_param: dict[str, str], summary: list[str]) -> str:
    lines = text.splitlines()
    existing_params = set()

    for i, line in enumerate(lines):
        if not line.strip().lower().startswith(".param"):
            continue
        for name, value in set_param.items():
            pattern = re.compile(PARAM_RE_TEMPLATE.format(name=re.escape(name)), re.IGNORECASE)
            match = pattern.match(line)
            if not match:
                continue
            old_value = match.group(2)
            lines[i] = f"{match.group(1)}{value}{match.group(3)}"
            existing_params.add(name)
            if old_value != value:
                summary.append(f".param {name}: {old_value} -> {value}")

    for name, value in set_param.items():
        if name in existing_params:
            continue
        lines.append(f".param {name}={value}")
        summary.append(f".param {name}: <new> -> {value}")

    return "\n".join(lines) + "\n"


def apply_replace_text(text: str, replace_items: list[dict], summary: list[str]) -> str:
    patched = text
    for item in replace_items:
        old = str(item.get("old", ""))
        new = str(item.get("new", ""))
        if not old:
            continue
        if old not in patched:
            summary.append(f"replace_text miss: {old[:60]}")
            continue
        patched = patched.replace(old, new)
        summary.append(f"replace_text hit: {old[:30]} -> {new[:30]}")
    return patched


def main() -> int:
    args = build_parser().parse_args()
    netlist_path = Path(args.netlist_path).resolve()
    patch_plan_path = Path(args.patch_plan_path).resolve()
    output_path = Path(args.output_path).resolve() if args.output_path else netlist_path

    result = {"ok": False, "updated_netlist_path": str(output_path), "diff_summary": []}

    if not netlist_path.exists():
        result["diff_summary"].append(f"netlist not found: {netlist_path}")
        print(json.dumps(result, ensure_ascii=False))
        return 1
    if not patch_plan_path.exists():
        result["diff_summary"].append(f"patch plan not found: {patch_plan_path}")
        print(json.dumps(result, ensure_ascii=False))
        return 1

    text = netlist_path.read_text(encoding="utf-8", errors="ignore")
    plan = json.loads(patch_plan_path.read_text(encoding="utf-8-sig"))
    summary: list[str] = []

    set_param = plan.get("set_param", {})
    if isinstance(set_param, dict) and set_param:
        text = apply_set_param(text, {str(k): str(v) for k, v in set_param.items()}, summary)

    replace_items = plan.get("replace_text", [])
    if isinstance(replace_items, list) and replace_items:
        text = apply_replace_text(text, replace_items, summary)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(text, encoding="utf-8")

    result["ok"] = True
    result["diff_summary"] = summary
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
