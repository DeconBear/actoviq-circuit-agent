"""Structural round-trip validators for portable non-KiCad EDA exports."""

from __future__ import annotations

import json
import math
import os
import re
from pathlib import Path
from typing import Any

from eda_kicad_validate import _child_value, _children, _head, _parse_sexpr, validate_kicad_package
from eda_symbols import binding_for


ALTIUM_SCHEMA = "actoviq.altium-import-package-validation.v1"
ORCAD_SCHEMA = "actoviq.orcad-edif-validation.v1"
VIRTUOSO_SCHEMA = "actoviq.virtuoso-package-validation.v1"


def _safe_name(value: Any, fallback: str = "design") -> str:
    result = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(value).strip()).strip("._")
    return result or fallback


def _edif_identifier(value: Any) -> str:
    result = re.sub(r"[^A-Za-z0-9_]", "_", str(value))
    if not result or result[0].isdigit():
        result = "N_" + result
    return result


def _named_form(forms: list[list[Any]], name: str, owner: str) -> list[Any]:
    matches = [entry for entry in forms if len(entry) >= 2 and not isinstance(entry[1], list) and str(entry[1]) == name]
    if len(matches) != 1:
        raise ValueError(f"expected one {owner} named {name!r}, found {len(matches)}")
    return matches[0]


def _property_values(value: list[Any]) -> dict[str, str]:
    result: dict[str, str] = {}
    for prop in _children(value, "property"):
        if len(prop) < 3 or isinstance(prop[1], list):
            continue
        string = _child_value(prop, "string")
        if string is not None:
            result[str(prop[1])] = string
    return result


def _ref_tuple(port_ref: list[Any]) -> tuple[str, str]:
    if len(port_ref) < 2 or isinstance(port_ref[1], list):
        raise ValueError("EDIF portRef is missing a port name")
    return str(port_ref[1]), _child_value(port_ref, "instanceRef") or ""


def validate_altium_import_package(
    altium_root: str | os.PathLike[str],
    kicad_root: str | os.PathLike[str],
    ir: dict[str, Any],
    symbol_map: dict[str, Any],
) -> dict[str, Any]:
    """Verify that the Altium import source is an exact portable KiCad copy."""
    altium = Path(altium_root)
    kicad = Path(kicad_root)
    required = [
        path for path in kicad.iterdir()
        if path.is_file() and (path.suffix in {".kicad_pro", ".kicad_sch", ".kicad_sym"} or path.name == "sym-lib-table")
    ]
    if not required:
        raise ValueError("Altium package has no KiCad import source")
    mismatched: list[str] = []
    for source in required:
        copied = altium / source.name
        if not copied.is_file() or copied.read_bytes() != source.read_bytes():
            mismatched.append(source.name)
    if mismatched:
        raise ValueError(f"Altium KiCad import source is incomplete or modified: {sorted(mismatched)}")
    package = validate_kicad_package(altium, ir, symbol_map)
    connectivity_path = altium / "connectivity.json"
    if not connectivity_path.is_file() or json.loads(connectivity_path.read_text(encoding="utf-8")) != ir["connectivity"]:
        raise ValueError("Altium connectivity.json does not match the EDA IR")
    readme = altium / "IMPORT_ALTIUM.md"
    if not readme.is_file() or "Import Wizard" not in readme.read_text(encoding="utf-8"):
        raise ValueError("Altium import instructions are missing")
    map_path = altium / "symbol-map.resolved.json"
    mapping = json.loads(map_path.read_text(encoding="utf-8")) if map_path.is_file() else {}
    if (
        mapping.get("schema") != "actoviq.altium-kicad-import-map.v1"
        or mapping.get("source_kicad") != symbol_map["targets"]["kicad"]
        or mapping.get("requested_altium") != symbol_map["targets"]["altium"]
    ):
        raise ValueError("Altium source/target symbol mapping metadata is incomplete")
    return {
        "schema": ALTIUM_SCHEMA,
        "passed": True,
        "copied_files": sorted(path.name for path in required),
        "kicad_package": package,
        "connectivity_hash": ir["connectivity"]["hash"],
    }


