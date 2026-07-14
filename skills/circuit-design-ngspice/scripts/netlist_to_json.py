#!/usr/bin/env python3
"""Convert SPICE-like netlists to JSON artifacts.

Supported formats:
- netlistsvg: analog-skin-friendly netlistsvg JSON.
- spice-components-v1: parsed component list for debugging/auditing.
"""

from __future__ import annotations

import argparse
import json
import re
import math
from collections import defaultdict
from pathlib import Path


TYPE_BY_PREFIX = {
    "R": "resistor",
    "C": "capacitor",
    "L": "inductor",
    "V": "voltage_source",
    "I": "current_source",
    "D": "diode",
    "Q": "bjt",
    "M": "mosfet",
    "X": "subckt",
    "E": "vcvs",
    "F": "cccs",
    "G": "vccs",
    "H": "ccvs",
    "B": "behavioral",
    "A": "xspice",
    "U": "ic",
}

COMMENT_PREFIXES = ("*", ";", "//", "$")
PARAM_REQUIRED_TYPES = {
    "resistor",
    "capacitor",
    "inductor",
    "voltage_source",
    "current_source",
    "diode",
    "bjt",
    "mosfet",
}
PARAM_ASSIGN_RE = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)\s*=")
PARAM_REF_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")
SCALAR_TOKEN_RE = re.compile(r"^\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*([A-Za-z\u00b5\u03a9]*)\s*$")
EXPR_IDENT_RE = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)\b")
EXPR_SAFE_RE = re.compile(r"^[0-9eE+\-*/().\s]+$")
BEHAVIORAL_V_RE = re.compile(r"\bv\s*\(\s*([^)]+?)\s*\)", re.IGNORECASE)
MODULE_COMMENT_RE = re.compile(r"^\s*[;*$]\s*MODULE\s+(?:\d+\s*:\s*)?([A-Za-z0-9_+\- /]+)", re.IGNORECASE)
SINGLE_MODULE_COMMENT_RE = re.compile(r"^\s*[;*$]\s*Module\s*:\s*([A-Za-z0-9_+\- /]+)", re.IGNORECASE)
SECTION_COMMENT_RE = re.compile(r"^\s*[;*$]\s*([A-Z][A-Z0-9_ /+\-]+)\s*$")

DISPLAY_UNIT_BY_TYPE = {
    "resistor": "ohm",
    "capacitor": "F",
    "inductor": "H",
}
SOURCE_UNIT_BY_TYPE = {
    "voltage_source": "V",
    "current_source": "A",
}
ENG_PREFIXES = ("meg", "t", "g", "k", "m", "u", "n", "p", "f")
UNIT_SCALE = {
    "": 1.0,
    "f": 1e-15,
    "p": 1e-12,
    "n": 1e-9,
    "u": 1e-6,
    "m": 1e-3,
    "k": 1e3,
    "meg": 1e6,
    "g": 1e9,
    "t": 1e12,
}


def infer_type(name: str) -> str:
    lead = name[:1].upper()
    return TYPE_BY_PREFIX.get(lead, "unknown")


def strip_inline_comment(line: str) -> str:
    text = line.lstrip("\ufeff")
    stripped = text.lstrip()
    if not stripped:
        return ""
    if stripped.startswith(COMMENT_PREFIXES):
        return ""

    in_quote = False
    escaped = False
    out = []
    for ch in text:
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


def merge_continuation_lines(text: str) -> list[tuple[int, str]]:
    entries: list[tuple[int, str]] = []
    current = ""
    current_line = 0

    for line_no, raw in enumerate(text.splitlines(), start=1):
        raw = raw.lstrip("\ufeff")
        stripped = raw.strip()

        if not stripped:
            if current:
                entries.append((current_line, current))
                current = ""
                current_line = 0
            continue

        if stripped.startswith("+"):
            cont = stripped[1:].strip()
            if current:
                if cont:
                    current = f"{current} {cont}"
            else:
                current = cont
                current_line = line_no
            continue

        if current:
            entries.append((current_line, current))
        current = raw.rstrip()
        current_line = line_no

    if current:
        entries.append((current_line, current))
    return entries


def parse_param_assignments(merged_lines: list[tuple[int, str]]) -> dict[str, str]:
    params: dict[str, str] = {}
    for _, line in merged_lines:
        stripped = strip_inline_comment(line)
        if not stripped:
            continue
        if not stripped.lower().startswith(".param"):
            continue
        body = stripped[6:].strip()
        if not body:
            continue

        matches = list(PARAM_ASSIGN_RE.finditer(body))
        if not matches:
            continue

        for idx, match in enumerate(matches):
            name = match.group(1).strip()
            start = match.end()
            end = matches[idx + 1].start() if idx + 1 < len(matches) else len(body)
            value = body[start:end].strip()
            if not name or not value:
                continue
            params[name.upper()] = value
    return params


def _resolve_param_name(name: str, params: dict[str, str], stack: set[str], depth: int) -> str:
    key = name.upper()
    if key not in params:
        return "{" + name + "}"
    if key in stack or depth > 12:
        return params[key]

    stack.add(key)
    base = params[key]
    resolved = PARAM_REF_RE.sub(
        lambda m: _resolve_param_name(m.group(1), params, stack, depth + 1),
        base,
    )
    stack.remove(key)
    return resolved


def resolve_param_refs(value: str, params: dict[str, str]) -> str:
    if not value or not params:
        return value

    resolved = value
    for _ in range(8):
        updated = PARAM_REF_RE.sub(
            lambda m: _resolve_param_name(m.group(1), params, set(), 0),
            resolved,
        )
        if updated == resolved:
            break
        resolved = updated
    return resolved


def apply_value_resolution(comp: dict, params: dict[str, str]) -> None:
    raw = str(comp.get("value", ""))
    resolved = resolve_param_refs(raw, params)
    resolved = resolve_braced_expression(resolved, params)
    comp["value_raw"] = raw
    comp["value_resolved"] = resolved
    comp["value"] = resolved


def _split_suffix(token_suffix: str) -> tuple[str, str]:
    suffix = token_suffix.strip().replace("µ", "u").replace("Ω", "ohm").lower()
    if not suffix:
        return "", ""
    for prefix in ENG_PREFIXES:
        if suffix.startswith(prefix):
            return prefix, suffix[len(prefix) :]
    return "", suffix


def parse_numeric_scalar(token: str) -> float | None:
    match = SCALAR_TOKEN_RE.match(token.strip())
    if not match:
        return None
    magnitude = float(match.group(1))
    suffix = match.group(2) or ""
    prefix, _unit_tail = _split_suffix(suffix)
    if prefix not in UNIT_SCALE:
        return None
    return magnitude * UNIT_SCALE[prefix]


def _resolve_param_numeric(
    name: str,
    params: dict[str, str],
    stack: set[str],
) -> float | None:
    key = name.upper()
    if key not in params:
        return None
    if key in stack:
        return None
    stack.add(key)

    raw = str(params[key]).strip()
    resolved = resolve_param_refs(raw, params).strip()

    numeric = parse_numeric_scalar(resolved)
    if numeric is not None:
        stack.remove(key)
        return numeric

    expr_numeric = evaluate_expression_numeric(resolved, params, stack)
    stack.remove(key)
    return expr_numeric


def evaluate_expression_numeric(
    expr_token: str,
    params: dict[str, str],
    stack: set[str] | None = None,
) -> float | None:
    token = expr_token.strip()
    if token.startswith("{") and token.endswith("}"):
        token = token[1:-1].strip()
    if not token:
        return None

    if stack is None:
        stack = set()

    substituted = token
    for ident in set(EXPR_IDENT_RE.findall(token)):
        lower = ident.lower()
        if lower in {"e", "pi"}:
            continue
        value = _resolve_param_numeric(ident, params, stack)
        if value is None:
            return None
        substituted = re.sub(rf"\b{re.escape(ident)}\b", f"({value})", substituted)

    substituted = substituted.replace("pi", str(math.pi)).replace("PI", str(math.pi))
    if not EXPR_SAFE_RE.match(substituted):
        return None
    try:
        return float(eval(substituted, {"__builtins__": {}}, {}))
    except Exception:
        return None


