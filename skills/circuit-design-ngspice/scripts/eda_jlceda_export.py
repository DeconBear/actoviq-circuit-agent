#!/usr/bin/env python3
"""Export Actoviq EDA IR to EasyEDA / JLCEDA Std JSON packages."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from eda_export import GRID, MM_PER_UNIT


EASYEDA_SCHEMA = "actoviq.easyeda-std.v1"
PACKAGE_DIRNAME = "jlceda"


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _component_key(component: dict[str, Any]) -> str:
    stable = str(component.get("stable_id", "")).strip()
    if stable:
        return stable
    return str(component.get("id", "")).strip()


def _shape_id(page_id: str, component: dict[str, Any]) -> str:
    return f"comp_{page_id}_{_component_key(component)}"


def _to_easyeda_xy(point: dict[str, Any]) -> tuple[float, float]:
    return round(float(point.get("x", 0)) * MM_PER_UNIT, 4), round(float(point.get("y", 0)) * MM_PER_UNIT, 4)


def _component_shape(page_id: str, component: dict[str, Any]) -> list[Any]:
    x, y = _to_easyeda_xy(component.get("position") or {})
    rotation = int(component.get("rotation", 0)) % 360
    eda = component.get("eda") or {}
    refdes = str(eda.get("refdes") or component.get("name") or component.get("id", ""))
    value = str(component.get("value", ""))
    shape_id = _shape_id(page_id, component)
    attrs = {
        "ACTOVIQ_ID": _component_key(component),
        "ACTOVIQ_PAGE_ID": page_id,
        "Reference": refdes,
        "Value": value,
    }
    if eda.get("lcsc_id"):
        attrs["LCSC"] = str(eda["lcsc_id"])
    return [
        "LIB",
        shape_id,
        refdes,
        x,
        y,
        rotation,
        0,
        {},
        attrs,
        [],
    ]


def build_easyeda_document(ir: dict[str, Any]) -> dict[str, Any]:
    shapes: list[Any] = []
    for page in ir.get("pages", []) or []:
        page_id = str(page.get("id", ""))
        for component in page.get("components", []) or []:
            if isinstance(component, dict):
                shapes.append(_component_shape(page_id, component))
        for wire in page.get("wires", []) or []:
            points = wire.get("points") or []
            if len(points) < 2:
                continue
            start = _to_easyeda_xy(points[0])
            end = _to_easyeda_xy(points[-1])
            shapes.append(["WIRE", f"wire_{page_id}_{wire.get('id', len(shapes))}", *start, *end, 0, 0, 0, {}])
    width = 4000
    height = 3000
    if shapes:
        xs = [shape[3] for shape in shapes if isinstance(shape, list) and len(shape) > 4 and isinstance(shape[3], (int, float))]
        ys = [shape[4] for shape in shapes if isinstance(shape, list) and len(shape) > 5 and isinstance(shape[4], (int, float))]
        if xs and ys:
            width = max(width, int(math.ceil(max(xs) + 200)))
            height = max(height, int(math.ceil(max(ys) + 200)))
    return {
        "head": {
            "docType": "3",
            "editorVersion": "6.5.40",
            "title": ir.get("project", {}).get("name", ir.get("source", {}).get("project_id", "Actoviq")),
            "description": "Actoviq EDA bridge export",
        },
        "canvas": f"CA{int(ir.get('source', {}).get('revision', 0)):04d}",
        "shape": shapes,
        "actoviq": {
            "schema": EASYEDA_SCHEMA,
            "ir_schema": ir.get("schema", "actoviq.eda-ir.v1"),
            "document_hash": ir.get("source", {}).get("document_hash", ""),
            "connectivity_hash": ir.get("connectivity", {}).get("hash", ""),
            "coordinate_system": ir.get("coordinate_system", {"unit": "actoviq", "grid": GRID, "mm_per_unit": MM_PER_UNIT}),
            "pages": ir.get("pages", []),
            "connectivity": ir.get("connectivity", {}),
        },
    }


def write_jlceda_package(ir: dict[str, Any], peer_root: Path) -> dict[str, Any]:
    peer_root = Path(peer_root).expanduser().resolve()
    package_root = peer_root / "actoviq-sync" / PACKAGE_DIRNAME
    package_root.mkdir(parents=True, exist_ok=True)
    document = build_easyeda_document(ir)
    primary = package_root / "schematic.easyeda.json"
    _write_json(primary, document)
    _write_json(package_root / "actoviq-ir.snapshot.json", ir)
    readme = package_root / "README.md"
    readme.write_text(
        "# Actoviq JLCEDA / EasyEDA bridge package\n\n"
        "`schematic.easyeda.json` is an experimental Actoviq exchange document. "
        "It supports deterministic Actoviq-side round-trip through the embedded `actoviq` metadata, "
        "but has not been validated by an EasyEDA/JLCEDA vendor importer.\n",
        encoding="utf-8",
    )
    return {
        "ok": True,
        "package_root": str(package_root),
        "files": [str(primary.relative_to(peer_root)).replace("\\", "/")],
        "component_count": sum(len(page.get("components", []) or []) for page in ir.get("pages", []) or []),
    }