def _edif_symbol_cells(root: list[Any]) -> dict[tuple[str, str], dict[str, Any]]:
    result: dict[tuple[str, str], dict[str, Any]] = {}
    for library in _children(root, "library"):
        if len(library) < 2 or isinstance(library[1], list):
            raise ValueError("EDIF library is missing a name")
        library_name = str(library[1])
        if library_name == "ACTOVIQ_DESIGN":
            continue
        for cell in _children(library, "cell"):
            if len(cell) < 2 or isinstance(cell[1], list):
                raise ValueError(f"EDIF library {library_name} has an unnamed cell")
            cell_name = str(cell[1])
            key = (library_name, cell_name)
            if key in result:
                raise ValueError(f"duplicate EDIF symbol cell: {library_name}:{cell_name}")
            view = _named_form(_children(cell, "view"), "SYMBOL", f"view in {library_name}:{cell_name}")
            interfaces = _children(view, "interface")
            contents = _children(view, "contents")
            if len(interfaces) != 1 or len(contents) != 1:
                raise ValueError(f"EDIF symbol cell is incomplete: {library_name}:{cell_name}")
            ports = [str(port[1]) for port in _children(interfaces[0], "port") if len(port) >= 2 and not isinstance(port[1], list)]
            implementations = [
                str(item[1]) for item in _children(contents[0], "portImplementation")
                if len(item) >= 2 and not isinstance(item[1], list)
            ]
            figures = _children(contents[0], "figure")
            if not ports or len(ports) != len(set(ports)) or sorted(ports) != sorted(implementations) or not figures:
                raise ValueError(f"EDIF symbol pins/graphics are incomplete: {library_name}:{cell_name}")
            points = 0
            for implementation in _children(contents[0], "portImplementation"):
                locations = _children(implementation, "connectLocation")
                if len(locations) != 1:
                    raise ValueError(f"EDIF pin has no connect location: {library_name}:{cell_name}")
                point_forms = [entry for figure in _children(locations[0], "figure") for dot in _children(figure, "dot") for entry in _children(dot, "pt")]
                if len(point_forms) != 1 or len(point_forms[0]) < 3:
                    raise ValueError(f"EDIF pin has an invalid coordinate: {library_name}:{cell_name}")
                if not all(math.isfinite(float(value)) for value in point_forms[0][1:3]):
                    raise ValueError(f"EDIF pin has a non-finite coordinate: {library_name}:{cell_name}")
                points += 1
            result[key] = {"ports": sorted(ports), "pin_coordinates": points}
    return result