def resolve_braced_expression(value: str, params: dict[str, str]) -> str:
    token = value.strip()
    if not (token.startswith("{") and token.endswith("}")):
        return value
    numeric = evaluate_expression_numeric(token, params)
    if numeric is None:
        return value
    return f"{numeric:.6g}"


def format_value_for_display(comp_type: str, value: str) -> str:
    unit = DISPLAY_UNIT_BY_TYPE.get(comp_type, "")
    if not unit:
        src_unit = SOURCE_UNIT_BY_TYPE.get(comp_type, "")
        if src_unit:
            return format_source_value_for_display(value, src_unit)
        return value

    text = (value or "").strip()
    if not text:
        return value

    parts = text.split()
    candidate = text
    if len(parts) == 2:
        compact = f"{parts[0]}{parts[1]}"
        if SCALAR_TOKEN_RE.match(compact):
            candidate = compact
    elif len(parts) > 2:
        return value

    match = SCALAR_TOKEN_RE.match(candidate)
    if not match:
        return value

    magnitude = match.group(1)
    suffix = match.group(2) or ""
    prefix, unit_tail = _split_suffix(suffix)
    if unit_tail:
        return f"{magnitude}{suffix}"
    if prefix:
        return f"{magnitude}{prefix}{unit}"
    return f"{magnitude}{unit}"


def format_source_value_for_display(value: str, unit: str) -> str:
    text = (value or "").strip()
    if not text:
        return value

    # Plain scalar source declaration, e.g. "5" -> "5V".
    if SCALAR_TOKEN_RE.match(text):
        return format_scalar_token_with_unit(text, unit)

    # Normalize DC/AC scalar tokens, e.g. "DC 5 AC 0.01" -> "DC 5V AC 0.01V".
    dc_ac_re = re.compile(r"(?i)\b(DC|AC)\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?[A-Za-z\u00b5\u03a9]*)")

    def _dc_ac_repl(match: re.Match) -> str:
        key = match.group(1).upper()
        token = match.group(2)
        formatted = format_scalar_token_with_unit(token, unit)
        return f"{key} {formatted}"

    text = dc_ac_re.sub(_dc_ac_repl, text)
    return text


def format_scalar_token_with_unit(token: str, unit: str) -> str:
    match = SCALAR_TOKEN_RE.match(token.strip())
    if not match:
        return token
    magnitude = match.group(1)
    suffix = match.group(2) or ""
    prefix, unit_tail = _split_suffix(suffix)
    if unit_tail:
        return f"{magnitude}{suffix}"
    if prefix:
        return f"{magnitude}{prefix}{unit}"
    return f"{magnitude}{unit}"


def is_control_directive(line: str, directive: str) -> bool:
    stripped = strip_inline_comment(line)
    return bool(stripped) and stripped.lower().startswith(directive)


def parse_component_line(line: str, line_no: int, warnings: list[str]) -> dict | None:
    stripped = strip_inline_comment(line)
    if not stripped:
        return None
    if stripped.startswith(".") or stripped.startswith("+"):
        return None

    tokens = stripped.split()
    if len(tokens) < 3:
        return None

    name = tokens[0]
    prefix = name[:1].upper()
    if not prefix.isalpha():
        warnings.append(f"line {line_no}: invalid instance prefix for token '{name}'")
        return None

    comp_type = infer_type(name)
    if comp_type == "unknown":
        warnings.append(
            f"line {line_no}: unsupported or ambiguous instance prefix '{prefix}' in '{name}'"
        )
        return None

    nodes: list[str] = []
    value_tokens: list[str] = []

    if comp_type in {"resistor", "capacitor", "inductor", "diode"}:
        if len(tokens) < 3:
            warnings.append(f"line {line_no}: {name} has too few tokens for 2-terminal element")
            return None
        nodes = tokens[1:3]
        value_tokens = tokens[3:]
    elif comp_type in {"voltage_source", "current_source"}:
        if len(tokens) < 3:
            warnings.append(f"line {line_no}: {name} has too few tokens for source")
            return None
        nodes = tokens[1:3]
        value_tokens = tokens[3:]
    elif comp_type == "bjt":
        if len(tokens) < 4:
            warnings.append(f"line {line_no}: {name} has too few tokens for BJT nodes")
            return None
        nodes = tokens[1:4]  # C B E
        value_tokens = tokens[4:]
    elif comp_type == "mosfet":
        if len(tokens) < 5:
            warnings.append(f"line {line_no}: {name} has too few tokens for MOSFET nodes")
            return None
        nodes = tokens[1:5]  # D G S B
        value_tokens = tokens[5:]
    elif comp_type in {"vcvs", "vccs"}:
        if len(tokens) < 5:
            warnings.append(f"line {line_no}: {name} has too few tokens for controlled source nodes")
            return None
        nodes = tokens[1:5]  # OUT+ OUT- CTRL+ CTRL-
        value_tokens = tokens[5:]
    elif comp_type in {"cccs", "ccvs"}:
        if len(tokens) < 3:
            warnings.append(f"line {line_no}: {name} has too few tokens for controlled source nodes")
            return None
        nodes = tokens[1:3]  # OUT+ OUT-
        value_tokens = tokens[3:]
    elif comp_type == "behavioral":
        if len(tokens) < 4:
            warnings.append(f"line {line_no}: {name} has too few tokens for behavioral source")
            return None
        nodes = tokens[1:3]
        value_tokens = tokens[3:]
    elif comp_type == "subckt":
        if len(tokens) < 3:
            warnings.append(f"line {line_no}: {name} has too few tokens for subckt call")
            return None
        nodes = tokens[1:-1]
        value_tokens = [tokens[-1]]
    else:
        nodes = tokens[1:-1] if len(tokens) > 3 else tokens[1:]
        value_tokens = tokens[-1:] if len(tokens) > 1 else []

    value = " ".join(value_tokens).strip()
    param_missing = comp_type in PARAM_REQUIRED_TYPES and not value
    if param_missing:
        warnings.append(
            f"line {line_no}: {name} has missing parameter/value field; emitting '<missing_param>'"
        )
        value = "<missing_param>"

    return {
        "name": name,
        "type": comp_type,
        "nodes": nodes,
        "value": value,
        "param_missing": param_missing,
        "raw": stripped,
        "line_no": line_no,
    }


def sanitize_module_name(value: str) -> str:
    return sanitize_id(value.strip().lower().replace("+", "plus")) or "global"


def module_from_comment(line: str) -> str | None:
    for pattern in (MODULE_COMMENT_RE, SINGLE_MODULE_COMMENT_RE):
        match = pattern.match(line)
        if match:
            return sanitize_module_name(match.group(1))

    section = SECTION_COMMENT_RE.match(line)
    if not section:
        return None
    label = section.group(1).strip().lower()
    if label.startswith(("global source", "analysis", "model")):
        return "global"
    return None


def infer_model_token(comp: dict) -> str | None:
    comp_type = str(comp.get("type", ""))
    value = str(comp.get("value", "")).strip()
    if not value:
        return None
    tokens = value.split()
    if not tokens:
        return None
    if comp_type in {"bjt", "mosfet", "diode"}:
        return tokens[0]
    return None


def extract_behavioral_control_nodes(text: str) -> list[str]:
    ordered: list[str] = []
    for match in BEHAVIORAL_V_RE.finditer(text or ""):
        group = match.group(1)
        for candidate in group.split(","):
            node = candidate.strip()
            if not node or node in ordered:
                continue
            ordered.append(node)
    return ordered


