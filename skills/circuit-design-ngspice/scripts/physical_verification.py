#!/usr/bin/env python3
"""External physical verification providers; layout and rule decks remain authoritative."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from verification_contracts import validate_verification_run


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def _resolve_executable(configured: str, fallback: str) -> str:
    candidate = configured.strip() if configured else fallback
    located = shutil.which(candidate)
    if located:
        return str(Path(located).resolve())
    path = Path(candidate).expanduser()
    if path.is_file():
        return str(path.resolve())
    raise FileNotFoundError(f"executable not found: {candidate}")


def _command(executable: str, arguments: list[str]) -> list[str]:
    if Path(executable).suffix.casefold() == ".py":
        return [sys.executable, executable, *arguments]
    return [executable, *arguments]


def _run(
    executable: str,
    arguments: list[str],
    cwd: Path,
    input_text: str | None = None,
    timeout_seconds: float = 300.0,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        _command(executable, arguments),
        cwd=str(cwd),
        shell=False,
        check=False,
        capture_output=True,
        text=True,
        input=input_text,
        timeout=timeout_seconds,
    )


def _version(executable: str, flags: list[list[str]]) -> str:
    for arguments in flags:
        try:
            completed = _run(executable, arguments, Path.cwd(), timeout_seconds=10.0)
        except (OSError, subprocess.TimeoutExpired):
            continue
        text = "\n".join((completed.stdout, completed.stderr)).strip()
        if text:
            return text.splitlines()[0][:240]
    return Path(executable).name


def _require_file(path: Path, label: str, suffixes: set[str] | None = None) -> Path:
    resolved = path.expanduser().resolve()
    if not resolved.is_file():
        raise ValueError(f"{label} does not exist: {resolved}")
    if suffixes and resolved.suffix.casefold() not in suffixes:
        raise ValueError(f"{label} must use one of {sorted(suffixes)}: {resolved}")
    return resolved


def _artifact(kind: str, path: Path) -> dict[str, str]:
    return {"kind": kind, "path": str(path), "hash": _hash(path)}


def _run_result(
    run_id: str,
    kind: str,
    provider: str,
    executed: bool,
    passed: bool,
    diagnostics: list[str],
    artifacts: list[dict[str, str]],
    metadata: dict[str, Any],
) -> dict[str, Any]:
    return validate_verification_run({
        "schema": "actoviq.verification-run.v1",
        "run_id": run_id,
        "kind": kind,
        "provider_id": provider,
        "executed": executed,
        "status": "passed" if passed else "failed",
        "diagnostics": diagnostics,
        "artifacts": artifacts,
        "metadata": metadata,
        "finished_at": _utc_now(),
    })


def parse_lyrdb(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {
            "report_present": False,
            "report_valid": False,
            "violation_count": 0,
            "categories": [],
            "items": [],
            "report_error": f"expected KLayout report was not created: {path}",
        }
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as error:
        return {
            "report_present": True,
            "report_valid": False,
            "violation_count": 0,
            "categories": [],
            "items": [],
            "parse_error": str(error),
        }
    categories = [
        "".join(node.itertext()).strip()
        for node in root.findall(".//category")
        if "".join(node.itertext()).strip()
    ]
    items: list[dict[str, str]] = []
    for item in root.findall(".//item"):
        values = {
            child.tag.split("}")[-1]: "".join(child.itertext()).strip()
            for child in list(item)
        }
        items.append(values)
    return {
        "report_present": True,
        "report_valid": True,
        "violation_count": len(items),
        "categories": sorted(set(categories)),
        "items": items,
    }


class KLayoutProvider:
    provider_id = "klayout"

    def __init__(self, executable: str = ""):
        self.executable = _resolve_executable(executable, "klayout")
        self.version = _version(self.executable, [["-v"], ["--version"]])

    def _run_rule(
        self,
        kind: str,
        layout: Path,
        rule_deck: Path,
        run_root: Path,
        variables: dict[str, str],
    ) -> subprocess.CompletedProcess[str]:
        layout = _require_file(layout, "layout", {".gds", ".gdsii", ".oas", ".oasis"})
        rule_deck = _require_file(rule_deck, "KLayout rule deck", {".drc", ".lvs", ".lydrc", ".lylvs"})
        run_root.mkdir(parents=True, exist_ok=True)
        arguments = ["-b", "-r", str(rule_deck), "-rd", f"input={layout}"]
        for key, value in sorted(variables.items()):
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
                raise ValueError(f"invalid KLayout runtime variable: {key}")
            arguments.extend(["-rd", f"{key}={value}"])
        return _run(self.executable, arguments, run_root)

    def run_drc(
        self,
        layout: Path,
        rule_deck: Path,
        run_root: Path,
    ) -> dict[str, Any]:
        run_root = run_root.expanduser().resolve()
        report = run_root / "drc.lyrdb"
        completed = self._run_rule(
            "drc",
            layout,
            rule_deck,
            run_root,
            {"report": str(report)},
        )
        parsed = parse_lyrdb(report)
        artifacts = [_artifact("layout", layout.expanduser().resolve()), _artifact("rule_deck", rule_deck.expanduser().resolve())]
        if report.is_file():
            artifacts.append(_artifact("lyrdb", report))
        diagnostics = [part for part in (completed.stdout.strip(), completed.stderr.strip()) if part]
        if parsed.get("report_error"):
            diagnostics.append(str(parsed["report_error"]))
        if parsed.get("parse_error"):
            diagnostics.append(f"lyrdb parse error: {parsed['parse_error']}")
        result = _run_result(
            run_root.name,
            "drc",
            self.provider_id,
            completed.returncode == 0,
            completed.returncode == 0
            and parsed["report_valid"]
            and parsed["violation_count"] == 0,
            diagnostics,
            artifacts,
            {
                "tool_version": self.version,
                "layout_hash": _hash(layout.expanduser().resolve()),
                "rule_deck_hash": _hash(rule_deck.expanduser().resolve()),
                **parsed,
            },
        )
        _atomic_json(run_root / "run.json", result)
        return result

    def run_lvs(
        self,
        layout: Path,
        schematic: Path,
        rule_deck: Path,
        run_root: Path,
    ) -> dict[str, Any]:
        run_root = run_root.expanduser().resolve()
        schematic = _require_file(schematic, "schematic netlist", {".cir", ".sp", ".spi", ".spice", ".cdl"})
        report = run_root / "lvs.lyrdb"
        extracted = run_root / "extracted.spice"
        completed = self._run_rule(
            "lvs",
            layout,
            rule_deck,
            run_root,
            {
                "schematic": str(schematic),
                "report": str(report),
                "extracted": str(extracted),
            },
        )
        parsed = parse_lyrdb(report)
        combined = "\n".join((completed.stdout, completed.stderr)).casefold()
        explicit_mismatch = bool(re.search(r"\bmismatch(?:es)?\b|\bnot equivalent\b", combined))
        artifacts = [
            _artifact("layout", layout.expanduser().resolve()),
            _artifact("schematic", schematic),
            _artifact("rule_deck", rule_deck.expanduser().resolve()),
        ]
        for kind, path in (("lyrdb", report), ("extracted_spice", extracted)):
            if path.is_file():
                artifacts.append(_artifact(kind, path))
        clean = (
            completed.returncode == 0
            and not explicit_mismatch
            and parsed["report_valid"]
            and extracted.is_file()
            and parsed["violation_count"] == 0
        )
        diagnostics = [part for part in (completed.stdout.strip(), completed.stderr.strip()) if part]
        if parsed.get("report_error"):
            diagnostics.append(str(parsed["report_error"]))
        if parsed.get("parse_error"):
            diagnostics.append(f"lyrdb parse error: {parsed['parse_error']}")
        if not extracted.is_file():
            diagnostics.append(f"expected KLayout extracted netlist was not created: {extracted}")
        result = _run_result(
            run_root.name,
            "lvs",
            self.provider_id,
            completed.returncode == 0,
            clean,
            diagnostics,
            artifacts,
            {
                "tool_version": self.version,
                "layout_hash": _hash(layout.expanduser().resolve()),
                "schematic_hash": _hash(schematic),
                "lvs_clean": clean,
                **parsed,
            },
        )
        _atomic_json(run_root / "run.json", result)
        return result


def _tcl_braced(path: Path) -> str:
    value = str(path).replace("\\", "/")
    if any(character in value for character in "{}\n\r"):
        raise ValueError(f"path cannot be represented safely in controlled Magic Tcl: {path}")
    return "{" + value + "}"


class MagicProvider:
    provider_id = "magic"

    def __init__(self, executable: str = ""):
        self.executable = _resolve_executable(executable, "magic")
        self.version = _version(self.executable, [["--version"], ["-version"]])

    def extract(
        self,
        layout: Path,
        tech_file: Path,
        run_root: Path,
        top_cell: str,
    ) -> dict[str, Any]:
        layout = _require_file(layout, "Magic layout", {".mag", ".gds", ".gdsii"})
        tech_file = _require_file(tech_file, "Magic technology/rc file")
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.$-]*", top_cell):
            raise ValueError("Magic top cell contains unsupported characters")
        run_root = run_root.expanduser().resolve()
        run_root.mkdir(parents=True, exist_ok=True)
        output = run_root / "extracted.spice"
        commands = "\n".join([
            f"load {_tcl_braced(layout)}",
            "select top cell",
            "extract do local",
            "extract all",
            "ext2spice lvs",
            f"ext2spice -o {_tcl_braced(output)} {top_cell}",
            "quit -noprompt",
            "",
        ])
        completed = _run(
            self.executable,
            ["-dnull", "-noconsole", "-rcfile", str(tech_file)],
            run_root,
            input_text=commands,
        )
        diagnostics = [part for part in (completed.stdout.strip(), completed.stderr.strip()) if part]
        success = completed.returncode == 0 and output.is_file()
        artifacts = [_artifact("layout", layout), _artifact("magic_tech", tech_file)]
        if output.is_file():
            artifacts.append(_artifact("extracted_spice", output))
        result = _run_result(
            run_root.name,
            "extraction",
            self.provider_id,
            completed.returncode == 0,
            success,
            diagnostics,
            artifacts,
            {
                "tool_version": self.version,
                "layout_hash": _hash(layout),
                "top_cell": top_cell,
                "controlled_commands": True,
            },
        )
        _atomic_json(run_root / "run.json", result)
        return result

    def extract_pex(
        self,
        layout: Path,
        tech_file: Path,
        run_root: Path,
        top_cell: str,
    ) -> dict[str, Any]:
        layout = _require_file(layout, "Magic layout", {".mag", ".gds", ".gdsii"})
        tech_file = _require_file(tech_file, "Magic technology/rc file")
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.$-]*", top_cell):
            raise ValueError("Magic top cell contains unsupported characters")
        run_root = run_root.expanduser().resolve()
        run_root.mkdir(parents=True, exist_ok=True)
        output = run_root / "pex.spice"
        commands = "\n".join([
            f"load {_tcl_braced(layout)}",
            "select top cell",
            "extract do local",
            "extract do resistance",
            "extract all",
            "ext2spice cthresh 0",
            "ext2spice rthresh 0",
            "ext2spice extresist on",
            f"ext2spice -o {_tcl_braced(output)} {top_cell}",
            "quit -noprompt",
            "",
        ])
        completed = _run(
            self.executable,
            ["-dnull", "-noconsole", "-rcfile", str(tech_file)],
            run_root,
            input_text=commands,
        )
        diagnostics = [part for part in (completed.stdout.strip(), completed.stderr.strip()) if part]
        success = completed.returncode == 0 and output.is_file()
        artifacts = [_artifact("layout", layout), _artifact("magic_tech", tech_file)]
        if output.is_file():
            artifacts.append(_artifact("pex_spice", output))
        result = _run_result(
            run_root.name,
            "pex",
            self.provider_id,
            completed.returncode == 0,
            success,
            diagnostics,
            artifacts,
            {
                "tool_version": self.version,
                "layout_hash": _hash(layout),
                "pex_hash": _hash(output) if output.is_file() else "",
                "top_cell": top_cell,
                "controlled_commands": True,
            },
        )
        _atomic_json(run_root / "run.json", result)
        return result


def _parse_netgen_report(path: Path, text: str) -> dict[str, Any]:
    if path.is_file():
        try:
            value = json.loads(path.read_text(encoding="utf-8", errors="replace"))
            clean = bool(value.get("equivalent") or value.get("lvs_clean") or value.get("match"))
            return {"lvs_clean": clean, "report": value}
        except (json.JSONDecodeError, AttributeError):
            pass
    folded = text.casefold()
    clean = bool(re.search(r"netlists\s+match|circuits\s+match|lvs\s+clean", folded))
    mismatch = bool(re.search(r"\bmismatch(?:es)?\b|\bdo not match\b|\bnot equivalent\b", folded))
    return {"lvs_clean": clean and not mismatch, "report": {"text": text[-8000:]}}


class NetgenProvider:
    provider_id = "netgen"

    def __init__(self, executable: str = ""):
        self.executable = _resolve_executable(executable, "netgen")
        self.version = _version(self.executable, [["-version"], ["--version"]])

    def run_lvs(
        self,
        extracted: Path,
        schematic: Path,
        setup_file: Path,
        run_root: Path,
        extracted_cell: str,
        schematic_cell: str,
    ) -> dict[str, Any]:
        extracted = _require_file(extracted, "extracted netlist")
        schematic = _require_file(schematic, "schematic netlist")
        setup_file = _require_file(setup_file, "Netgen setup file")
        for label, value in (("extracted cell", extracted_cell), ("schematic cell", schematic_cell)):
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.$-]*", value):
                raise ValueError(f"{label} contains unsupported characters")
        run_root = run_root.expanduser().resolve()
        run_root.mkdir(parents=True, exist_ok=True)
        report = run_root / "lvs.json"
        completed = _run(
            self.executable,
            [
                "-batch",
                "lvs",
                f"{extracted} {extracted_cell}",
                f"{schematic} {schematic_cell}",
                str(setup_file),
                str(report),
            ],
            run_root,
        )
        combined = "\n".join((completed.stdout, completed.stderr))
        parsed = _parse_netgen_report(report, combined)
        clean = completed.returncode == 0 and parsed["lvs_clean"]
        artifacts = [
            _artifact("extracted_spice", extracted),
            _artifact("schematic", schematic),
            _artifact("netgen_setup", setup_file),
        ]
        if report.is_file():
            artifacts.append(_artifact("lvs_report", report))
        result = _run_result(
            run_root.name,
            "lvs",
            self.provider_id,
            completed.returncode == 0,
            clean,
            [part for part in (completed.stdout.strip(), completed.stderr.strip()) if part],
            artifacts,
            {
                "tool_version": self.version,
                "schematic_hash": _hash(schematic),
                "extracted_hash": _hash(extracted),
                **parsed,
            },
        )
        _atomic_json(run_root / "run.json", result)
        return result
