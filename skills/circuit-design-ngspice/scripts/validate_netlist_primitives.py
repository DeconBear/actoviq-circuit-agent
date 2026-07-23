#!/usr/bin/env python3
"""Validate that a SPICE netlist uses kind-appropriate components."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    from project_kinds import (
        DEFAULT_PROJECT_KIND,
        allowed_netlist_prefixes,
        forbidden_directives,
        normalize_project_kind,
    )
except ImportError:  # pragma: no cover - script may run without package context
    DEFAULT_PROJECT_KIND = "simulation"

    def normalize_project_kind(value):
        text = str(value or "").strip().casefold()
        return text if text in {"simulation", "pcb_schematic", "analog_ic"} else DEFAULT_PROJECT_KIND

    def allowed_netlist_prefixes(project_kind):
        kind = normalize_project_kind(project_kind)
        if kind == "pcb_schematic":
            return {"R", "C", "L", "Q", "M", "D", "V", "I", "X", "U", "E"}
        if kind == "analog_ic":
            return {"R", "C", "L", "Q", "M", "D", "V", "I", "X", "U", "E", "F", "G", "H", "B"}
        return {"R", "C", "L", "Q", "M", "D", "V", "I"}

    def forbidden_directives(project_kind):
        kind = normalize_project_kind(project_kind)
        if kind == "simulation":
            return {".subckt", ".ends", ".include", ".lib"}
        return set()


NODE_COUNT_BY_PREFIX = {
    "R": 2,
    "C": 2,
    "L": 2,
    "D": 2,
    "V": 2,
    "I": 2,
    "Q": 3,
    "M": 4,
    "E": 4,
    "F": 2,
    "G": 4,
    "H": 2,
    "B": 2,
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate SPICE netlist for a project kind")
    parser.add_argument("--netlist-path", required=True, help="Input netlist path")
    parser.add_argument(
        "--project-kind",
        default=DEFAULT_PROJECT_KIND,
        choices=["simulation", "pcb_schematic", "analog_ic"],
        help="Project kind gate (default: simulation / primitive-only).",
    )
    return parser


def is_comment_or_blank(line: str) -> bool:
    stripped = line.strip()
    return not stripped or stripped.startswith("*") or stripped.startswith(";")


def strip_inline_comment(line: str) -> str:
    stripped = line.lstrip("\ufeff")
    if not stripped:
        return ""
    lead = stripped.lstrip()
    if not lead or lead.startswith("*") or lead.startswith(";"):
        return ""

    in_quote = False
    escaped = False
    out: list[str] = []
    for ch in stripped:
        if escaped:
            out.append(ch)
            escaped = False
            continue
        if ch == "\\":
            out.append(ch)
            escaped = True
            continue
        if ch == "'":
            in_quote = not in_quote
            out.append(ch)
            continue
        if ch == ";" and not in_quote:
            break
        out.append(ch)
    return "".join(out).strip()


def merge_continuation_lines(lines: list[str]) -> list[tuple[int, str]]:
    entries: list[tuple[int, str]] = []
    current = ""
    current_line = 0
    for lineno, raw in enumerate(lines, start=1):
        raw = raw.lstrip("\ufeff")
        stripped = raw.strip()
        if not stripped:
            if current:
                entries.append((current_line, current))
                current = ""
                current_line = 0
            continue
        if stripped.startswith("+"):
            continuation = stripped[1:].strip()
            if current:
                if continuation:
                    current = f"{current} {continuation}"
            else:
                current = continuation
                current_line = lineno
            continue
        if current:
            entries.append((current_line, current))
        current = raw.rstrip()
        current_line = lineno
    if current:
        entries.append((current_line, current))
    return entries


def check_required_params(result: dict, *, lineno: int, token: str, tokens: list[str]) -> None:
    lead = token[:1].upper()
    required_nodes = NODE_COUNT_BY_PREFIX.get(lead)
    if required_nodes is None:
        return
    required_min = 1 + required_nodes + 1
    if len(tokens) < required_min:
        result["violations"].append(
            {
                "line": lineno,
                "kind": "missing_param",
                "token": token,
                "message": (
                    f"instance '{token}' is missing required parameter/model tokens; "
                    f"expected >= {required_min} tokens, got {len(tokens)}"
                ),
            }
        )
        result["summary"]["missing_param_count"] += 1
        return
    param_tokens = tokens[1 + required_nodes :]
    if not " ".join(param_tokens).strip():
        result["violations"].append(
            {
                "line": lineno,
                "kind": "missing_param",
                "token": token,
                "message": f"instance '{token}' has empty parameter/model field",
            }
        )
        result["summary"]["missing_param_count"] += 1


def validate_netlist_text(
    netlist_text: str,
    project_kind: str = DEFAULT_PROJECT_KIND,
    *,
    source: str = "<memory>",
) -> dict:
    """Return the kind-scoped primitive/directive validation result."""
    kind = normalize_project_kind(project_kind)
    allowed = allowed_netlist_prefixes(kind)
    forbidden_dirs = {item.casefold() for item in forbidden_directives(kind)}
    result = {
        "ok": False,
        "netlist_path": source,
        "project_kind": kind,
        "violations": [],
        "warnings": [],
        "summary": {
            "allowed_instance_count": 0,
            "forbidden_instance_count": 0,
            "forbidden_directive_count": 0,
            "missing_param_count": 0,
        },
    }
    merged_lines = merge_continuation_lines(netlist_text.splitlines())
    for lineno, raw_line in merged_lines:
        stripped_line = strip_inline_comment(raw_line)
        if is_comment_or_blank(stripped_line):
            continue

        stripped = stripped_line.strip()
        if stripped.startswith("+"):
            continue

        tokens = stripped.split()
        token = tokens[0]
        token_lower = token.lower()
        if token.startswith("."):
            if token_lower in forbidden_dirs:
                result["violations"].append({
                    "line": lineno,
                    "kind": "forbidden_directive",
                    "token": token,
                    "message": f"directive '{token}' is forbidden for project_kind={kind}",
                })
                result["summary"]["forbidden_directive_count"] += 1
            continue

        lead = token[:1].upper()
        if lead in allowed:
            result["summary"]["allowed_instance_count"] += 1
            check_required_params(result, lineno=lineno, token=token, tokens=tokens)
            continue

        result["violations"].append({
            "line": lineno,
            "kind": "forbidden_instance",
            "token": token,
            "message": (
                f"instance '{token}' uses prefix '{lead}', "
                f"not allowed for project_kind={kind}"
            ),
        })
        result["summary"]["forbidden_instance_count"] += 1

    result["ok"] = not result["violations"]
    return result


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    args = build_parser().parse_args()
    netlist_path = Path(args.netlist_path).resolve()
    if not netlist_path.exists():
        result = validate_netlist_text("", args.project_kind, source=str(netlist_path))
        result["violations"].append(
            {"line": 0, "kind": "missing_file", "message": f"netlist not found: {netlist_path}"}
        )
        result["ok"] = False
        print(json.dumps(result, ensure_ascii=False))
        return 1
    result = validate_netlist_text(
        netlist_path.read_text(encoding="utf-8", errors="ignore"),
        args.project_kind,
        source=str(netlist_path),
    )
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