def schematic_nodes_for_component(comp: dict, symbol_hint: str | None, control_nodes: list[str]) -> list[str]:
    nodes = [str(node) for node in comp.get("nodes", [])]
    comp_type = str(comp.get("type", ""))
    if comp_type == "vcvs" and symbol_hint in {"opamp", "comparator"} and len(nodes) >= 2 and len(control_nodes) >= 2:
        return [nodes[0], control_nodes[0], control_nodes[1]]
    if comp_type == "vcvs" and symbol_hint in {"opamp", "comparator"} and len(nodes) >= 4:
        return [nodes[0], nodes[2], nodes[3]]
    if str(comp.get("type", "")) == "behavioral" and symbol_hint == "comparator":
        if len(nodes) >= 2 and control_nodes:
            plus_node = control_nodes[0]
            minus_node = control_nodes[1] if len(control_nodes) >= 2 else nodes[1]
            return [nodes[0], plus_node, minus_node]
    return nodes


def infer_component_role(comp: dict) -> str:
    name = str(comp.get("name", "")).lower()
    nodes = [str(node).lower() for node in comp.get("nodes", [])]
    comp_type = str(comp.get("type", ""))
    if comp_type in {"voltage_source", "current_source"}:
        return "source"
    if comp_type in {"bjt", "mosfet"}:
        return "gain_active"
    if name.startswith(("rload", "rl", "rprobe")):
        return "load"
    if name.startswith(("cin", "cout")):
        return "coupling"
    if name.startswith(("ce", "cdec", "cvdd", "cvcc")):
        return "decoupling"
    if name.startswith(("rb", "re", "rc", "rg", "rd", "rs")) and any(
        node.startswith(("vcc", "vdd", "vee", "vss")) or node == "0" for node in nodes
    ):
        return "bias"
    if comp_type in {"inductor", "capacitor"} and any(
        node in {"in", "out", "vin", "vout", "rf_in", "rf_out"} for node in nodes
    ):
        return "matching"
    if comp_type == "diode":
        return "protection"
    if comp_type in {"resistor", "capacitor", "inductor"}:
        return "passive_network"
    return "unspecified"


def infer_symbol_hint(comp: dict) -> str | None:
    comp_type = str(comp.get("type", ""))
    name = str(comp.get("name", "")).lower()
    raw = str(comp.get("raw", "")).lower()
    control_nodes = extract_behavioral_control_nodes(str(comp.get("raw", "")) or str(comp.get("value", "")))

    if comp_type == "vcvs":
        if any(token in name for token in ("comp", "cmp", "alarm")) or "comparator" in raw:
            return "comparator"
        if any(token in name for token in ("op", "amp")) or "opamp" in raw:
            return "opamp"
        return "opamp"
    if comp_type == "behavioral":
        if len(control_nodes) >= 2 and (
            any(token in name for token in ("comp", "cmp", "alarm"))
            or "tanh" in raw
            or "threshold" in raw
            or "comparator" in raw
        ):
            return "comparator"

    return None


def infer_mount_policy(comp: dict) -> str:
    comp_type = str(comp.get("type", ""))
    name = str(comp.get("name", "")).lower()
    nodes = [str(node).lower() for node in comp.get("nodes", [])]
    if comp_type in {"voltage_source", "current_source"}:
        return "testbench_exclude"
    if name.startswith(("rprobe", "vprobe", "iprobe", "rsrc", "rsource", "rload_")):
        return "optional_testbench"
    if name.startswith(("cdec", "cvdd", "cvcc", "cdd", "cbyp")) and any(
        node.startswith(("vcc", "vdd")) for node in nodes
    ) and any(node in {"0", "gnd", "agnd", "dgnd", "pgnd"} or node.endswith("gnd") for node in nodes):
        return "optional_testbench"
    return "populate"


SCHEMATIC_HIDDEN_POLICIES = {"testbench_exclude", "optional_testbench"}


def should_include_component_in_view(comp: dict, view: str) -> bool:
    if view != "schematic":
        return True
    mount_policy = str(comp.get("mount_policy") or infer_mount_policy(comp))
    return mount_policy not in SCHEMATIC_HIDDEN_POLICIES


def components_for_view(components: list[dict], view: str) -> list[dict]:
    records = [enrich_component_record(c) for c in components]
    return [record for record in records if should_include_component_in_view(record, view)]


def extract_numeric_and_unit(display_value: str) -> tuple[str, str]:
    text = str(display_value or "").strip()
    if not text:
        return "", ""
    match = SCALAR_TOKEN_RE.match(text)
    if not match:
        return text, ""
    magnitude = match.group(1)
    suffix = match.group(2) or ""
    return magnitude, suffix


def enrich_component_record(comp: dict) -> dict:
    record = dict(comp)
    display_value = format_value_for_display(str(comp.get("type", "")), str(comp.get("value", "")))
    numeric_value, unit = extract_numeric_and_unit(display_value)
    model = infer_model_token(comp)
    symbol_hint = infer_symbol_hint(comp)
    control_nodes = extract_behavioral_control_nodes(str(comp.get("raw", "")) or str(comp.get("value", "")))
    schematic_nodes = schematic_nodes_for_component(comp, symbol_hint, control_nodes)
    record["display_value"] = display_value
    record["sim_value"] = str(comp.get("value", ""))
    record["numeric_value"] = numeric_value
    record["value_unit"] = unit
    record["model"] = model
    record["symbol_hint"] = symbol_hint
    record["control_nodes"] = control_nodes
    record["schematic_nodes"] = schematic_nodes
    record["component_role"] = infer_component_role(comp)
    record["mount_policy"] = infer_mount_policy(comp)
    record["physical_part"] = None
    return record


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Convert netlist to JSON")
    parser.add_argument("--netlist-path", required=True, help="Input netlist path")
    parser.add_argument("--json-path", required=True, help="Output JSON path")
    parser.add_argument(
        "--input-node",
        default="",
        help="Optional explicit input node name for netlistsvg terminal rendering",
    )
    parser.add_argument(
        "--output-node",
        default="",
        help="Optional explicit output node name for netlistsvg terminal rendering",
    )
    parser.add_argument(
        "--module-manifest-path",
        default="",
        help="Optional design-stage module manifest used to preserve schematic blocks and module order",
    )
    parser.add_argument(
        "--format",
        default="netlistsvg",
        choices=["netlistsvg", "spice-components-v1"],
        help="Output JSON format",
    )
    parser.add_argument(
        "--show-all-netnames",
        action="store_true",
        help="Show labels for all nets. By default, internal auto-generated nets are hidden.",
    )
    parser.add_argument(
        "--view",
        default="schematic",
        choices=["full", "schematic"],
        help="Payload view. Defaults to schematic; use full to retain testbench-only elements.",
    )
    return parser


def sanitize_id(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]+", "_", value).strip("_") or "unnamed"


def rail_symbol_for_node(node: str) -> str | None:
    value = node.strip().lower()
    if value in {"0", "gnd", "agnd", "dgnd", "pgnd"} or value.endswith("gnd"):
        return "gnd"
    if value.startswith("vcc") or value.startswith("vdd") or value.endswith("_vcc") or value.endswith("_vdd"):
        return "vcc"
    if value.startswith("vee") or value.startswith("vss") or value.endswith("_vee") or value.endswith("_vss"):
        return "vee"
    return None


def bjt_symbol(value: str) -> str:
    return "q_pnp" if "pnp" in value.lower() else "q_npn"


def mos_symbol(value: str) -> str:
    lower = value.lower()
    if "pmos" in lower or lower.startswith("p"):
        return "m_pmos"
    return "m_nmos"