def validate_orcad_edif(
    edif_path: str | os.PathLike[str],
    ir: dict[str, Any],
    symbol_map: dict[str, Any],
) -> dict[str, Any]:
    """Parse EDIF and compare symbols, instances, nets, hierarchy, and coordinates."""
    path = Path(edif_path)
    root = _parse_sexpr(path.read_text(encoding="utf-8"))
    if _head(root) != "edif":
        raise ValueError("invalid OrCAD EDIF root")
    symbols = _edif_symbol_cells(root)
    design_library = _named_form(_children(root, "library"), "ACTOVIQ_DESIGN", "EDIF design library")
    cells = _children(design_library, "cell")

    validated_instances: set[tuple[str, str]] = set()
    validated_nets: set[tuple[str, str]] = set()
    wire_segment_groups = 0
    for page in ir["pages"]:
        page_id = str(page["id"])
        page_cell = _named_form(cells, _edif_identifier(page_id), "EDIF page cell")
        view = _named_form(_children(page_cell, "view"), "SCHEMATIC", f"schematic view for {page_id}")
        interfaces = _children(view, "interface")
        contents = _children(view, "contents")
        if len(interfaces) != 1 or len(contents) != 1:
            raise ValueError(f"EDIF page is incomplete: {page_id}")
        actual_ports = {
            str(port[1]): _child_value(port, "direction")
            for port in _children(interfaces[0], "port") if len(port) >= 2 and not isinstance(port[1], list)
        }
        expected_ports = {
            _edif_identifier(port["id"]): {"input": "INPUT", "output": "OUTPUT"}.get(port.get("direction"), "INOUT")
            for port in page["ports"]
        }
        if actual_ports != expected_ports:
            raise ValueError(f"EDIF page ports differ from EDA IR: {page_id}")

        instances = _children(contents[0], "instance")
        if len(instances) != len(page["components"]):
            raise ValueError(f"EDIF instance count differs from EDA IR: {page_id}")
        for component in page["components"]:
            component_id = str(component["id"])
            instance = _named_form(instances, _edif_identifier(component_id), f"instance in {page_id}")
            properties = _property_values(instance)
            if properties.get("ACTOVIQ_ID") != component_id or properties.get("ACTOVIQ_PAGE_ID") != page_id:
                raise ValueError(f"EDIF instance identity is not reversible: {page_id}:{component_id}")
            binding = binding_for(symbol_map, "orcad", page_id, component)
            view_ref = _children(instance, "viewRef")
            if len(view_ref) != 1:
                raise ValueError(f"EDIF instance has no symbol reference: {page_id}:{component_id}")
            cell_ref = _children(view_ref[0], "cellRef")
            if len(cell_ref) != 1:
                raise ValueError(f"EDIF instance has no cell reference: {page_id}:{component_id}")
            library_ref = _child_value(cell_ref[0], "libraryRef")
            actual_key = (str(library_ref), str(cell_ref[0][1]))
            expected_key = (_edif_identifier(binding["library"]), _edif_identifier(binding["cell"]))
            if actual_key != expected_key or actual_key not in symbols:
                raise ValueError(f"EDIF instance symbol mismatch: {page_id}:{component_id}")
            expected_pins = sorted(_edif_identifier(value) for value in binding["pin_map"].values())
            if symbols[actual_key]["ports"] != expected_pins:
                raise ValueError(f"EDIF symbol pin map mismatch: {page_id}:{component_id}")
            transforms = _children(instance, "transform")
            origins = _children(transforms[0], "origin") if len(transforms) == 1 else []
            points = _children(origins[0], "pt") if len(origins) == 1 else []
            position = component.get("position") or {}
            expected_point = [str(int(position.get("x", 0))), str(int(position.get("y", 0)))]
            if len(points) != 1 or [str(value) for value in points[0][1:3]] != expected_point:
                raise ValueError(f"EDIF instance coordinate mismatch: {page_id}:{component_id}")
            if _child_value(transforms[0], "orientation") != f"R{int(component.get('rotation', 0)) % 360}":
                raise ValueError(f"EDIF instance orientation mismatch: {page_id}:{component_id}")
            validated_instances.add((page_id, component_id))

        nets = _children(contents[0], "net")
        if len(nets) != len(page["nets"]):
            raise ValueError(f"EDIF net count differs from EDA IR: {page_id}")
        for net in page["nets"]:
            net_id = str(net["id"])
            edif_net = _named_form(nets, _edif_identifier(net_id), f"net in {page_id}")
            joined = _children(edif_net, "joined")
            if len(joined) != 1:
                raise ValueError(f"EDIF net is missing joined endpoints: {page_id}:{net_id}")
            actual_refs = sorted(_ref_tuple(entry) for entry in _children(joined[0], "portRef"))
            expected_refs: list[tuple[str, str]] = []
            for endpoint in net["endpoints"]:
                if endpoint.get("kind") == "pin":
                    component = next(item for item in page["components"] if item["id"] == endpoint["component_id"])
                    binding = binding_for(symbol_map, "orcad", page_id, component)
                    expected_refs.append((
                        _edif_identifier(binding["pin_map"][str(endpoint["pin_id"])]),
                        _edif_identifier(endpoint["component_id"]),
                    ))
                else:
                    expected_refs.append((_edif_identifier(endpoint["port_id"]), ""))
            if actual_refs != sorted(expected_refs):
                raise ValueError(f"EDIF net endpoints differ from EDA IR: {page_id}:{net_id}")
            expected_wires = [wire for wire in page["wires"] if wire.get("net_id") == net_id]
            encoded = ";".join(
                ",".join(f"{point['x']}:{point['y']}" for point in wire.get("points", []))
                for wire in expected_wires
            )
            if _property_values(edif_net).get("ACTOVIQ_WIRE_POINTS") != encoded:
                raise ValueError(f"EDIF wire coordinates differ from EDA IR: {page_id}:{net_id}")
            wire_segment_groups += len(expected_wires)
            validated_nets.add((page_id, net_id))

    top_name = _edif_identifier(str(ir["project"]["name"]) + "_TOP")
    top_cell = _named_form(cells, top_name, "EDIF top cell")
    top_view = _named_form(_children(top_cell, "view"), "SCHEMATIC", "EDIF top schematic")
    top_contents = _children(top_view, "contents")
    if len(top_contents) != 1:
        raise ValueError("EDIF top schematic has no contents")
    top_instances = _children(top_contents[0], "instance")
    expected_page_instances = {_edif_identifier("PAGE_" + page["id"]) for page in ir["pages"]}
    actual_page_instances = {str(entry[1]) for entry in top_instances if len(entry) >= 2 and not isinstance(entry[1], list)}
    if actual_page_instances != expected_page_instances:
        raise ValueError("EDIF top hierarchy does not contain every module")

    records_by_net: dict[str, list[dict[str, Any]]] = {}
    for record in ir["connectivity"]["records"]:
        if record.get("port_id"):
            records_by_net.setdefault(str(record["net"]), []).append(record)
    expected_top: dict[str, list[tuple[str, str]]] = {
        _edif_identifier(net): sorted(
            (_edif_identifier(record["port_id"]), _edif_identifier("PAGE_" + record["module_id"]))
            for record in records
        )
        for net, records in records_by_net.items() if len(records) >= 2
    }
    actual_top: dict[str, list[tuple[str, str]]] = {}
    for net in _children(top_contents[0], "net"):
        joined = _children(net, "joined")
        if len(net) < 2 or isinstance(net[1], list) or len(joined) != 1:
            raise ValueError("malformed EDIF top net")
        actual_top[str(net[1])] = sorted(_ref_tuple(entry) for entry in _children(joined[0], "portRef"))
    if actual_top != expected_top:
        raise ValueError("EDIF top-level connectivity differs from EDA IR")

    return {
        "schema": ORCAD_SCHEMA,
        "passed": True,
        "connectivity_hash": ir["connectivity"]["hash"],
        "symbols": len(symbols),
        "instances": len(validated_instances),
        "nets": len(validated_nets),
        "wire_paths": wire_segment_groups,
        "hierarchical_pages": len(actual_page_instances),
    }


