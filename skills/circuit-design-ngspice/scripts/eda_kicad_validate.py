"""KiCad CLI discovery and exported-netlist connectivity validation.

The validator compares connectivity partitions, not net names.  Canonical
endpoints use ``<page-id>:<component-id>:<source-pin-id>`` and KiCad pin
numbers/names are translated through the resolved symbol map.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from eda_symbols import binding_for


SCHEMA = "actoviq.kicad-connectivity-validation.v1"


def _as_executable(value: str | os.PathLike[str] | None) -> str | None:
    if not value:
        return None
    raw = os.path.expandvars(os.path.expanduser(str(value).strip().strip('"')))
    path = Path(raw)
    candidates = [path]
    if path.is_dir():
        candidates = [path / "bin" / "kicad-cli.exe", path / "kicad-cli.exe"]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate.resolve())
    found = shutil.which(raw)
    return str(Path(found).resolve()) if found else None


def _registry_kicad_cli() -> str | None:
    if os.name != "nt":
        return None
    try:
        import winreg
    except ImportError:
        return None

    uninstall = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"
    locations: set[str] = set()
    views = (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY)
    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        for view in views:
            try:
                root = winreg.OpenKey(hive, uninstall, 0, winreg.KEY_READ | view)
            except OSError:
                continue
            with root:
                try:
                    count = winreg.QueryInfoKey(root)[0]
                except OSError:
                    continue
                for index in range(count):
                    try:
                        name = winreg.EnumKey(root, index)
                        with winreg.OpenKey(root, name) as entry:
                            display = str(winreg.QueryValueEx(entry, "DisplayName")[0])
                            location = str(winreg.QueryValueEx(entry, "InstallLocation")[0])
                    except OSError:
                        continue
                    if "kicad" in f"{name} {display}".casefold() and location.strip():
                        locations.add(location.strip().strip('"'))
    # Prefer the newest conventional version path when several KiCad releases
    # are installed (for example, ...\9.0 sorts after ...\8.0).
    for location in sorted(locations, reverse=True):
        executable = _as_executable(location)
        if executable:
            return executable
    return None


def find_kicad_cli() -> str | None:
    """Return an absolute kicad-cli path from env, PATH, or Windows registry."""
    return (
        _as_executable(os.environ.get("KICAD_CLI_BIN"))
        or _as_executable(shutil.which("kicad-cli"))
        or _registry_kicad_cli()
    )


def _endpoint(page_id: str, component_id: str, pin_id: str) -> str:
    return f"{page_id}:{component_id}:{pin_id}"


def _canonical_groups(groups: list[set[str]]) -> list[list[str]]:
    normalized = {tuple(sorted(group)) for group in groups if group}
    return [list(group) for group in sorted(normalized)]


def _groups_hash(groups: list[list[str]]) -> str:
    payload = json.dumps(groups, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _indexes(
    ir: dict[str, Any], symbol_map: dict[str, Any]
) -> tuple[dict[str, tuple[str, dict[str, str]]], dict[tuple[str, str, str], str]]:
    refs: dict[str, tuple[str, dict[str, str]]] = {}
    endpoints: dict[tuple[str, str, str], str] = {}
    for page in ir.get("pages", []):
        page_id = str(page.get("id", ""))
        for component in page.get("components", []):
            component_id = str(component.get("id", ""))
            eda = component.get("eda") if isinstance(component.get("eda"), dict) else {}
            refdes = str(eda.get("refdes", "")).strip()
            if not refdes:
                raise ValueError(f"missing EDA reference designator: {page_id}:{component_id}")
            binding = binding_for(symbol_map, "kicad", page_id, component)
            reverse: dict[str, str] = {}
            for source_pin, target_pin in binding["pin_map"].items():
                folded = str(target_pin).casefold()
                if folded in reverse:
                    raise ValueError(f"duplicate KiCad target pin for {page_id}:{component_id}")
                reverse[folded] = str(source_pin)
                key = (page_id, component_id, str(source_pin))
                endpoints[key] = _endpoint(*key)
            ref_key = refdes.casefold()
            if ref_key in refs:
                raise ValueError(f"duplicate EDA reference designator: {refdes}")
            refs[ref_key] = (f"{page_id}:{component_id}", reverse)
    return refs, endpoints


def _expected_groups(
    ir: dict[str, Any], endpoints: dict[tuple[str, str, str], str]
) -> list[list[str]]:
    assigned: dict[tuple[str, str, str], str] = {}
    by_net: dict[str, set[str]] = {}
    for record in (ir.get("connectivity") or {}).get("records", []):
        if not record.get("component_id"):
            continue
        key = (
            str(record.get("module_id", "")),
            str(record.get("component_id", "")),
            str(record.get("pin_id", "")),
        )
        if key not in endpoints:
            raise ValueError(f"connectivity record references unknown endpoint: {_endpoint(*key)}")
        net = str(record.get("net", ""))
        if key in assigned and assigned[key] != net:
            raise ValueError(f"endpoint appears on multiple IR nets: {endpoints[key]}")
        assigned[key] = net
        by_net.setdefault(net, set()).add(endpoints[key])

    # Older EDA IR files may lack normalized connectivity records.  Page nets
    # provide an unambiguous local fallback for any still-unassigned pin.
    for page in ir.get("pages", []):
        page_id = str(page.get("id", ""))
        for net_index, net in enumerate(page.get("nets", [])):
            local_net = f"@local:{page_id}:{net.get('id', net_index)}"
            for item in net.get("endpoints", []):
                if item.get("kind") != "pin":
                    continue
                key = (page_id, str(item.get("component_id", "")), str(item.get("pin_id", "")))
                if key in endpoints and key not in assigned:
                    assigned[key] = local_net
                    by_net.setdefault(local_net, set()).add(endpoints[key])
    for key, endpoint in endpoints.items():
        if key not in assigned:
            by_net[f"@unassigned:{endpoint}"] = {endpoint}
    return _canonical_groups(list(by_net.values()))


def validate_kicad_xml_connectivity(
    netlist_path: str | os.PathLike[str],
    ir: dict[str, Any],
    symbol_map: dict[str, Any],
) -> dict[str, Any]:
    """Compare a KiCad ``kicadxml`` netlist with the EDA IR pin partition.

    Ports and net names are intentionally ignored; only component pin
    membership is compared.  The XML is expected to be produced from the
    complete project/root schematic so hierarchical nets are already flattened.
    """
    refs, endpoints = _indexes(ir, symbol_map)
    expected_groups = _expected_groups(ir, endpoints)
    root = ET.parse(Path(netlist_path)).getroot()
    actual_sets: list[set[str]] = []
    for net in root.iter():
        if _local_name(net.tag) != "net":
            continue
        group: set[str] = set()
        for node in net:
            if _local_name(node.tag) != "node":
                continue
            ref = str(node.get("ref", ""))
            pin = str(node.get("pin", ""))
            indexed = refs.get(ref.casefold())
            if indexed is None or pin.casefold() not in indexed[1]:
                group.add(f"@kicad:{ref}:{pin}")
                continue
            owner, pin_map = indexed
            group.add(f"{owner}:{pin_map[pin.casefold()]}")
        if group:
            actual_sets.append(group)
    actual_groups = _canonical_groups(actual_sets)
    expected_endpoints = {endpoint for group in expected_groups for endpoint in group}
    actual_endpoints = {endpoint for group in actual_groups for endpoint in group}
    missing = sorted(expected_endpoints - actual_endpoints)
    unexpected = sorted(actual_endpoints - expected_endpoints)
    expected_hash = _groups_hash(expected_groups)
    actual_hash = _groups_hash(actual_groups)
    return {
        "schema": SCHEMA,
        "passed": not missing and not unexpected and expected_groups == actual_groups,
        "missing_endpoints": missing,
        "unexpected_endpoints": unexpected,
        "expected_groups": expected_groups,
        "actual_groups": actual_groups,
        "expected_hash": expected_hash,
        "actual_hash": actual_hash,
    }