def generic_ports(comp: dict) -> tuple[list[str], dict[str, str]]:
    comp_type = comp["type"]
    node_count = len(comp["nodes"])
    if comp_type == "mosfet":
        pin_names = ["D", "G", "S", "B"][:node_count]
        directions = {"D": "input", "G": "input", "S": "output", "B": "input"}
        return pin_names, {pin: directions.get(pin, "input") for pin in pin_names}
    if comp_type in {"vcvs", "vccs"}:
        pin_names = ["OUTP", "OUTN", "CTRLP", "CTRLN"][:node_count]
        directions = {"OUTP": "output", "OUTN": "output", "CTRLP": "input", "CTRLN": "input"}
        return pin_names, {pin: directions.get(pin, "input") for pin in pin_names}
    if comp_type in {"cccs", "ccvs"}:
        pin_names = ["OUTP", "OUTN"][:node_count]
        directions = {"OUTP": "output", "OUTN": "output"}
        return pin_names, {pin: directions.get(pin, "input") for pin in pin_names}

    in_count = max(1, node_count - 1) if node_count > 1 else 1
    pin_names = [f"in{i}" for i in range(in_count)]
    if node_count > in_count:
        pin_names.extend(f"out{i}" for i in range(node_count - in_count))
    directions = {name: ("input" if name.startswith("in") else "output") for name in pin_names}
    return pin_names[:node_count], directions


def choose_two_terminal_orientation(nodes: list[str]) -> str:
    if len(nodes) != 2:
        return "v"
    a = str(nodes[0])
    b = str(nodes[1])
    a_rail = rail_symbol_for_node(a) is not None
    b_rail = rail_symbol_for_node(b) is not None
    if a_rail ^ b_rail:
        return "v"
    return "h"


def node_flow_rank(node: str) -> int:
    lower = str(node).strip().lower()
    if lower in {"in", "input", "vin", "src", "source", "rf_in"}:
        return 0
    if lower.startswith(("in", "vin", "rf_in")):
        return 0
    exact = {
        "match": 10,
        "vp": 20,
        "vn": 20,
        "vref": 20,
        "ref": 20,
        "vth": 20,
        "vgate": 25,
        "vbias": 25,
        "gate": 30,
        "base": 30,
        "source": 30,
        "op_raw": 40,
        "drain": 45,
        "op_out": 55,
        "vout_int": 55,
        "rf_amp": 50,
        "det_in": 55,
        "env": 60,
        "filt": 65,
        "lpf": 65,
        "adc": 70,
        "adc_in": 70,
        "fb": 80,
        "out": 100,
        "output": 100,
        "vout": 100,
        "rf_out": 100,
        "alarm_n": 110,
    }
    if lower in exact:
        return exact[lower]
    if "out" in lower:
        return 100
    return 50


def oriented_two_terminal_nodes(comp: dict, alias: str, nodes: list[str]) -> list[str]:
    if len(nodes) != 2:
        return nodes
    if alias.endswith("_h") and node_flow_rank(nodes[0]) > node_flow_rank(nodes[1]):
        return [nodes[1], nodes[0]]
    if alias.endswith("_v"):
        first_rail = rail_symbol_for_node(str(nodes[0]))
        second_rail = rail_symbol_for_node(str(nodes[1]))
        if first_rail in {"gnd", "vee"} and second_rail not in {"gnd", "vee"}:
            return [nodes[1], nodes[0]]
        if second_rail in {"vcc"} and first_rail != "vcc":
            return [nodes[1], nodes[0]]
    return nodes


def should_hide_netname(node: str, important_nodes: set[str]) -> bool:
    lower = node.strip().lower()
    if not lower:
        return False
    if node in important_nodes:
        return False
    if rail_symbol_for_node(node) is not None:
        return False
    if lower in {"in", "out", "vin", "vout", "rf_in", "rf_out", "input", "output"}:
        return False
    if lower.startswith(("in", "out", "vin", "vout", "rf_in", "rf_out")):
        return False

    if lower.startswith(("net_", "node_", "int_", "x_")):
        return True
    if lower.startswith("n_"):
        return True
    if re.fullmatch(r"n\d+", lower):
        return True
    if re.fullmatch(r"[a-z]\d+", lower):
        return True
    if lower.startswith("n") and ("_" in lower or any(ch.isdigit() for ch in lower[1:])):
        return True
    return False


def component_node_set(comp: dict) -> set[str]:
    return {str(node).lower() for node in comp.get("schematic_nodes") or comp.get("nodes") or []}


def infer_node_role(node: str, input_node: str | None, output_node: str | None) -> str:
    lower = node.strip().lower()
    if input_node and lower == input_node.lower():
        return "input"
    if output_node and lower == output_node.lower():
        return "output"
    if rail_symbol_for_node(node) == "gnd":
        return "ground"
    if rail_symbol_for_node(node) in {"vcc", "vee"}:
        return "power"
    if lower in {"vp", "inp", "vinp"}:
        return "opamp_non_inverting_input"
    if lower in {"vn", "inn", "vinn", "fb"}:
        return "feedback"
    if lower.startswith(("op_raw", "op_", "amp")):
        return "gain_output"
    if lower.startswith(("filt", "flt", "lp", "lpf", "adc")):
        return "filter"
    if lower.startswith(("vth", "th", "ref", "vref")):
        return "reference"
    if lower.startswith(("gate", "vgate", "vbias", "b", "base")):
        return "bias_or_control"
    if lower.startswith(("drain", "collector", "c", "rf_amp")):
        return "gain_output"
    if lower.startswith(("source", "emitter", "e", "s")):
        return "local_ground_branch"
    if lower.startswith(("det", "env")):
        return "detector"
    if lower.endswith("_n") or lower.startswith(("alarm", "cmp", "dout", "digital")):
        return "logic_output"
    return "signal"


def infer_component_stage(comp: dict, input_node: str | None, output_node: str | None) -> str:
    name = str(comp.get("name", "")).lower()
    ctype = str(comp.get("type", "")).lower()
    hint = str(comp.get("symbol_hint") or "").lower()
    nodes = component_node_set(comp)
    has_ground = any(rail_symbol_for_node(node) == "gnd" for node in nodes)
    has_power = any(rail_symbol_for_node(node) in {"vcc", "vee"} for node in nodes)

    if hint == "comparator":
        return "comparator"
    if hint == "opamp":
        return "opamp"
    if ctype in {"bjt", "mosfet"}:
        if name.startswith(("mpass", "m_pass", "qpass", "q_pass")) or {"gate", "fb", "vref"} & nodes:
            return "regulator_pass_or_error"
        return "active_gain"
    if name.startswith(("cin", "lin", "lmatch", "cmatch", "rsource", "rsrc")):
        return "input_matching"
    if name.startswith(("cout", "cload", "rload")) or (output_node and output_node.lower() in nodes and has_ground):
        return "output_load"
    if ctype == "diode" or name.startswith(("ddet", "drect")):
        return "detector"
    if name.startswith(("rlp", "clp", "radc", "cadc")):
        return "filter"
    if name.startswith(("rth", "rref")) or "vth" in nodes or "ref" in nodes or "vref" in nodes:
        return "reference"
    if name.startswith(("rfb", "r1f", "r2f")) or "fb" in nodes or "vn" in nodes:
        return "feedback"
    if has_power or has_ground:
        return "bias"
    if input_node and input_node.lower() in nodes:
        return "input"
    if output_node and output_node.lower() in nodes:
        return "output"
    return "signal_path"