def _expected_spice_lines(ir: dict[str, Any]) -> list[str]:
    global_net_by_endpoint = {
        (record.get("module_id"), record.get("component_id"), record.get("pin_id")): record["net"]
        for record in ir["connectivity"]["records"] if record.get("component_id")
    }
    result: list[str] = []
    names: set[str] = set()
    for page in ir["pages"]:
        for component in page["components"]:
            component_type = str(component.get("type", "X")).upper()
            prefix = "X" if component_type == "BLOCK" else component_type
            name = str((component.get("eda") or {}).get("refdes") or component.get("name", component["id"]))
            if not name.upper().startswith(prefix):
                name = prefix + name
            name = _safe_name(name)
            if name.casefold() in names:
                raise ValueError(f"duplicate flattened SPICE instance name: {name}")
            names.add(name.casefold())
            nets = [
                global_net_by_endpoint.get(
                    (page["id"], component["id"], pin["id"]),
                    f"{page['id']}:{pin.get('net', '')}",
                )
                for pin in component.get("pins", [])
            ]
            value = component.get("value", "GENERIC")
            if component_type == "BLOCK":
                value = _safe_name(value, "ACTOVIQ_BLOCK")
            result.append(" ".join([name, *(_safe_name(net, "0") for net in nets), str(value)]))
    return result


def _netlist_instances(path: Path) -> list[str]:
    return [
        line.strip() for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("*") and line.strip().casefold() != ".end"
    ]


