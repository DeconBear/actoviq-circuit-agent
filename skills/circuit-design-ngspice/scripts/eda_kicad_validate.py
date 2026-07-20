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
import uuid
from pathlib import Path
from typing import Any

from eda_symbols import binding_for


SCHEMA = "actoviq.kicad-connectivity-validation.v1"
PACKAGE_SCHEMA = "actoviq.kicad-package-validation.v1"


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

    Component pin membership is always compared.  Single-page exports also
    verify that each real module port labels the expected component-pin group,
    catching dangling labels that partition-only comparison would miss.  The
    XML is expected to come from the complete project/root schematic so
    hierarchical nets are already flattened.
    """
    refs, endpoints = _indexes(ir, symbol_map)
    expected_groups = _expected_groups(ir, endpoints)
    root = ET.parse(Path(netlist_path)).getroot()
    actual_sets: list[set[str]] = []
    actual_endpoint_names: dict[str, str] = {}
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
            net_name = str(net.get("name", ""))
            for endpoint in group:
                if not endpoint.startswith("@kicad:"):
                    actual_endpoint_names[endpoint] = net_name
    actual_groups = _canonical_groups(actual_sets)
    expected_endpoints = {endpoint for group in expected_groups for endpoint in group}
    actual_endpoints = {endpoint for group in actual_groups for endpoint in group}
    missing = sorted(expected_endpoints - actual_endpoints)
    unexpected = sorted(actual_endpoints - expected_endpoints)
    expected_hash = _groups_hash(expected_groups)
    actual_hash = _groups_hash(actual_groups)
    port_label_mismatches: list[dict[str, Any]] = []
    port_labels_checked = 0
    # On a single-page export every module port is a real global label.  Pin
    # partition equality alone cannot detect a dangling label (KiCad may give
    # the still-connected component group an auto-generated Net-(...) name),
    # so verify that each labelled group acquired the requested port name.
    pages = ir.get("pages", [])
    if len(pages) == 1:
        page = pages[0]
        page_id = str(page.get("id", ""))
        nets_by_id = {str(net.get("id", "")): net for net in page.get("nets", [])}
        nets_by_name = {str(net.get("name", "")): net for net in page.get("nets", [])}
        for port in page.get("ports", []):
            net = nets_by_id.get(str(port.get("net_id", ""))) or nets_by_name.get(str(port.get("net", "")))
            if net is None:
                continue
            component_endpoints = [
                _endpoint(page_id, str(item.get("component_id", "")), str(item.get("pin_id", "")))
                for item in net.get("endpoints", [])
                if item.get("kind") == "pin"
            ]
            if not component_endpoints:
                continue
            port_labels_checked += 1
            actual_names = sorted({actual_endpoint_names.get(endpoint, "") for endpoint in component_endpoints})
            expected_name = str(port.get("name", ""))
            if len(actual_names) != 1 or actual_names[0].casefold() != expected_name.casefold():
                port_label_mismatches.append({
                    "port_id": str(port.get("id", "")),
                    "expected_name": expected_name,
                    "actual_names": actual_names,
                    "component_endpoints": component_endpoints,
                })
    return {
        "schema": SCHEMA,
        "passed": not missing and not unexpected and expected_groups == actual_groups and not port_label_mismatches,
        "missing_endpoints": missing,
        "unexpected_endpoints": unexpected,
        "expected_groups": expected_groups,
        "actual_groups": actual_groups,
        "expected_hash": expected_hash,
        "actual_hash": actual_hash,
        "port_labels_checked": port_labels_checked,
        "port_label_mismatches": port_label_mismatches,
    }


def _sexpr_tokens(text: str) -> list[str]:
    tokens: list[str] = []
    index = 0
    while index < len(text):
        character = text[index]
        if character.isspace():
            index += 1
            continue
        if character == ";":
            newline = text.find("\n", index)
            index = len(text) if newline < 0 else newline + 1
            continue
        if character in "()":
            tokens.append(character)
            index += 1
            continue
        if character == '"':
            index += 1
            value: list[str] = []
            while index < len(text):
                character = text[index]
                if character == '"':
                    index += 1
                    break
                if character == "\\":
                    index += 1
                    if index >= len(text):
                        raise ValueError("unterminated escape in KiCad S-expression")
                    escapes = {"n": "\n", "r": "\r", "t": "\t"}
                    value.append(escapes.get(text[index], text[index]))
                    index += 1
                    continue
                value.append(character)
                index += 1
            else:
                raise ValueError("unterminated string in KiCad S-expression")
            tokens.append("".join(value))
            continue
        end = index
        while end < len(text) and not text[end].isspace() and text[end] not in "();":
            end += 1
        if end == index:
            raise ValueError(f"invalid KiCad S-expression token at offset {index}")
        tokens.append(text[index:end])
        index = end
    return tokens


def _parse_sexpr(text: str) -> list[Any]:
    tokens = _sexpr_tokens(text)

    def parse(index: int) -> tuple[list[Any], int]:
        if index >= len(tokens) or tokens[index] != "(":
            raise ValueError("KiCad S-expression must start with '('")
        result: list[Any] = []
        index += 1
        while index < len(tokens) and tokens[index] != ")":
            if tokens[index] == "(":
                child, index = parse(index)
                result.append(child)
            else:
                result.append(tokens[index])
                index += 1
        if index >= len(tokens):
            raise ValueError("unbalanced KiCad S-expression")
        return result, index + 1

    root, next_index = parse(0)
    if next_index != len(tokens):
        raise ValueError("trailing data after KiCad S-expression")
    return root


def _head(value: Any) -> str:
    return str(value[0]) if isinstance(value, list) and value and isinstance(value[0], str) else ""


def _children(value: list[Any], name: str) -> list[list[Any]]:
    return [entry for entry in value[1:] if isinstance(entry, list) and _head(entry) == name]


def _child_value(value: list[Any], name: str) -> str | None:
    entries = _children(value, name)
    if not entries or len(entries[0]) < 2 or isinstance(entries[0][1], list):
        return None
    return str(entries[0][1])


def _walk(value: Any) -> Any:
    if isinstance(value, list):
        yield value
        for entry in value:
            yield from _walk(entry)


def _definition_details(symbol: list[Any], owner: str) -> dict[str, Any]:
    numbers: list[str] = []
    graphic_kinds: list[str] = []
    for unit in _children(symbol, "symbol"):
        for entry in unit[2:]:
            head = _head(entry)
            if head == "pin":
                number = _child_value(entry, "number")
                if number is None or not number.strip():
                    raise ValueError(f"KiCad symbol {owner} has a pin without a number")
                numbers.append(number)
            elif head in {"arc", "bezier", "circle", "rectangle", "polyline", "text", "text_box"}:
                graphic_kinds.append(head)
    if not numbers:
        raise ValueError(f"KiCad symbol {owner} has no pins")
    if len(numbers) != len(set(numbers)):
        raise ValueError(f"KiCad symbol {owner} has duplicate pin numbers")
    if not graphic_kinds:
        raise ValueError(f"KiCad symbol {owner} has no recognizable graphics")
    properties = {
        str(entry[1])
        for entry in _children(symbol, "property")
        if len(entry) >= 3 and not isinstance(entry[1], list)
    }
    required_properties = {"Reference", "Value", "Footprint", "Datasheet", "Description"}
    missing_properties = sorted(required_properties - properties)
    if missing_properties:
        raise ValueError(f"KiCad symbol {owner} is missing properties: {missing_properties}")
    return {
        "pins": sorted(numbers),
        "graphics": sorted(graphic_kinds),
        "properties": sorted(properties),
    }


def _property_values(symbol: list[Any]) -> dict[str, str]:
    result: dict[str, str] = {}
    for entry in _children(symbol, "property"):
        if len(entry) >= 3 and not isinstance(entry[1], list) and not isinstance(entry[2], list):
            result[str(entry[1])] = str(entry[2])
    return result


def _at_xy(value: list[Any], owner: str) -> tuple[float, float]:
    at = _children(value, "at")
    if len(at) != 1 or len(at[0]) < 3:
        raise ValueError(f"{owner} must contain one (at x y) coordinate")
    try:
        return float(at[0][1]), float(at[0][2])
    except (TypeError, ValueError) as error:
        raise ValueError(f"{owner} has an invalid coordinate") from error


def _wire_points(value: list[Any], owner: str) -> tuple[tuple[float, float], tuple[float, float]]:
    pts = _children(value, "pts")
    if len(pts) != 1:
        raise ValueError(f"{owner} must contain one pts section")
    xy = _children(pts[0], "xy")
    if len(xy) != 2 or any(len(point) < 3 for point in xy):
        raise ValueError(f"{owner} must contain exactly two xy points")
    try:
        points = tuple((float(point[1]), float(point[2])) for point in xy)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{owner} has an invalid wire coordinate") from error
    if points[0] == points[1]:
        raise ValueError(f"{owner} is a zero-length wire")
    if points[0][0] != points[1][0] and points[0][1] != points[1][1]:
        raise ValueError(f"{owner} is not orthogonal")
    return points[0], points[1]


def _validate_uuid(value: str | None, owner: str, seen: set[str]) -> None:
    if not value:
        raise ValueError(f"missing UUID for {owner}")
    try:
        normalized = str(uuid.UUID(value))
    except (ValueError, AttributeError) as error:
        raise ValueError(f"invalid UUID for {owner}: {value}") from error
    if normalized in seen:
        raise ValueError(f"duplicate KiCad UUID {normalized} at {owner}")
    seen.add(normalized)


def validate_kicad_package(
    package_root: str | os.PathLike[str],
    ir: dict[str, Any] | None = None,
    symbol_map: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Parse and cross-check a portable KiCad schematic package.

    Unlike a parentheses-balance check, this verifies that every instance
    resolves to both an embedded definition and its project-local library,
    that pin numbers agree in all three places, and that instance/page IDs
    match the EDA IR when it is supplied.
    """
    root = Path(package_root)
    table_path = root / "sym-lib-table"
    if not table_path.is_file():
        raise ValueError("KiCad package is missing sym-lib-table")
    table = _parse_sexpr(table_path.read_text(encoding="utf-8"))
    if _head(table) != "sym_lib_table":
        raise ValueError("invalid KiCad sym-lib-table root")

    libraries: dict[str, dict[str, dict[str, Any]]] = {}
    for entry in _children(table, "lib"):
        name = _child_value(entry, "name")
        uri = _child_value(entry, "uri")
        if not name or not uri or not uri.startswith("${KIPRJMOD}/"):
            raise ValueError("KiCad symbol table entries must reference project-local libraries")
        prefix = "${KIPRJMOD}/"
        library_path = root / (uri[len(prefix):] if uri.startswith(prefix) else uri)
        if not library_path.is_file():
            raise ValueError(f"KiCad local symbol library is missing: {library_path.name}")
        parsed = _parse_sexpr(library_path.read_text(encoding="utf-8"))
        if _head(parsed) != "kicad_symbol_lib":
            raise ValueError(f"invalid KiCad symbol library root: {library_path.name}")
        cells: dict[str, dict[str, Any]] = {}
        for symbol in _children(parsed, "symbol"):
            if len(symbol) < 2 or isinstance(symbol[1], list):
                raise ValueError(f"unnamed KiCad symbol in {library_path.name}")
            cell = str(symbol[1])
            if cell in cells:
                raise ValueError(f"duplicate KiCad symbol {name}:{cell}")
            cells[cell] = _definition_details(symbol, f"{name}:{cell}")
        if not cells:
            raise ValueError(f"KiCad local library {name} has no symbols")
        if name in libraries:
            raise ValueError(f"duplicate KiCad library nickname: {name}")
        libraries[name] = cells

    expected: dict[tuple[str, str], dict[str, Any]] = {}
    if ir is not None and symbol_map is not None:
        for page in ir.get("pages", []):
            page_id = str(page.get("id", ""))
            for component in page.get("components", []):
                component_id = str(component.get("id", ""))
                binding = binding_for(symbol_map, "kicad", page_id, component)
                lib_id = f"{binding['library']}:{binding['cell']}"
                expected[(page_id, component_id)] = {
                    "lib_id": lib_id,
                    "pins": sorted(str(value) for value in binding["pin_map"].values()),
                    "refdes": str((component.get("eda") or {}).get("refdes") or component.get("name", "")),
                }

    seen_instances: set[tuple[str, str]] = set()
    seen_uuids: set[str] = set()
    schematic_count = 0
    instance_count = 0
    junction_count = 0
    for schematic_path in sorted(root.glob("*.kicad_sch")):
        schematic_count += 1
        schematic = _parse_sexpr(schematic_path.read_text(encoding="utf-8"))
        if _head(schematic) != "kicad_sch":
            raise ValueError(f"invalid KiCad schematic root: {schematic_path.name}")
        for entry in _walk(schematic):
            if _head(entry) == "uuid":
                _validate_uuid(str(entry[1]) if len(entry) > 1 else None, schematic_path.name, seen_uuids)

        wire_neighbours: dict[tuple[float, float], set[tuple[float, float]]] = {}
        for wire_index, wire in enumerate(_children(schematic, "wire")):
            start, end = _wire_points(wire, f"{schematic_path.name} wire {wire_index}")
            if min(*start, *end) < 0:
                raise ValueError(f"{schematic_path.name} contains a negative wire coordinate")
            wire_neighbours.setdefault(start, set()).add(end)
            wire_neighbours.setdefault(end, set()).add(start)
        for kind in ("global_label", "hierarchical_label", "symbol"):
            for item_index, item in enumerate(_children(schematic, kind)):
                x, y = _at_xy(item, f"{schematic_path.name} {kind} {item_index}")
                if x < 0 or y < 0:
                    raise ValueError(f"{schematic_path.name} contains a negative {kind} coordinate")
        for junction_index, junction in enumerate(_children(schematic, "junction")):
            point = _at_xy(junction, f"{schematic_path.name} junction {junction_index}")
            if point[0] < 0 or point[1] < 0:
                raise ValueError(f"{schematic_path.name} contains a negative junction coordinate")
            if len(wire_neighbours.get(point, set())) < 3:
                raise ValueError(f"{schematic_path.name} junction at {point} does not join at least three wire directions")
            junction_count += 1

        embedded: dict[str, dict[str, Any]] = {}
        lib_sections = _children(schematic, "lib_symbols")
        if len(lib_sections) != 1:
            raise ValueError(f"KiCad schematic must contain one lib_symbols section: {schematic_path.name}")
        for symbol in _children(lib_sections[0], "symbol"):
            if len(symbol) < 2 or isinstance(symbol[1], list):
                raise ValueError(f"unnamed embedded symbol in {schematic_path.name}")
            lib_id = str(symbol[1])
            embedded[lib_id] = _definition_details(symbol, lib_id)

        for instance in _children(schematic, "symbol"):
            lib_id = _child_value(instance, "lib_id")
            if lib_id is None:
                continue
            instance_count += 1
            if lib_id not in embedded:
                raise ValueError(f"KiCad instance references missing embedded symbol: {lib_id}")
            library, separator, cell = lib_id.partition(":")
            if not separator or library not in libraries or cell not in libraries[library]:
                raise ValueError(f"KiCad instance references missing local symbol: {lib_id}")
            if embedded[lib_id] != libraries[library][cell]:
                raise ValueError(f"embedded/local KiCad symbol definitions disagree: {lib_id}")
            pins = _children(instance, "pin")
            pin_numbers = [str(pin[1]) for pin in pins if len(pin) >= 2 and not isinstance(pin[1], list)]
            if len(pin_numbers) != len(pins) or len(pin_numbers) != len(set(pin_numbers)):
                raise ValueError(f"KiCad instance {lib_id} has missing or duplicate pins")
            if sorted(pin_numbers) != embedded[lib_id]["pins"]:
                raise ValueError(f"KiCad instance pins do not match definition {lib_id}")
            properties = _property_values(instance)
            page_id = properties.get("ACTOVIQ_PAGE_ID", "")
            component_id = properties.get("ACTOVIQ_ID", "")
            key = (page_id, component_id)
            if not page_id or not component_id:
                raise ValueError(f"KiCad instance {lib_id} is missing Actoviq identity properties")
            if key in seen_instances:
                raise ValueError(f"duplicate KiCad component instance: {page_id}:{component_id}")
            seen_instances.add(key)
            if expected:
                wanted = expected.get(key)
                if wanted is None:
                    raise ValueError(f"unexpected KiCad component instance: {page_id}:{component_id}")
                if lib_id != wanted["lib_id"] or sorted(pin_numbers) != wanted["pins"]:
                    raise ValueError(f"KiCad symbol or pin map mismatch for {page_id}:{component_id}")
                if properties.get("Reference") != wanted["refdes"]:
                    raise ValueError(f"KiCad reference mismatch for {page_id}:{component_id}")

    if not schematic_count:
        raise ValueError("KiCad package has no schematic files")
    if expected and seen_instances != set(expected):
        missing = sorted(set(expected) - seen_instances)
        raise ValueError(f"KiCad package is missing component instances: {missing}")
    return {
        "schema": PACKAGE_SCHEMA,
        "passed": True,
        "schematics": schematic_count,
        "libraries": len(libraries),
        "symbols": sum(len(cells) for cells in libraries.values()),
        "instances": instance_count,
        "junctions": junction_count,
        "validated_component_ids": [f"{page_id}:{component_id}" for page_id, component_id in sorted(seen_instances)],
    }