def infer_schematic_profile(
    components: list[dict],
    input_node: str | None,
    output_node: str | None,
) -> str:
    types = {str(comp.get("type") or "").lower() for comp in components}
    hints = {str(comp.get("symbol_hint") or "").lower() for comp in components}
    names = {str(comp.get("name") or "").lower() for comp in components}
    nodes = {
        node
        for comp in components
        for node in component_node_set(comp)
    }

    if "opamp" in hints and "comparator" in hints and ({"filt", "vth", "lpf"} & nodes or (output_node or "").lower().endswith("_n")):
        return "signal_chain_comparator"
    has_rf_frontend = "inductor" in types and ({"mosfet", "bjt"} & types)
    has_detector = "diode" in types and any(node.startswith(("det", "env", "lpf", "adc")) for node in nodes)
    has_digitizer = "comparator" in hints or any(node.endswith("_n") for node in nodes)
    if has_rf_frontend and has_detector and has_digitizer:
        return "rf_mixed_signal"
    if "mosfet" in types and sum(1 for name in names if name.startswith("m")) >= 4 and {"n1", "n2", "n3"} <= nodes:
        return "ring_oscillator"
    if "inductor" in types and "diode" in types and output_node:
        return "buck_converter"
    cascode_markers = {"nd", "no", "ns"}
    mosfet_names = [name for name in names if name.startswith("m")]
    if "mosfet" in types and len(mosfet_names) >= 2 and len(cascode_markers & nodes) >= 2:
        return "cascode_amplifier"
    if any(name.startswith(("mpass", "m_pass", "qpass", "q_pass")) for name in names) and {"fb", "gate"} & nodes:
        return "ldo_regulator"
    if "opamp" in hints and ({"vn", "fb"} & nodes or any(name.startswith(("r1f", "r2f", "rfb")) for name in names)):
        return "opamp_feedback"
    if ({"bjt", "mosfet"} & types) and input_node and output_node:
        if "inductor" in types or any(name.startswith(("rb", "rc", "re", "cin", "cout")) for name in names):
            return "lna_common_emitter"
        return "single_stage_amplifier"
    if "opamp" in hints:
        return "opamp"
    return "generic"


def build_schematic_intent(
    components: list[dict],
    *,
    input_node: str | None,
    output_node: str | None,
) -> dict:
    profile = infer_schematic_profile(components, input_node, output_node)
    node_roles: dict[str, str] = {}
    for comp in components:
        for node in comp.get("schematic_nodes") or comp.get("nodes") or []:
            node_s = str(node)
            node_roles.setdefault(node_s, infer_node_role(node_s, input_node, output_node))

    component_stages = [
        {
            "name": comp.get("name"),
            "type": comp.get("type"),
            "stage": infer_component_stage(comp, input_node, output_node),
            "role": comp.get("component_role"),
            "symbol_hint": comp.get("symbol_hint"),
        }
        for comp in components
    ]
    return {
        "profile": profile,
        "primary_renderer": "netlistsvg",
        "layout_quality": "publication",
        "direction": "left_to_right",
        "node_roles": node_roles,
        "component_stages": component_stages,
        "constraints": {
            "input_side": "left",
            "output_side": "right",
            "power_side": "top",
            "ground_side": "bottom",
            "main_signal_flow": "left_to_right",
            "feedback_preferred_side": "top",
            "reference_and_bias_preferred_side": "vertical_branch",
            "avoid_wire_crossings": True,
            "avoid_component_overlap": True,
            "prefer_orthogonal_wires": True,
        },
    }


def build_schematic_blocks(components: list[dict]) -> list[dict]:
    module_order: dict[str, int] = {}
    grouped: dict[str, list[dict]] = defaultdict(list)
    for comp in components:
        module_name = str(comp.get("module_name") or "global")
        if module_name == "global":
            continue
        grouped[module_name].append(comp)
        order = int(comp.get("module_order") or 999)
        module_order[module_name] = min(order, module_order.get(module_name, order))

    blocks: list[dict] = []
    for module_name, module_components in grouped.items():
        nodes = sorted(
            {
                str(node)
                for comp in module_components
                for node in comp.get("schematic_nodes") or comp.get("nodes") or []
            }
        )
        blocks.append(
            {
                "name": module_name,
                "label": module_name.replace("_", " ").upper(),
                "order": module_order.get(module_name, 999),
                "component_names": [str(comp.get("name")) for comp in module_components],
                "nodes": nodes,
            }
        )
    return sorted(blocks, key=lambda item: (int(item["order"]), str(item["name"])))


def manifest_string_list(value) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def manifest_modules(manifest: dict | None) -> list[dict]:
    if not isinstance(manifest, dict):
        return []
    modules = manifest.get("modules")
    if not isinstance(modules, list):
        return []
    return [module for module in modules if isinstance(module, dict)]


def manifest_ports(manifest: dict | None) -> list[dict]:
    if not isinstance(manifest, dict):
        return []
    ports: list[dict] = []
    root_ports = manifest.get("ports")
    if isinstance(root_ports, list):
        ports.extend(port for port in root_ports if isinstance(port, dict))
    for module in manifest_modules(manifest):
        module_ports = module.get("ports")
        if isinstance(module_ports, list):
            ports.extend(port for port in module_ports if isinstance(port, dict))
    return ports


def manifest_terminal_ports(manifest: dict | None, node_to_bit: dict[str, int]) -> list[dict[str, str | int]]:
    terminals: list[dict[str, str | int]] = []
    seen_nets: set[str] = set()
    for port in manifest_ports(manifest):
        net = str(port.get("net") or port.get("node") or "").strip()
        if not net or net not in node_to_bit or net in seen_nets:
            continue
        signal_type = str(port.get("signal_type") or port.get("type") or "").strip().lower()
        if signal_type in {"power", "ground"} or rail_symbol_for_node(net) is not None:
            continue
        side_text = str(port.get("side") or port.get("schematic_side") or "").strip().lower()
        direction_text = str(port.get("direction") or "").strip().lower()
        if side_text in {"right", "east", "output"}:
            direction = "output"
        elif side_text in {"left", "west", "input"}:
            direction = "input"
        else:
            direction = "output" if direction_text.startswith("out") else "input"
        label = str(port.get("name") or port.get("id") or net).strip() or net
        terminals.append({"label": label, "net": net, "bit": node_to_bit[net], "direction": direction})
        seen_nets.add(net)
    return terminals


def manifest_module_order(module: dict, fallback: int) -> int:
    try:
        return int(module.get("order") or fallback)
    except (TypeError, ValueError):
        return fallback


def load_module_manifest(path_value: str, warnings: list[str]) -> dict | None:
    if not path_value:
        return None
    manifest_path = Path(path_value).resolve()
    if not manifest_path.exists():
        warnings.append(f"module manifest not found: {manifest_path}")
        return None
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    except Exception as exc:  # pragma: no cover - surfaced through CLI warnings
        warnings.append(f"failed to read module manifest {manifest_path}: {exc}")
        return None
    if not isinstance(payload, dict):
        warnings.append(f"module manifest is not a JSON object: {manifest_path}")
        return None
    payload["_source_path"] = str(manifest_path)
    return payload


def apply_module_manifest(components: list[dict], manifest: dict | None, warnings: list[str]) -> None:
    modules = manifest_modules(manifest)
    if not modules:
        return

    component_by_name = {str(comp.get("name", "")).lower(): comp for comp in components}
    module_meta_by_name: dict[str, dict] = {}
    for index, module in enumerate(modules, start=1):
        module_name = sanitize_module_name(str(module.get("name") or module.get("label") or f"module_{index}"))
        module_order = manifest_module_order(module, index)
        module_label = str(module.get("label") or module_name.replace("_", " ").upper())
        module_meta_by_name[module_name] = {
            "module_name": module_name,
            "module_order": module_order,
            "module_label": module_label,
            "module_file": module.get("file"),
            "module_purpose": module.get("purpose"),
        }

        component_names = manifest_string_list(module.get("component_names")) or manifest_string_list(module.get("components"))
        for comp_name in component_names:
            comp = component_by_name.get(comp_name.lower())
            if not comp:
                warnings.append(f"module manifest component not found in netlist: {module_name}.{comp_name}")
                continue
            comp.update(module_meta_by_name[module_name])

    for comp in components:
        module_name = sanitize_module_name(str(comp.get("module_name") or "global"))
        if module_name in module_meta_by_name:
            for key, value in module_meta_by_name[module_name].items():
                comp.setdefault(key, value)
            comp["module_order"] = module_meta_by_name[module_name]["module_order"]
            comp["module_label"] = module_meta_by_name[module_name]["module_label"]