def validate_virtuoso_package(
    package_root: str | os.PathLike[str],
    ir: dict[str, Any],
    symbol_map: dict[str, Any],
) -> dict[str, Any]:
    """Validate flattened netlists, device map, SKILL reconstruction, and fallback symbols."""
    root = Path(package_root)
    spice_files = list(root.glob("*.spice"))
    cdl_files = list(root.glob("*.cdl"))
    if len(spice_files) != 1 or len(cdl_files) != 1:
        raise ValueError("Virtuoso package must contain exactly one SPICE and one CDL file")
    expected_lines = _expected_spice_lines(ir)
    if _netlist_instances(spice_files[0]) != expected_lines or _netlist_instances(cdl_files[0]) != expected_lines:
        raise ValueError("Virtuoso SPICE/CDL instances or pin networks differ from EDA IR")

    map_path = root / "device-map.json"
    if not map_path.is_file():
        raise ValueError("Virtuoso device-map.json is missing")
    device_map = json.loads(map_path.read_text(encoding="utf-8"))
    components = device_map.get("components") if isinstance(device_map, dict) else None
    expected_keys = {f"{page['id']}:{component['id']}" for page in ir["pages"] for component in page["components"]}
    if not isinstance(components, dict) or set(components) != expected_keys:
        raise ValueError("Virtuoso device map does not contain every component exactly once")
    fallback_cells: dict[str, tuple[str, ...]] = {}
    expected_markers: dict[str, dict[str, Any]] = {}
    for page in ir["pages"]:
        for component in page["components"]:
            key = f"{page['id']}:{component['id']}"
            binding = binding_for(symbol_map, "virtuoso", page["id"], component)
            actual = components[key]
            for field in ("library", "cell", "view", "pin_map"):
                if actual.get(field) != binding.get(field):
                    raise ValueError(f"Virtuoso device mapping mismatch for {key}: {field}")
            fallback = actual.get("generic_fallback")
            if not isinstance(fallback, dict) or fallback.get("pin_map") != binding["pin_map"]:
                raise ValueError(f"Virtuoso generic fallback has an incomplete pin map: {key}")
            cell = str(fallback.get("cell", ""))
            pins = tuple(sorted(str(value) for value in fallback["pin_map"].values()))
            if not cell or (cell in fallback_cells and fallback_cells[cell] != pins):
                raise ValueError(f"Virtuoso generic fallback cell collision: {key}")
            fallback_cells[cell] = pins
            expected_markers[key] = {
                "page_id": str(page["id"]), "component_id": str(component["id"]),
                "refdes": str((component.get("eda") or {}).get("refdes", component["name"])),
                "library": str(binding["library"]), "cell": str(binding["cell"]),
                "view": str(binding.get("view", "symbol")),
                "pin_map": {str(source): str(target) for source, target in binding["pin_map"].items()},
                "generic_fallback": fallback,
            }

    skill_path = root / "create_schematic.il"
    if not skill_path.is_file():
        raise ValueError("Virtuoso reconstruction SKILL is missing")
    skill = skill_path.read_text(encoding="utf-8")
    required_helpers = ("procedure(actoviqEnsureGenericSymbol", "dbCreateTerm", "dbCreatePin", "dbCreateConnByName")
    if any(token not in skill for token in required_helpers):
        raise ValueError("Virtuoso reconstruction SKILL lacks generic symbol/connectivity helpers")
    markers: dict[str, dict[str, Any]] = {}
    marker_matches = list(re.finditer(r"^; ACTOVIQ_COMPONENT (\{.*\})$", skill, re.MULTILINE))
    for index, match in enumerate(marker_matches):
        marker = json.loads(match.group(1))
        key = f"{marker.get('page_id', '')}:{marker.get('component_id', '')}"
        if key in markers:
            raise ValueError(f"duplicate Virtuoso SKILL component marker: {key}")
        markers[key] = marker
        end = marker_matches[index + 1].start() if index + 1 < len(marker_matches) else len(skill)
        block = skill[match.end():end]
        fallback = marker.get("generic_fallback") or {}
        if str(fallback.get("cell", "")) not in block:
            raise ValueError(f"Virtuoso SKILL does not invoke the declared fallback: {key}")
        for target_pin in marker.get("pin_map", {}).values():
            if f'"{target_pin}"' not in block:
                raise ValueError(f"Virtuoso SKILL does not connect target pin {target_pin!r}: {key}")
    if markers != expected_markers:
        raise ValueError("Virtuoso SKILL component bindings differ from device-map.json/EDA IR")
    page_markers = re.findall(r"^; ACTOVIQ_PAGE (\{.*\})$", skill, re.MULTILINE)
    if len(page_markers) != len(ir["pages"]) or "; ACTOVIQ_TOP " not in skill:
        raise ValueError("Virtuoso SKILL does not reconstruct every module and the top hierarchy")
    expected_wire_count = sum(1 for page in ir["pages"] for wire in page["wires"] if wire.get("points"))
    if skill.count("schCreateWire(cv") != expected_wire_count:
        raise ValueError("Virtuoso SKILL wire path count differs from EDA IR")
    expected_port_count = sum(len(page["ports"]) for page in ir["pages"])
    if len(re.findall(r"dbCreateTerm\(net\d+ ", skill)) != expected_port_count:
        raise ValueError("Virtuoso SKILL module terminal count differs from EDA IR")
    if skill.count("pageMaster") < len(ir["pages"]) or skill.count("pageInst") < len(ir["pages"]):
        raise ValueError("Virtuoso SKILL top hierarchy is incomplete")
    connectivity_path = root / "connectivity.json"
    if not connectivity_path.is_file() or json.loads(connectivity_path.read_text(encoding="utf-8")) != ir["connectivity"]:
        raise ValueError("Virtuoso connectivity.json does not match the EDA IR")
    return {
        "schema": VIRTUOSO_SCHEMA,
        "passed": True,
        "connectivity_hash": ir["connectivity"]["hash"],
        "instances": len(expected_lines),
        "mapped_components": len(components),
        "generic_fallback_symbols": len(fallback_cells),
        "module_cells": len(ir["pages"]),
        "top_cell": True,
        "wire_paths": expected_wire_count,
    }
