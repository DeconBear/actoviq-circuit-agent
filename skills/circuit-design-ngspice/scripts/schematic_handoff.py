#!/usr/bin/env python3
"""Simple schematic import/export handoff for desktop Import / Export buttons."""

from __future__ import annotations

import hashlib
import json
import re
import tempfile
from pathlib import Path
from typing import Any

from eda_export import export_eda
from eda_jlceda_export import write_jlceda_package
from project_kinds import normalize_project_kind
from xschem_bridge import parse_xschem, render_xschem

PCB_FORMATS = ("kicad", "jlceda", "altium", "allegro")
IC_FORMATS = ("virtuoso", "xschem")
ALL_FORMATS = PCB_FORMATS + IC_FORMATS

EXPORT_EDA_ALIASES = {
    "kicad": "kicad",
    "altium": "altium",
    "allegro": "orcad",
    "virtuoso": "virtuoso",
}


def formats_for_kind(project_kind: str) -> tuple[str, ...]:
    kind = normalize_project_kind(project_kind)
    if kind == "pcb_schematic":
        return PCB_FORMATS
    if kind in {"analog_ic", "mixed_signal_ic"}:
        return IC_FORMATS
    return ()


def assert_format_allowed(project_kind: str, fmt: str) -> str:
    text = str(fmt or "").strip().casefold()
    allowed = formats_for_kind(project_kind)
    if text not in allowed:
        raise ValueError(
            f"format {fmt!r} is not available for project_kind={project_kind} "
            f"(allowed: {', '.join(allowed) or 'none'})"
        )
    return text


def _atomic_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False
    ) as handle:
        handle.write(content)
        temporary = Path(handle.name)
    temporary.replace(path)


