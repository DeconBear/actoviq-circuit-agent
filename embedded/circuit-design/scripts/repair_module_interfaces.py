#!/usr/bin/env python3
"""Repair accidental reuse of final output nets across partitioned modules."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


MODULE_RE = re.compile(r"^\s*[;*$]\s*MODULE\s+(?:\d+\s*:\s*)?([A-Za-z0-9_+\- /]+)", re.IGNORECASE)
TOKEN_RE = re.compile(r"(?<![A-Za-z0-9_])({})(?![A-Za-z0-9_])")
RAIL_NETS = {"0", "gnd", "vss", "vee", "vdd", "vcc"}


def sanitize_module_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.strip().lower()).strip("_") or "module"


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def nonrail_nets(values: list[Any], *, exclude: set[str] | None = None) -> list[str]:
    excluded = {item.lower() for item in (exclude or set())}
    result: list[str] = []
    for value in values:
        net = str(value).strip()
        if not net:
            continue
        lower = net.lower()
        if lower in RAIL_NETS or lower in excluded:
            continue
        result.append(net)
    return result


def module_section_name(line: str) -> str | None:
    match = MODULE_RE.match(line)
    if not match:
        return None
    return sanitize_module_name(match.group(1))


def is_editable_instance_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped or stripped.startswith(("*", ";", ".")):
        return False
    return bool(stripped[0].isalpha())


def choose_replacement(
    modules: list[dict[str, Any]],
    index: int,
    output_node: str,
) -> str | None:
    current = modules[index]
    current_outputs = nonrail_nets(current.get("output_nets", []), exclude={output_node})
    current_inputs = nonrail_nets(current.get("input_nets", []), exclude={output_node})

    if index > 0:
        previous_outputs = set(nonrail_nets(modules[index - 1].get("output_nets", []), exclude={output_node}))
        for net in current_inputs:
            if net in previous_outputs:
                return net
        if current_inputs:
            return current_inputs[0]

    if index + 1 < len(modules):
        next_inputs = set(nonrail_nets(modules[index + 1].get("input_nets", []), exclude={output_node}))
        for net in current_outputs:
            if net in next_inputs:
                return net
        if current_outputs:
            return current_outputs[0]

    return current_outputs[0] if current_outputs else (current_inputs[0] if current_inputs else None)


def build_module_replacements(module_plan: dict[str, Any], output_node: str) -> dict[str, str]:
    modules = [item for item in module_plan.get("modules", []) if isinstance(item, dict)]
    replacements: dict[str, str] = {}
    if not output_node or len(modules) < 2:
        return replacements

    for index, module in enumerate(modules):
        name = sanitize_module_name(str(module.get("name") or ""))
        allowed = {
            str(net).strip().lower()
            for net in [*module.get("input_nets", []), *module.get("output_nets", [])]
            if str(net).strip()
        }
        if output_node.lower() in allowed:
            continue
        replacement = choose_replacement(modules, index, output_node)
        if replacement:
            replacements[name] = replacement
    return replacements


def repair_text(text: str, replacements: dict[str, str], output_node: str) -> tuple[str, list[dict[str, Any]]]:
    pattern = TOKEN_RE.pattern.format(re.escape(output_node))
    token_re = re.compile(pattern)
    current_module = ""
    changed_lines: list[dict[str, Any]] = []
    output_lines: list[str] = []

    for line_no, line in enumerate(text.splitlines(), start=1):
        detected = module_section_name(line)
        if detected:
            current_module = detected

        replacement = replacements.get(current_module)
        if replacement and is_editable_instance_line(line) and token_re.search(line):
            new_line = token_re.sub(replacement, line)
            changed_lines.append(
                {
                    "line": line_no,
                    "module": current_module,
                    "from": output_node,
                    "to": replacement,
                    "before": line,
                    "after": new_line,
                }
            )
            output_lines.append(new_line)
        else:
            output_lines.append(line)

    trailing_newline = "\n" if text.endswith(("\n", "\r\n")) else ""
    return "\n".join(output_lines) + trailing_newline, changed_lines


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Repair partitioned module interface net reuse")
    parser.add_argument("--netlist-path", required=True)
    parser.add_argument("--module-plan-path", required=True)
    parser.add_argument("--spec-path", required=True)
    parser.add_argument("--output-path", default="")
    parser.add_argument("--apply", action="store_true")
    return parser


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    args = build_parser().parse_args()
    netlist_path = Path(args.netlist_path).resolve()
    module_plan_path = Path(args.module_plan_path).resolve()
    spec_path = Path(args.spec_path).resolve()
    result: dict[str, Any] = {
        "ok": False,
        "changed": False,
        "netlist_path": str(netlist_path),
        "module_plan_path": str(module_plan_path),
        "spec_path": str(spec_path),
        "changes": [],
        "warnings": [],
    }

    if not netlist_path.exists() or not module_plan_path.exists() or not spec_path.exists():
        result["warnings"].append("netlist, module plan, or spec path does not exist")
        print(json.dumps(result, ensure_ascii=False))
        return 1

    spec = read_json(spec_path)
    module_plan = read_json(module_plan_path)
    output_node = str(spec.get("output_node") or "").strip()
    if not output_node:
        result["warnings"].append("spec has no output_node; no repair attempted")
        result["ok"] = True
    else:
        replacements = build_module_replacements(module_plan, output_node)
        original = netlist_path.read_text(encoding="utf-8-sig", errors="ignore")
        repaired, changes = repair_text(original, replacements, output_node)
        result["changes"] = changes
        result["changed"] = bool(changes)
        result["replacements"] = replacements
        if changes and args.apply:
            netlist_path.write_text(repaired, encoding="utf-8")
        result["ok"] = True

    if args.output_path:
        output_path = Path(args.output_path).resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