def build_manifest_schematic_blocks(components: list[dict], manifest: dict | None) -> list[dict]:
    modules = manifest_modules(manifest)
    if not modules:
        return build_schematic_blocks(components)

    component_by_name = {str(comp.get("name", "")).lower(): comp for comp in components}
    components_by_module: dict[str, list[dict]] = defaultdict(list)
    for comp in components:
        components_by_module[sanitize_module_name(str(comp.get("module_name") or "global"))].append(comp)

    blocks: list[dict] = []
    claimed: set[str] = set()
    for index, module in enumerate(modules, start=1):
        module_name = sanitize_module_name(str(module.get("name") or module.get("label") or f"module_{index}"))
        component_names = manifest_string_list(module.get("component_names")) or manifest_string_list(module.get("components"))
        module_components = [
            component_by_name[name.lower()]
            for name in component_names
            if name.lower() in component_by_name
        ]
        if not module_components:
            module_components = components_by_module.get(module_name, [])

        for comp in module_components:
            claimed.add(str(comp.get("name", "")).lower())

        nodes = set(
            manifest_string_list(module.get("input_nets"))
            + manifest_string_list(module.get("output_nets"))
            + manifest_string_list(module.get("shared_nets"))
        )
        for comp in module_components:
            for node in comp.get("schematic_nodes") or comp.get("nodes") or []:
                nodes.add(str(node))

        blocks.append(
            {
                "name": module_name,
                "label": str(module.get("label") or module_name.replace("_", " ").upper()),
                "order": manifest_module_order(module, index),
                "purpose": str(module.get("purpose") or ""),
                "file": str(module.get("file") or ""),
                "input_nets": manifest_string_list(module.get("input_nets")),
                "output_nets": manifest_string_list(module.get("output_nets")),
                "shared_nets": manifest_string_list(module.get("shared_nets")),
                "local_net_prefix": str(module.get("local_net_prefix") or ""),
                "component_names": [str(comp.get("name")) for comp in module_components],
                "nodes": sorted(nodes),
            }
        )

    extras = [comp for comp in components if str(comp.get("name", "")).lower() not in claimed]
    if extras:
        extra_blocks = build_schematic_blocks(extras)
        known_names = {str(block["name"]) for block in blocks}
        for block in extra_blocks:
            if str(block["name"]) not in known_names:
                blocks.append(block)

    return sorted(blocks, key=lambda item: (int(item.get("order") or 999), str(item.get("name") or "")))


def module_manifest_summary(manifest: dict | None) -> dict | None:
    modules = manifest_modules(manifest)
    if not modules:
        return None
    return {
        "version": manifest.get("version") if isinstance(manifest, dict) else None,
        "source_path": manifest.get("_source_path") if isinstance(manifest, dict) else None,
        "strategy": manifest.get("strategy") if isinstance(manifest, dict) else None,
        "interface_chain": manifest_string_list(manifest.get("interface_chain")) if isinstance(manifest, dict) else [],
        "shared_nets": manifest_string_list(manifest.get("shared_nets")) if isinstance(manifest, dict) else [],
        "modules": [
            {
                "name": sanitize_module_name(str(module.get("name") or module.get("label") or f"module_{index}")),
                "label": str(module.get("label") or ""),
                "order": manifest_module_order(module, index),
                "file": str(module.get("file") or ""),
                "input_nets": manifest_string_list(module.get("input_nets")),
                "output_nets": manifest_string_list(module.get("output_nets")),
                "shared_nets": manifest_string_list(module.get("shared_nets")),
                "component_names": manifest_string_list(module.get("component_names")),
            }
            for index, module in enumerate(modules, start=1)
        ],
    }


def component_to_cell(comp: dict, bit_for: callable) -> tuple[str, dict]:
    comp_type = comp["type"]
    nodes = comp.get("schematic_nodes") or comp["nodes"]
    value = comp["value"]
    display_value = comp.get("display_value") or format_value_for_display(comp_type, value)
    ref = comp["name"]
    symbol_hint = str(comp.get("symbol_hint") or "").strip().lower()

    alias = "generic"
    pin_names: list[str]
    port_directions: dict[str, str]
    if comp_type == "resistor":
        alias = f"r_{choose_two_terminal_orientation(nodes)}"
        node_lowers = {str(node).lower() for node in nodes}
        if ref.lower().startswith(("rdiv", "rth")):
            alias = "r_v"
        if ref.lower().startswith(("rfb1", "rtop")) and {"out", "fb"} <= node_lowers:
            alias = "r_v"
        pin_names = ["A", "B"]
        port_directions = {"A": "input", "B": "output"}
    elif comp_type == "capacitor":
        alias = f"c_{choose_two_terminal_orientation(nodes)}"
        pin_names = ["A", "B"]
        port_directions = {"A": "input", "B": "output"}
    elif comp_type == "inductor":
        alias = f"l_{choose_two_terminal_orientation(nodes)}"
        pin_names = ["A", "B"]
        port_directions = {"A": "input", "B": "output"}
    elif comp_type == "voltage_source":
        alias = "v"
        pin_names = ["+", "-"]
        port_directions = {"+": "output", "-": "input"}
    elif comp_type == "current_source":
        alias = "i"
        pin_names = ["+", "-"]
        port_directions = {"+": "output", "-": "input"}
    elif comp_type == "diode":
        alias = f"d_{choose_two_terminal_orientation(nodes)}"
        pin_names = ["+", "-"]
        port_directions = {"+": "input", "-": "output"}
    elif comp_type == "bjt":
        alias = bjt_symbol(value)
        pin_names = ["C", "B", "E"]
        port_directions = {"C": "input", "B": "input", "E": "output"}
    elif comp_type == "mosfet":
        alias = mos_symbol(value)
        pin_names = ["D", "G", "S", "B"]
        port_directions = {"D": "input", "G": "input", "S": "output", "B": "input"}
    elif symbol_hint in {"opamp", "comparator"} and comp_type in {"vcvs", "behavioral"}:
        if symbol_hint == "comparator":
            output_node = str(nodes[0]).lower() if nodes else ""
            alias = "comparator_n" if output_node.endswith("_n") or output_node.startswith("alarm") else "comparator"
        else:
            alias = "opamp"
        pin_names = []
        port_directions = {"+": "input", "-": "input", "OUT": "output"}
    else:
        pin_names, port_directions = generic_ports(comp)

    if symbol_hint in {"opamp", "comparator"} and comp_type in {"vcvs", "behavioral"}:
        connections = {}
        if len(nodes) >= 1:
            connections["OUT"] = [bit_for(nodes[0])]
        if len(nodes) >= 2:
            connections["+"] = [bit_for(nodes[1])]
        if len(nodes) >= 3:
            connections["-"] = [bit_for(nodes[2])]
    else:
        pin_names = pin_names[: len(nodes)]
        connection_nodes = (
            oriented_two_terminal_nodes(comp, alias, list(nodes))
            if comp_type in {"resistor", "capacitor", "inductor"}
            else list(nodes)
        )
        connections = {pin: [bit_for(node)] for pin, node in zip(pin_names, connection_nodes)}

    cell = {
        "type": alias,
        "port_directions": {
            pin: port_directions.get(pin, "input")
            for pin in (
                connections.keys()
                if symbol_hint in {"opamp", "comparator"} and comp_type in {"vcvs", "behavioral"}
                else pin_names
            )
        },
        "connections": connections,
        "attributes": {
            "ref": ref,
            "value": display_value,
            "value_spice": value,
            "value_raw": comp.get("value_raw", value),
            "raw": comp["raw"],
            "spice_type": comp_type,
            "line_no": comp.get("line_no"),
            "param_missing": bool(comp.get("param_missing", False)),
            "component_role": comp.get("component_role") or infer_component_role(comp),
            "mount_policy": comp.get("mount_policy") or infer_mount_policy(comp),
            "model": comp.get("model"),
            "symbol_hint": comp.get("symbol_hint"),
        },
    }
    return ref, cell


