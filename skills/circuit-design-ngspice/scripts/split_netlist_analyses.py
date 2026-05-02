#!/usr/bin/env python3
"""Split one SPICE netlist into AC and power-analysis netlists."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


MEAS_NAME_RE = re.compile(r"^\s*\.meas(?:ure)?\s+\w+\s+([A-Za-z_][A-Za-z0-9_]*)", re.IGNORECASE)
COMMENT_PREFIXES = ("*", ";", "//", "$")
VDB_RE = re.compile(r"\bvdb\s*\(\s*([^)]+?)\s*\)", re.IGNORECASE)
SPICE_SUFFIXES = {
    "t": 1e12,
    "g": 1e9,
    "meg": 1e6,
    "k": 1e3,
    "m": 1e-3,
    "u": 1e-6,
    "n": 1e-9,
    "p": 1e-12,
    "f": 1e-15,
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Split SPICE netlist into AC and power runs")
    parser.add_argument("--netlist-path", required=True, help="Input netlist path")
    parser.add_argument("--ac-netlist-path", required=True, help="Output AC netlist path")
    parser.add_argument("--power-netlist-path", required=True, help="Output power netlist path")
    parser.add_argument(
        "--power-analysis",
        default="tran",
        choices=["tran", "op", "dc"],
        help="Analysis used for power extraction",
    )
    parser.add_argument("--power-tran-step", default="1n", help="Transient step when power-analysis=tran")
    parser.add_argument("--power-tran-stop", default="2n", help="Transient stop time when power-analysis=tran")
    parser.add_argument(
        "--power-sample-time",
        default="2n",
        help="Sample time for power measurement when power-analysis=tran",
    )
    parser.add_argument("--supply-source", default="VDD", help="Supply source instance name")
    parser.add_argument(
        "--supply-voltage-expr",
        default="VDD_SUPPLY",
        help="Expression used to compute pdc_w from idd_a",
    )
    return parser


def directive_name(stripped: str) -> str:
    parts = stripped.split(maxsplit=1)
    return parts[0].lower() if parts else ""


def second_token(stripped: str) -> str:
    tokens = stripped.split()
    if len(tokens) < 2:
        return ""
    return tokens[1].lower()


def is_comment_or_blank(stripped: str) -> bool:
    if not stripped:
        return True
    return stripped.startswith(COMMENT_PREFIXES)


def is_independent_source(tokens: list[str]) -> bool:
    if len(tokens) < 4:
        return False
    return tokens[0][:1].upper() in {"V", "I"}


def has_ac_stimulus(stripped: str) -> bool:
    return re.search(r"\bac\b", stripped, re.IGNORECASE) is not None


def has_time_domain_stimulus(stripped: str) -> bool:
    return any(keyword in stripped.lower() for keyword in ("sin(", "pulse(", "pwl(", "exp(", "sffm("))


def collect_meas_names(lines: list[str]) -> set[str]:
    names: set[str] = set()
    for line in lines:
        match = MEAS_NAME_RE.match(line)
        if match:
            names.add(match.group(1))
    return names


def measurement_name(line: str) -> str:
    match = MEAS_NAME_RE.match(line)
    return match.group(1) if match else ""


def parse_spice_number(token: str) -> float | None:
    value = token.strip().strip("{}")
    match = re.match(r"^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)([A-Za-z]*)$", value, re.IGNORECASE)
    if not match:
        return None
    number = float(match.group(1))
    suffix = match.group(2).lower()
    if not suffix or suffix == "hz":
        return number
    if suffix.endswith("hz"):
        suffix = suffix[:-2]
        if not suffix:
            return number
    if suffix in SPICE_SUFFIXES:
        return number * SPICE_SUFFIXES[suffix]
    # Allow unit tails such as "Hz" after a recognized scale suffix.
    for key in sorted(SPICE_SUFFIXES, key=len, reverse=True):
        if suffix.startswith(key):
            return number * SPICE_SUFFIXES[key]
    return None


def format_spice_number(value: float) -> str:
    if value == 0:
        return "0"
    abs_value = abs(value)
    for suffix, scale in (("G", 1e9), ("Meg", 1e6), ("k", 1e3), ("m", 1e-3), ("u", 1e-6), ("n", 1e-9), ("p", 1e-12)):
        scaled = value / scale
        if 1 <= abs(scaled) < 1000:
            return f"{scaled:.6g}{suffix}"
    return f"{value:.6g}"


def normalize_vdb_expression(line: str, warnings: list[str]) -> str:
    def replace(match: re.Match[str]) -> str:
        inner = match.group(1).strip()
        if inner.lower().startswith("v("):
            return f"db({inner})"
        return f"db(v({inner}))"

    updated = VDB_RE.sub(replace, line)
    if updated != line:
        warnings.append("normalized vdb() measurement expression to db(v()).")
    return updated


def combined_ac_card(ac_cards: list[str], warnings: list[str]) -> str:
    if not ac_cards:
        warnings.append("inserted missing .ac analysis card")
        return ".ac dec 100 1 10G"

    parsed_cards: list[tuple[str, int, float, float]] = []
    for card in ac_cards:
        tokens = card.split()
        if len(tokens) < 5:
            warnings.append(f"ignored malformed .ac card: {card}")
            continue
        mode = tokens[1].lower()
        try:
            points = int(float(tokens[2]))
        except ValueError:
            points = 100
        start = parse_spice_number(tokens[3])
        stop = parse_spice_number(tokens[4])
        if start is None or stop is None or start <= 0 or stop <= 0:
            warnings.append(f"ignored unparseable .ac card: {card}")
            continue
        parsed_cards.append((mode, points, min(start, stop), max(start, stop)))

    if not parsed_cards:
        warnings.append("inserted fallback .ac card because no valid .ac card was found")
        return ".ac dec 100 1 10G"

    mode = "dec" if any(card[0] == "dec" for card in parsed_cards) else parsed_cards[0][0]
    points = max(card[1] for card in parsed_cards)
    start = min(card[2] for card in parsed_cards)
    stop = max(card[3] for card in parsed_cards)
    if len(parsed_cards) > 1:
        warnings.append(
            f"merged {len(parsed_cards)} .ac cards into one {mode} sweep from {format_spice_number(start)} to {format_spice_number(stop)}"
        )
    return f".ac {mode} {points} {format_spice_number(start)} {format_spice_number(stop)}"


def ensure_ac_print(ac_lines: list[str], warnings: list[str]) -> list[str]:
    filtered = [
        line
        for line in ac_lines
        if not (
            directive_name(line.strip().lstrip("\ufeff")) == ".print"
            and second_token(line.strip().lstrip("\ufeff")) == "ac"
        )
    ]
    if len(filtered) != len(ac_lines):
        warnings.append("replaced existing AC print directives with a compact standard print set")
    else:
        warnings.append("inserted AC print directive so ngspice saves vectors for .meas ac")
    return [*filtered, ".print ac v(in) v(alarm_n) v(bb_out)"]


def should_convert_dc_measurement_to_power(name: str) -> bool:
    lower = name.lower()
    if any(key in lower for key in ("idd", "current", "power", "pdc")):
        return False
    return any(key in lower for key in ("threshold", "window", "supply", "vth", "_v"))


def convert_dc_measurement_to_power(line: str, power_analysis: str, power_sample_time: str, warnings: list[str]) -> str | None:
    name = measurement_name(line)
    if not name or not should_convert_dc_measurement_to_power(name):
        return None

    converted = re.sub(r"^(\s*\.meas(?:ure)?)\s+dc\b", rf"\1 {power_analysis}", line, flags=re.IGNORECASE)
    if power_analysis == "tran" and re.search(r"\bfind\b", converted, re.IGNORECASE):
        if re.search(r"\bat\s*=", converted, re.IGNORECASE):
            converted = re.sub(r"\bat\s*=\s*\S+", f"AT={power_sample_time}", converted, flags=re.IGNORECASE)
        else:
            converted = f"{converted} AT={power_sample_time}"
    if power_analysis == "op":
        converted = re.sub(r"\s+\bat\s*=\s*\S+", "", converted, flags=re.IGNORECASE)
    warnings.append(f"converted dc measurement {name} to {power_analysis} measurement")
    return converted


def normalize_tran_card(line: str, warnings: list[str], max_points: int = 200_000) -> str:
    tokens = line.split()
    if len(tokens) < 3 or tokens[0].lower() != ".tran":
        return line
    step = parse_spice_number(tokens[1])
    stop = parse_spice_number(tokens[2])
    if step is None or stop is None or step <= 0 or stop <= 0:
        return line
    points = stop / step
    if points <= max_points:
        return line
    new_step = stop / max_points
    normalized = f".tran {format_spice_number(new_step)} {tokens[2]}"
    if len(tokens) > 3:
        normalized = " ".join([normalized, *tokens[3:]])
    warnings.append(f"coarsened transient step from {tokens[1]} to {format_spice_number(new_step)} to limit simulation points")
    return normalized


def ensure_power_measurements(
    power_lines: list[str],
    *,
    power_analysis: str,
    supply_source: str,
    supply_voltage_expr: str,
    power_sample_time: str,
    warnings: list[str],
) -> list[str]:
    out = list(power_lines)
    existing_meas = collect_meas_names(out)

    analysis = power_analysis.lower()
    if analysis == "tran":
        measurement_lines = [
            f".meas tran idd_a FIND i({supply_source}) AT={power_sample_time}",
            f".meas tran pdc_w PARAM='{supply_voltage_expr}*(-1)*idd_a'",
            ".meas tran idd_ma PARAM='(-1)*idd_a*1000'",
        ]
    elif analysis == "op":
        measurement_lines = [
            f".meas op idd_a FIND i({supply_source})",
            f".meas op pdc_w PARAM='{supply_voltage_expr}*(-1)*idd_a'",
            ".meas op idd_ma PARAM='(-1)*idd_a*1000'",
        ]
    else:
        measurement_lines = [
            f".meas dc idd_a FIND i({supply_source})",
            f".meas dc pdc_w PARAM='{supply_voltage_expr}*(-1)*idd_a'",
            ".meas dc idd_ma PARAM='(-1)*idd_a*1000'",
        ]

    for line in measurement_lines:
        metric_name = line.split()[2]
        if metric_name in existing_meas:
            continue
        out.append(line)
        existing_meas.add(metric_name)
        warnings.append(f"inserted power measurement: {metric_name}")

    # Ensure a matching print directive exists for the selected analysis.
    analysis_print = f".print {analysis} i({supply_source})"
    has_print = any(
        directive_name(line.strip().lstrip("\ufeff")) == ".print"
        and second_token(line.strip().lstrip("\ufeff")) == analysis
        for line in out
    )
    if not has_print:
        out.append(analysis_print)
        warnings.append(f"inserted power print directive for {analysis}")

    return out


def ensure_power_analysis_card(
    power_lines: list[str],
    *,
    power_analysis: str,
    power_tran_step: str,
    power_tran_stop: str,
    warnings: list[str],
) -> list[str]:
    out = list(power_lines)
    analysis = power_analysis.lower()
    has_card = False
    for line in out:
        stripped = line.strip().lstrip("\ufeff")
        if directive_name(stripped) == f".{analysis}":
            has_card = True
            break

    if not has_card:
        if analysis == "tran":
            out.append(f".tran {power_tran_step} {power_tran_stop}")
        elif analysis == "op":
            out.append(".op")
        else:
            out.append(".dc TEMP 27 27 1")
        warnings.append(f"inserted missing .{analysis} analysis card")
    return out


def main() -> int:
    args = build_parser().parse_args()

    netlist_path = Path(args.netlist_path).resolve()
    ac_path = Path(args.ac_netlist_path).resolve()
    power_path = Path(args.power_netlist_path).resolve()

    result = {
        "ok": False,
        "ac_netlist_path": str(ac_path),
        "power_netlist_path": str(power_path),
        "warnings": [],
    }

    if not netlist_path.exists():
        result["warnings"].append(f"netlist not found: {netlist_path}")
        print(json.dumps(result, ensure_ascii=False))
        return 1

    original_lines = netlist_path.read_text(encoding="utf-8-sig", errors="ignore").splitlines()
    ac_lines: list[str] = []
    power_lines: list[str] = []
    ac_cards: list[str] = []

    power_analysis = args.power_analysis.lower()

    for line in original_lines:
        stripped = line.strip().lstrip("\ufeff")
        if stripped.lower() == ".end":
            continue

        if is_comment_or_blank(stripped):
            ac_lines.append(line)
            power_lines.append(line)
            continue

        if not stripped.startswith("."):
            tokens = stripped.split()
            if is_independent_source(tokens):
                has_ac = has_ac_stimulus(stripped)
                has_time = has_time_domain_stimulus(stripped)
                if has_ac:
                    ac_lines.append(line)
                if has_time:
                    power_lines.append(line)
                if not has_ac and not has_time:
                    ac_lines.append(line)
                    power_lines.append(line)
                if has_ac and not has_time:
                    result["warnings"].append(f"kept AC-only source out of {power_analysis} split: {tokens[0]}")
                if has_time and not has_ac:
                    result["warnings"].append(f"kept time-domain source out of AC split: {tokens[0]}")
                continue
            ac_lines.append(line)
            power_lines.append(line)
            continue

        dname = directive_name(stripped)
        token2 = second_token(stripped)

        if dname in {".ac", ".tran", ".op", ".dc"}:
            if dname == ".ac":
                ac_cards.append(stripped)
            elif dname == f".{power_analysis}":
                power_lines.append(normalize_tran_card(line, result["warnings"]) if dname == ".tran" else line)
            continue

        if dname in {".print", ".plot"}:
            if token2 == "ac":
                ac_lines.append(line)
            elif token2 == power_analysis:
                power_lines.append(line)
            else:
                if token2 == "":
                    ac_lines.append(line)
                    power_lines.append(line)
                    result["warnings"].append(f"kept ambiguous directive in both netlists: {stripped}")
            continue

        if dname in {".meas", ".measure"}:
            if token2 == "ac":
                ac_lines.append(normalize_vdb_expression(line, result["warnings"]))
            elif token2 == power_analysis:
                power_lines.append(line)
            elif token2 == "dc":
                converted = convert_dc_measurement_to_power(
                    line,
                    power_analysis,
                    args.power_sample_time,
                    result["warnings"],
                )
                if converted:
                    power_lines.append(converted)
            continue

        # Non-analysis directives are copied to both outputs.
        ac_lines.append(line)
        power_lines.append(line)

    ac_lines.append(combined_ac_card(ac_cards, result["warnings"]))
    ac_lines = ensure_ac_print(ac_lines, result["warnings"])

    power_lines = ensure_power_analysis_card(
        power_lines,
        power_analysis=power_analysis,
        power_tran_step=args.power_tran_step,
        power_tran_stop=args.power_tran_stop,
        warnings=result["warnings"],
    )
    power_lines = ensure_power_measurements(
        power_lines,
        power_analysis=power_analysis,
        supply_source=args.supply_source,
        supply_voltage_expr=args.supply_voltage_expr,
        power_sample_time=args.power_sample_time,
        warnings=result["warnings"],
    )

    ac_lines.append(".end")
    power_lines.append(".end")

    ac_path.parent.mkdir(parents=True, exist_ok=True)
    power_path.parent.mkdir(parents=True, exist_ok=True)
    ac_path.write_text("\n".join(ac_lines) + "\n", encoding="utf-8")
    power_path.write_text("\n".join(power_lines) + "\n", encoding="utf-8")

    result["ok"] = True
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