def _atomic_json(path: Path, value: Any) -> None:
    _atomic_text(path, json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n")


def _module_path(root: Path, module_id: str) -> Path:
    return root / "modules" / module_id / "module.circuit.json"


def _ensure_module(modules: dict[str, dict[str, Any]], module_id: str) -> dict[str, Any]:
    module = modules.get(module_id)
    if module is None:
        raise ValueError(f"unknown module: {module_id}")
    return module


def export_schematic(
    root: Path,
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    erc: dict[str, Any],
    document_hash: str,
    *,
    fmt: str,
    output_path: str,
    module_id: str | None = None,
    source_revision: int | None = None,
) -> dict[str, Any]:
    kind = normalize_project_kind(project.get("project_kind"))
    fmt = assert_format_allowed(kind, fmt)
    target = Path(output_path).expanduser().resolve()
    if source_revision is not None and int(source_revision) != int(project["revision"]):
        raise ValueError(f"stale source revision: requested {source_revision}, current {project['revision']}")

    if fmt == "xschem":
        if not module_id:
            raise ValueError("xschem export requires a module id")
        module = _ensure_module(modules, module_id)
        if target.suffix.casefold() != ".sch":
            target = target / f"{module_id}.sch"
        content, _identity = render_xschem(module)
        _atomic_text(target, content)
        return {
            "ok": True,
            "format": fmt,
            "output_path": str(target),
            "files": [str(target)],
            "module_id": module_id,
        }

    if fmt == "jlceda":
        from eda_export import build_eda_ir, connectivity_hash

        target.mkdir(parents=True, exist_ok=True)
        ir, _quality = build_eda_ir(
            project,
            modules,
            scope="module" if module_id else "project",
            module_id=module_id,
            view="design",
            document_hash=document_hash,
        )
        if ir["connectivity"]["hash"] != connectivity_hash(
            project, modules, module_id, "design"
        ):
            raise ValueError("connectivity hash changed during layout projection")
        package = write_jlceda_package(ir, target)
        return {
            "ok": True,
            "format": fmt,
            "output_path": package.get("package_root") or str(target),
            "files": package.get("files") or [],
            "module_id": module_id,
        }

    eda_target = EXPORT_EDA_ALIASES[fmt]
    output_dir = str(target if target.is_dir() or not target.suffix else target.parent)
    target.mkdir(parents=True, exist_ok=True) if not target.suffix else target.parent.mkdir(parents=True, exist_ok=True)
    result = export_eda(
        root,
        project,
        modules,
        erc,
        document_hash,
        scope="module" if module_id else "project",
        module_id=module_id,
        targets=[eda_target],
        view="design",
        mapping_file="",
        native_convert="never",
        strict_layout=False,
        source_revision=source_revision,
        output_dir=output_dir,
    )
    return {
        "ok": True,
        "format": fmt,
        "export_target": eda_target,
        "output_path": result["export_root"],
        "export_id": result["export_id"],
        "files": result.get("targets", {}).get(eda_target, {}).get("files", []),
        "module_id": module_id,
        "eda_export": result,
    }


COMPONENT_RE = re.compile(
    r'^C\s+(\S+)\s+([-\d.]+)\s+([-\d.]+)\s+(\d+)\s+(\d+)\s+\{(.*)\}\s*$'
)
WIRE_RE = re.compile(
    r'^N\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+\{(.*)\}\s*$'
)
SPICE_INSTANCE_RE = re.compile(
    r"^([RCQLMDVXIU]\S*)\s+(\S+(?:\s+\S+){1,12})",
    re.IGNORECASE,
)


def _props(source: str) -> dict[str, str]:
    import shlex

    try:
        tokens = shlex.split(source, posix=True)
    except ValueError:
        tokens = source.split()
    result: dict[str, str] = {}
    for token in tokens:
        if "=" not in token:
            continue
        key, value = token.split("=", 1)
        result[key] = value.strip('"')
    return result


def _foreign_stable_id(prefix: str, digest_source: str) -> str:
    digest = hashlib.sha256(digest_source.encode("utf-8")).hexdigest()[:20]
    return f"foreign-{prefix}-{digest}"


def _append_block(
    module: dict[str, Any],
    *,
    stable_id: str,
    name: str,
    value: str,
    position: dict[str, float],
    rotation: int = 0,
    foreign_symbol: str = "",
    pins: list[dict[str, Any]] | None = None,
) -> str:
    known = {
        str(component.get("stable_id") or "")
        for component in module.get("components", [])
        if isinstance(component, dict)
    }
    if stable_id in known:
        return ""
    component_id = f"imp_{len(module.get('components', [])) + 1}"
    component = {
        "id": component_id,
        "stable_id": stable_id,
        "type": "BLOCK",
        "name": name or component_id,
        "value": value or "imported",
        "position": position,
        "rotation": int(rotation) % 360,
        "pins": pins or [{"id": "1", "name": "1", "net": "NC", "side": "left"}],
        "block": {"width": 120, "height": 80},
        "eda": {
            "foreign_symbol": foreign_symbol,
            "refdes": name or "",
            "physical": True,
        },
    }
    module.setdefault("components", []).append(component)
    return component_id


def import_xschem_into_module(module: dict[str, Any], peer_file: Path) -> dict[str, Any]:
    peer = peer_file.expanduser().resolve()
    if not peer.is_file() or peer.suffix.casefold() != ".sch":
        raise ValueError(f"Xschem import requires a .sch file: {peer}")
    created = 0
    # Prefer ID-bearing parse when present; also accept unnamed foreign components.
    parsed = parse_xschem(peer)
    for stable_id, item in parsed.get("components", {}).items():
        if _append_block(
            module,
            stable_id=stable_id,
            name=str(item.get("name") or stable_id),
            value=str(item.get("value") or ""),
            position={"x": float(item["x"]), "y": float(item["y"])},
            rotation=int(item.get("rotation", 0)),
            foreign_symbol=str(item.get("symbol") or ""),
        ):
            created += 1
    for wire_id, points in (parsed.get("wires") or {}).items():
        existing = {str(wire.get("id")) for wire in module.get("wires", []) if wire.get("id")}
        if wire_id in existing or len(points) < 2:
            continue
        module.setdefault("wires", []).append({
            "id": wire_id,
            "net": "imported",
            "net_id": "imported",
            "points": points,
        })
    if created == 0:
        for raw in peer.read_text(encoding="utf-8", errors="replace").splitlines():
            match = COMPONENT_RE.match(raw)
            if not match:
                continue
            props = _props(match.group(6))
            if props.get("ACTOVIQ_ID"):
                continue
            name = props.get("name") or match.group(1)
            stable_id = _foreign_stable_id("xschem", f"{peer.name}|{name}|{match.group(2)}|{match.group(3)}")
            if _append_block(
                module,
                stable_id=stable_id,
                name=name,
                value=props.get("value") or "",
                position={"x": float(match.group(2)), "y": float(match.group(3))},
                rotation=(int(match.group(4)) % 4) * 90,
                foreign_symbol=match.group(1),
            ):
                created += 1
    return {"created": created, "source": str(peer), "fidelity": "geometry_blocks"}


def import_kicad_into_module(module: dict[str, Any], source: Path) -> dict[str, Any]:
    from eda_kicad_import import parse_kicad_schematic

    path = source.expanduser().resolve()
    schematics: list[Path]
    if path.is_dir():
        schematics = sorted(path.glob("*.kicad_sch"))
        schematics = [item for item in schematics if not item.name.endswith("-root.kicad_sch")]
    elif path.suffix.casefold() == ".kicad_sch":
        schematics = [path]
    else:
        raise ValueError("KiCad import requires a .kicad_sch file or project folder")
    if not schematics:
        raise ValueError(f"no KiCad schematic found under {path}")
    created = 0
    for schematic in schematics:
        for instance in parse_kicad_schematic(schematic):
            if _append_block(
                module,
                stable_id=str(instance["stable_id"]),
                name=str(instance.get("refdes") or instance["stable_id"]),
                value=str(instance.get("value") or instance.get("lib_id") or ""),
                position={
                    "x": float(instance["x_mm"]) * 10.0,
                    "y": float(instance["y_mm"]) * 10.0,
                },
                rotation=(-int(instance.get("rotation_kicad", 0))) % 360,
                foreign_symbol=str(instance.get("lib_id") or ""),
            ):
                created += 1
    return {
        "created": created,
        "source": str(path),
        "files": [str(item) for item in schematics],
        "fidelity": "geometry_blocks",
    }


def import_jlceda_into_module(module: dict[str, Any], source: Path) -> dict[str, Any]:
    path = source.expanduser().resolve()
    candidates: list[Path]
    if path.is_file() and path.suffix.casefold() == ".json":
        candidates = [path]
    elif path.is_dir():
        candidates = sorted(path.rglob("*.json"))
    else:
        raise ValueError("嘉立创 import requires a JSON exchange file or folder")
    created = 0
    used: list[str] = []
    for candidate in candidates:
        try:
            payload = json.loads(candidate.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        shapes = payload.get("shape") or payload.get("shapes") or []
        if not isinstance(shapes, list):
            continue
        used.append(str(candidate))
        for index, shape in enumerate(shapes):
            if not isinstance(shape, (list, dict)):
                continue
            attrs = {}
            if isinstance(shape, dict):
                attrs = shape.get("attrs") or shape.get("attributes") or {}
                x = float(shape.get("x") or 0)
                y = float(shape.get("y") or 0)
                refdes = str(attrs.get("Reference") or shape.get("refdes") or f"U{index + 1}")
                value = str(attrs.get("Value") or shape.get("value") or "")
                stable = str(attrs.get("ACTOVIQ_ID") or "").strip() or _foreign_stable_id(
                    "jlceda", f"{candidate.name}|{refdes}|{x}|{y}"
                )
            else:
                continue
            if _append_block(
                module,
                stable_id=stable,
                name=refdes,
                value=value,
                position={"x": x * 10.0, "y": y * 10.0},
                foreign_symbol=str(attrs.get("symbol") or "jlceda"),
            ):
                created += 1
    if not used:
        raise ValueError(f"no 嘉立创 schematic JSON found under {path}")
    return {"created": created, "source": str(path), "files": used, "fidelity": "geometry_blocks"}


def import_virtuoso_netlist_into_module(module: dict[str, Any], source: Path) -> dict[str, Any]:
    path = source.expanduser().resolve()
    if not path.is_file():
        raise ValueError("Virtuoso import accepts a SPICE/CDL netlist file")
    created = 0
    y = 100.0
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        text = line.strip()
        if not text or text.startswith("*") or text.startswith("."):
            continue
        match = SPICE_INSTANCE_RE.match(text)
        if not match:
            continue
        name = match.group(1)
        rest = match.group(2).split()
        value = rest[-1] if rest else ""
        stable = _foreign_stable_id("virtuoso", f"{path.name}|{name}|{text}")
        if _append_block(
            module,
            stable_id=stable,
            name=name,
            value=value,
            position={"x": 120.0, "y": y},
            foreign_symbol="spice",
            pins=[{"id": "1", "name": "1", "net": "NC", "side": "left"}],
        ):
            created += 1
            y += 80.0
    return {
        "created": created,
        "source": str(path),
        "fidelity": "netlist_blocks",
        "note": "Imported device instances as blocks; pin connectivity is not reconstructed.",
    }


def import_schematic(
    root: Path,
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    *,
    fmt: str,
    source_path: str,
    module_id: str,
    persist: bool = True,
) -> dict[str, Any]:
    kind = normalize_project_kind(project.get("project_kind"))
    fmt = assert_format_allowed(kind, fmt)
    if fmt in {"altium", "allegro"}:
        raise ValueError(
            f"{fmt} direct schematic import is not available yet; "
            "export/import through KiCad (.kicad_sch) for PCB handoff"
        )
    module = json.loads(json.dumps(_ensure_module(modules, module_id)))
    source = Path(source_path)
    if fmt == "xschem":
        detail = import_xschem_into_module(module, source)
    elif fmt == "kicad":
        detail = import_kicad_into_module(module, source)
    elif fmt == "jlceda":
        detail = import_jlceda_into_module(module, source)
    elif fmt == "virtuoso":
        detail = import_virtuoso_netlist_into_module(module, source)
    else:
        raise ValueError(f"unsupported import format: {fmt}")
    if int(detail.get("created") or 0) <= 0:
        raise ValueError(f"no importable components found in {source}")
    modules[module_id] = module
    if persist:
        _atomic_json(_module_path(root, module_id), module)
    return {
        "ok": True,
        "format": fmt,
        "module_id": module_id,
        "project_id": project["project_id"],
        "module": module,
        **detail,
    }