def add_rail_symbols(cells: dict, node_to_bit: dict[str, int]) -> None:
    existing = set(cells)
    for node, bit in sorted(node_to_bit.items(), key=lambda item: item[1]):
        rail = rail_symbol_for_node(node)
        if rail is None:
            continue
        base = f"{rail}_{sanitize_id(node)}"
        name = base
        suffix = 2
        while name in existing:
            name = f"{base}_{suffix}"
            suffix += 1
        existing.add(name)
        cells[name] = {
            "type": rail,
            "port_directions": {"A": "input" if rail in {"gnd", "vee"} else "output"},
            "connections": {"A": [bit]},
            "attributes": {"name": node},
        }


def add_terminal_symbol(cells: dict, label: str, bit: int, *, direction: str) -> None:
    existing = set(cells)
    name = sanitize_id(label) or label
    base = name
    suffix = 2
    while name in existing:
        name = f"{base}_{suffix}"
        suffix += 1

    if direction == "input":
        cell_type = "$_inputExt_"
        port_directions = {"Y": "output"}
        connections = {"Y": [bit]}
        layer_constraint = "FIRST"
    else:
        cell_type = "$_outputExt_"
        port_directions = {"A": "input"}
        connections = {"A": [bit]}
        layer_constraint = "LAST"

    cells[name] = {
        "type": cell_type,
        "port_directions": port_directions,
        "connections": connections,
        "attributes": {
            "ref": label,
            # Keep I/O terminals on the first/last layered columns so the
            # rendered schematic reads left-to-right more like a hand-drawn diagram.
            "org.eclipse.elk.layered.layerConstraint": layer_constraint,
        },
    }


def hidden_source_terminal_label(comp: dict, node: str) -> str:
    lower = node.strip().lower()
    source_name = str(comp.get("name") or "").strip().lower()
    explicit_labels = {
        "gate": "GATE",
        "vgate": "GATE",
        "vref": "VREF",
        "ref": "VREF",
        "vbias": "VBIAS",
        "bias": "BIAS",
        "tail": "ITAIL",
        "itail": "ITAIL",
    }
    if lower in explicit_labels:
        return explicit_labels[lower]

    cleaned = sanitize_id(node).upper()
    if str(comp.get("type") or "") == "current_source" and not cleaned.startswith("I"):
        return f"I{cleaned}"
    if source_name.startswith("v") and not cleaned.startswith("V"):
        return f"V{cleaned}"
    return cleaned


def hidden_source_terminal_nodes(
    components: list[dict],
    component_records: list[dict],
    node_to_bit: dict[str, int],
    *,
    inferred_input: str | None,
    inferred_output: str | None,
) -> list[tuple[str, str]]:
    """Expose hidden bench/control source nodes that still drive visible parts."""
    visible_node_by_lower = {node.lower(): node for node in node_to_bit}
    visible_ref_count: dict[str, int] = {}
    for record in component_records:
        for node in record.get("schematic_nodes") or record.get("nodes") or []:
            visible_ref_count[str(node).lower()] = visible_ref_count.get(str(node).lower(), 0) + 1

    io_nodes = {str(node).lower() for node in (inferred_input, inferred_output) if node}
    seen_nodes: set[str] = set()
    terminals: list[tuple[str, str]] = []

    for comp in [enrich_component_record(c) for c in components]:
        if comp.get("type") not in {"voltage_source", "current_source"}:
            continue
        if should_include_component_in_view(comp, "schematic"):
            continue

        for raw_node in comp.get("nodes", []):
            node = visible_node_by_lower.get(str(raw_node).lower())
            if node is None:
                continue
            lower = node.lower()
            if comp.get("type") == "current_source" and lower not in {"tail", "itail", "ibias", "bias"}:
                continue
            if lower in seen_nodes or lower in io_nodes:
                continue
            if rail_symbol_for_node(node) is not None:
                continue
            if visible_ref_count.get(lower, 0) < 1:
                continue
            seen_nodes.add(lower)
            terminals.append((hidden_source_terminal_label(comp, node), node))

    return terminals


def is_ground_node(node: str) -> bool:
    return rail_symbol_for_node(node) == "gnd"


def is_power_rail_node(node: str) -> bool:
    return rail_symbol_for_node(node) in {"vcc", "vee"}


def infer_io_nodes(
    components: list[dict],
    *,
    explicit_input: str,
    explicit_output: str,
    warnings: list[str],
) -> tuple[str | None, str | None]:
    nodes_in_order: list[str] = []
    seen_nodes: set[str] = set()

    def remember(node: str) -> None:
        if node not in seen_nodes:
            seen_nodes.add(node)
            nodes_in_order.append(node)

    for comp in components:
        for node in comp.get("nodes", []):
            remember(str(node))

    if not nodes_in_order:
        return None, None

    lower_to_original: dict[str, str] = {}
    for node in nodes_in_order:
        lower_to_original.setdefault(node.lower(), node)

    explicit_in = explicit_input.strip()
    explicit_out = explicit_output.strip()
    if explicit_in and explicit_in not in seen_nodes:
        warnings.append(f"explicit input node not found in netlist, ignored: {explicit_in}")
        explicit_in = ""
    if explicit_out and explicit_out not in seen_nodes:
        warnings.append(f"explicit output node not found in netlist, ignored: {explicit_out}")
        explicit_out = ""

    source_positive: list[str] = []
    for comp in components:
        ctype = str(comp.get("type", ""))
        if ctype not in {"voltage_source", "current_source"}:
            continue
        nodes = [str(n) for n in comp.get("nodes", [])]
        if not nodes:
            continue
        if not is_ground_node(nodes[0]) and not is_power_rail_node(nodes[0]):
            source_positive.append(nodes[0])

    preferred_in_names = ("in", "vin", "input", "rf_in")
    preferred_out_names = ("out", "vout", "output", "rf_out")

    def pick_named(preferred: tuple[str, ...], reject: set[str]) -> str | None:
        for name in preferred:
            match = lower_to_original.get(name)
            if match and match not in reject:
                return match
        return None

    in_node = explicit_in or pick_named(preferred_in_names, set())
    if in_node is None:
        for node in source_positive:
            if node not in {in_node}:
                in_node = node
                break

    named_or_explicit_output = explicit_out or pick_named(preferred_out_names, set())
    if in_node is None and not named_or_explicit_output:
        in_node = next(
            (n for n in nodes_in_order if not is_ground_node(n) and not is_power_rail_node(n)),
            None,
        )

    out_node = explicit_out or pick_named(preferred_out_names, {in_node} if in_node else set())
    if out_node is None:
        load_candidates: list[str] = []
        for comp in components:
            ctype = str(comp.get("type", ""))
            if ctype != "resistor":
                continue
            nodes = [str(n) for n in comp.get("nodes", [])]
            if len(nodes) < 2:
                continue
            a, b = nodes[0], nodes[1]
            other = None
            if is_ground_node(a) and not is_ground_node(b):
                other = b
            elif is_ground_node(b) and not is_ground_node(a):
                other = a
            if other and other != in_node:
                load_candidates.append(other)
        if load_candidates:
            out_node = load_candidates[-1]

    if out_node is None:
        for node in reversed(nodes_in_order):
            if is_ground_node(node):
                continue
            if in_node and node == in_node:
                continue
            out_node = node
            break

    if in_node and out_node and in_node == out_node:
        for node in reversed(nodes_in_order):
            if is_ground_node(node) or node == in_node:
                continue
            out_node = node
            break

    return in_node, out_node


def build_netlistsvg_payload(
    netlist_path: Path,
    components: list[dict],
    params: dict[str, str],
    warnings: list[str],
    *,
    explicit_input: str,
    explicit_output: str,
    show_all_netnames: bool = False,
    view: str = "full",
    module_manifest: dict | None = None,
) -> dict:
    component_records = components_for_view(components, view)
    node_to_bit: dict[str, int] = {}
    next_bit = 1

    def bit_for(node: str) -> int:
        nonlocal next_bit
        if node not in node_to_bit:
            node_to_bit[node] = next_bit
            next_bit += 1
        return node_to_bit[node]

    for comp in component_records:
        for node in comp.get("schematic_nodes") or comp["nodes"]:
            bit_for(node)

    cells: dict[str, dict] = {}
    for comp in component_records:
        name, cell = component_to_cell(comp, bit_for)
        if name in cells:
            name = f"{name}_{len(cells)+1}"
        cells[name] = cell

    inferred_input, inferred_output = infer_io_nodes(
        components,
        explicit_input=explicit_input,
        explicit_output=explicit_output,
        warnings=warnings,
    )
    add_rail_symbols(cells, node_to_bit)

    manifest_terminals = manifest_terminal_ports(module_manifest, node_to_bit)
    important_nodes = {
        n
        for n in (
            inferred_input,
            inferred_output,
            *[str(port["net"]) for port in manifest_terminals],
        )
        if n
    }
    netnames = {}
    for node, bit in sorted(node_to_bit.items(), key=lambda item: item[1]):
        hide_name = 0 if show_all_netnames else int(should_hide_netname(node, important_nodes))
        netnames[node] = {"hide_name": hide_name, "bits": [bit], "attributes": {}}

    visible_source_positive_nodes = {
        str(comp["nodes"][0])
        for comp in component_records
        if comp.get("type") in {"voltage_source", "current_source"} and comp.get("nodes")
    }
    if manifest_terminals:
        for port in manifest_terminals:
            add_terminal_symbol(
                cells,
                str(port["label"]),
                int(port["bit"]),
                direction=str(port["direction"]),
            )
    else:
        if inferred_input and inferred_input in node_to_bit:
            if inferred_input not in visible_source_positive_nodes:
                add_terminal_symbol(cells, "IN", node_to_bit[inferred_input], direction="input")
        if inferred_output and inferred_output in node_to_bit:
            add_terminal_symbol(cells, "OUT", node_to_bit[inferred_output], direction="output")
    hidden_terminal_nodes: list[tuple[str, str]] = []
    if view == "schematic":
        hidden_terminal_nodes = hidden_source_terminal_nodes(
            components,
            component_records,
            node_to_bit,
            inferred_input=inferred_input,
            inferred_output=inferred_output,
        )
        for label, node in hidden_terminal_nodes:
            add_terminal_symbol(cells, label, node_to_bit[node], direction="input")

    module_name = sanitize_id(netlist_path.stem) or "top"
    interfaces = {
        "input_node": inferred_input,
        "output_node": inferred_output,
        "power_nodes": [
            node
            for node in node_to_bit
            if rail_symbol_for_node(node) in {"vcc", "vee"}
        ],
        "ground_nodes": [
            node
            for node in node_to_bit
            if rail_symbol_for_node(node) == "gnd"
        ],
    }
    schematic_intent = build_schematic_intent(
        component_records,
        input_node=inferred_input,
        output_node=inferred_output,
    )
    schematic_blocks = build_manifest_schematic_blocks(component_records, module_manifest)
    return {
        "creator": "circuit-design-ngspice/netlist_to_json.py",
        "view": view,
        "source_netlist": str(netlist_path),
        "warnings": warnings,
        "params": params,
        "components": component_records,
        "interfaces": interfaces,
        "schematic_intent": schematic_intent,
        "schematic_blocks": schematic_blocks,
        "module_manifest": module_manifest_summary(module_manifest),
        "circuit_metadata": {
            "component_count": len(component_records),
            "active_device_count": len(
                [c for c in component_records if c.get("type") in {"bjt", "mosfet"}]
            ),
            "testbench_excluded_count": len(
                [c for c in component_records if c.get("mount_policy") == "testbench_exclude"]
            ),
            "hidden_source_terminal_count": len(hidden_terminal_nodes),
        },
        "io_inference": {
            "input_node": inferred_input,
            "output_node": inferred_output,
            "explicit_input_node": explicit_input.strip() or None,
            "explicit_output_node": explicit_output.strip() or None,
        },
        "param_issues": [
            {"name": c["name"], "line_no": c.get("line_no"), "raw": c.get("raw", "")}
            for c in components
            if c.get("param_missing")
        ],
        "modules": {
            module_name: {
                "ports": {},
                "cells": cells,
                "netnames": netnames,
            }
        },
    }


def main() -> int:
    args = build_parser().parse_args()
    netlist_path = Path(args.netlist_path).resolve()
    json_path = Path(args.json_path).resolve()

    result = {"ok": False, "json_path": str(json_path), "error": "", "warnings": []}
    if not netlist_path.exists():
        result["error"] = f"netlist not found: {netlist_path}"
        print(json.dumps(result, ensure_ascii=False))
        return 1

    warnings: list[str] = []
    module_manifest = load_module_manifest(args.module_manifest_path, warnings)
    components = []
    nodes = set()
    content = netlist_path.read_text(encoding="utf-8-sig", errors="ignore")
    merged_lines = merge_continuation_lines(content)
    params = parse_param_assignments(merged_lines)
    in_control_block = False
    current_module = "global"
    module_order_by_name: dict[str, int] = {"global": 0}
    next_module_order = 1

    for line_no, line in merged_lines:
        detected_module = module_from_comment(line)
        if detected_module:
            current_module = detected_module
            if current_module not in module_order_by_name:
                module_order_by_name[current_module] = next_module_order
                next_module_order += 1

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
        comp["module_name"] = current_module
        comp["module_order"] = module_order_by_name.get(current_module, 0)
        apply_value_resolution(comp, params)
        components.append(comp)
        for node in comp["nodes"]:
            nodes.add(node)

    apply_module_manifest(components, module_manifest, warnings)

    if args.format == "spice-components-v1":
        component_records = components_for_view(components, args.view)
        visible_nodes = sorted({str(node) for comp in component_records for node in comp.get("nodes", [])})
        inferred_input, inferred_output = infer_io_nodes(
            components,
            explicit_input=args.input_node,
            explicit_output=args.output_node,
            warnings=warnings,
        )
        payload = {
            "format": "spice-components-v1",
            "view": args.view,
            "source_netlist": str(netlist_path),
            "components": component_records,
            "nodes": visible_nodes,
            "params": params,
            "interfaces": {
                "input_node": inferred_input,
                "output_node": inferred_output,
                "power_nodes": [node for node in visible_nodes if rail_symbol_for_node(node) in {"vcc", "vee"}],
                "ground_nodes": [node for node in visible_nodes if rail_symbol_for_node(node) == "gnd"],
            },
            "io_inference": {
                "input_node": inferred_input,
                "output_node": inferred_output,
                "explicit_input_node": args.input_node.strip() or None,
                "explicit_output_node": args.output_node.strip() or None,
            },
            "schematic_blocks": build_manifest_schematic_blocks(component_records, module_manifest),
            "module_manifest": module_manifest_summary(module_manifest),
            "warnings": warnings,
        }
    else:
        payload = build_netlistsvg_payload(
            netlist_path,
            components,
            params,
            warnings,
            explicit_input=args.input_node,
            explicit_output=args.output_node,
            show_all_netnames=bool(args.show_all_netnames),
            view=args.view,
            module_manifest=module_manifest,
        )

    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    result["ok"] = True
    result["warnings"] = warnings
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
