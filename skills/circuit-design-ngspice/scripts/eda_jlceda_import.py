#!/usr/bin/env python3
"""Import EasyEDA / JLCEDA Std JSON peer edits back into Actoviq modules."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from eda_export import GRID, MM_PER_UNIT, connectivity_hash


def _component_key(component: dict[str, Any]) -> str:
    stable = str(component.get("stable_id", "")).strip()
    if stable:
        return stable
    return str(component.get("id", "")).strip()


def _find_jlceda_roots(peer_root: Path) -> list[Path]:
    roots: list[Path] = []
    sync = peer_root / "actoviq-sync" / "jlceda"
    if sync.is_dir():
        roots.append(sync)
    if peer_root.is_dir():
        roots.append(peer_root)
    return roots


def _load_easyeda_documents(peer_root: Path) -> list[dict[str, Any]]:
    documents: list[dict[str, Any]] = []
    seen: set[str] = set()
    for root in _find_jlceda_roots(peer_root):
        for path in sorted(root.glob("*.json")):
            key = str(path.resolve())
            if key in seen:
                continue
            seen.add(key)
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(payload, dict):
                documents.append({"path": path, "document": payload})
    return documents


def _easyeda_xy_to_internal(x_mm: float, y_mm: float) -> dict[str, float]:
    return {
        "x": round(float(x_mm) / MM_PER_UNIT / GRID) * GRID,
        "y": round(float(y_mm) / MM_PER_UNIT / GRID) * GRID,
    }


def _instances_from_metadata(document: dict[str, Any]) -> list[dict[str, Any]]:
    actoviq = document.get("actoviq") or {}
    pages = actoviq.get("pages") or []
    instances: list[dict[str, Any]] = []
    for page in pages:
        if not isinstance(page, dict):
            continue
        page_id = str(page.get("id", "")).strip()
        for component in page.get("components", []) or []:
            if not isinstance(component, dict):
                continue
            position = component.get("position") or {}
            instances.append(
                {
                    "page_id": page_id,
                    "stable_id": _component_key(component),
                    "component_id": str(component.get("id", "")).strip(),
                    "position": {"x": float(position.get("x", 0)), "y": float(position.get("y", 0))},
                    "rotation": int(component.get("rotation", 0)) % 360,
                    "value": str(component.get("value", "")),
                    "refdes": str((component.get("eda") or {}).get("refdes") or component.get("name", "")),
                    "source": "actoviq_metadata",
                }
            )
    return instances


def _instances_from_shapes(document: dict[str, Any]) -> list[dict[str, Any]]:
    instances: list[dict[str, Any]] = []
    shapes = document.get("shape") or []
    if not isinstance(shapes, list):
        return instances
    for shape in shapes:
        if not isinstance(shape, list) or len(shape) < 6:
            continue
        if shape[0] != "LIB":
            continue
        attrs = shape[8] if len(shape) > 8 and isinstance(shape[8], dict) else {}
        page_id = str(attrs.get("ACTOVIQ_PAGE_ID", "")).strip()
        actoviq_id = str(attrs.get("ACTOVIQ_ID", "")).strip()
        shape_id = str(shape[1]).strip()
        stable_id = actoviq_id
        if not stable_id:
            identity = f"{page_id}|{shape_id}|{shape[2]}"
            digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:20]
            stable_id = f"foreign-jlceda-{digest}"
        position = _easyeda_xy_to_internal(float(shape[3]), float(shape[4]))
        instances.append(
            {
                "page_id": page_id,
                "stable_id": stable_id,
                "component_id": stable_id,
                "position": position,
                "rotation": int(shape[5]) % 360,
                "value": str(attrs.get("Value", "")),
                "refdes": str(attrs.get("Reference", shape[2] if len(shape) > 2 else "")),
                "source": "easyeda_shape",
                "has_actoviq_id": bool(actoviq_id),
                "foreign_symbol": shape_id,
            }
        )
    return instances


def _merge_metadata_and_shapes(
    metadata_instances: list[dict[str, Any]],
    shape_instances: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Overlay editable EasyEDA shapes on the embedded Actoviq snapshot.

    The metadata block is a provenance/connectivity snapshot.  Geometry and
    editable properties in a matching LIB shape are the current peer state and
    therefore win when both representations are present.
    """
    merged = [dict(instance) for instance in metadata_instances]
    exact: dict[tuple[str, str], int] = {}
    by_stable_id: dict[str, list[int]] = {}
    for index, instance in enumerate(merged):
        page_id = str(instance.get("page_id", "")).strip()
        stable_id = str(instance.get("stable_id", "")).strip()
        if not stable_id:
            continue
        exact[(page_id, stable_id)] = index
        by_stable_id.setdefault(stable_id, []).append(index)

    for shape in shape_instances:
        page_id = str(shape.get("page_id", "")).strip()
        stable_id = str(shape.get("stable_id", "")).strip()
        target_index = exact.get((page_id, stable_id))
        if target_index is None and stable_id and len(by_stable_id.get(stable_id, [])) == 1:
            target_index = by_stable_id[stable_id][0]
        if target_index is None:
            merged.append(dict(shape))
            continue
        snapshot = merged[target_index]
        snapshot.update(
            {
                "position": dict(shape["position"]),
                "rotation": int(shape.get("rotation", 0)) % 360,
                "value": str(shape.get("value", "")),
                "refdes": str(shape.get("refdes", "")),
                "source": "easyeda_shape",
                "has_actoviq_id": bool(shape.get("has_actoviq_id")),
                "foreign_symbol": str(shape.get("foreign_symbol", "")),
            }
        )
    return merged


def _index_modules(modules: dict[str, dict[str, Any]]) -> dict[tuple[str, str], dict[str, Any]]:
    index: dict[tuple[str, str], dict[str, Any]] = {}
    for module_id, module in modules.items():
        for component in module.get("components", []) or []:
            if not isinstance(component, dict):
                continue
            for key in {str(component.get("id", "")).strip(), _component_key(component)}:
                if key:
                    index[(module_id, key)] = component
    return index


def _foreign_block_from_shape(shape: list[Any]) -> dict[str, Any]:
    refdes = (str(shape[2]).strip() if len(shape) > 2 else "") or "U?"
    return {
        "id": str(shape[1]),
        "type": "BLOCK",
        "name": refdes,
        "value": refdes,
        "position": _easyeda_xy_to_internal(float(shape[3]), float(shape[4])),
        "rotation": int(shape[5]) % 360 if len(shape) > 5 else 0,
        "pins": [{"id": "1", "name": "1", "net": "NC", "side": "left"}],
        "eda": {"foreign_symbol": str(shape[1]), "refdes": refdes, "physical": True},
    }


def import_jlceda_peer(
    peer_root: Path,
    modules: dict[str, dict[str, Any]],
    *,
    project: dict[str, Any] | None = None,
    policy: str | None = None,
) -> dict[str, Any]:
    peer_root = Path(peer_root).expanduser().resolve()
    if not peer_root.is_dir():
        raise ValueError(f"JLCEDA peer root does not exist: {peer_root}")

    documents = _load_easyeda_documents(peer_root)
    if not documents:
        raise ValueError(f"no EasyEDA JSON documents found under {peer_root}")

    instances: list[dict[str, Any]] = []
    warnings: list[str] = []
    for entry in documents:
        document = entry["document"]
        metadata_instances = _instances_from_metadata(document)
        shape_instances = _instances_from_shapes(document)
        if metadata_instances:
            instances.extend(_merge_metadata_and_shapes(metadata_instances, shape_instances))
        else:
            instances.extend(shape_instances)
        if not metadata_instances and not shape_instances:
            warnings.append(f"no importable LIB shapes in {entry['path'].name}")

    updated_modules: dict[str, dict[str, Any]] = {}
    id_map: dict[str, dict[str, Any]] = {}
    applied: list[str] = []
    index = _index_modules(modules)
    default_page_id = next(iter(modules)) if len(modules) == 1 else ""

    for instance in instances:
        page_id = str(instance.get("page_id", "")).strip() or default_page_id
        if (
            page_id not in modules
            and default_page_id
            and not (modules[default_page_id].get("components") or [])
        ):
            # A cold-start project contains one intentionally empty import sheet.
            # Preserve peer identity on the components while materializing the
            # foreign page safely on that sheet.
            page_id = default_page_id
        stable_id = str(instance.get("stable_id", "")).strip()
        module = modules.get(page_id)
        if module is None:
            continue
        component = index.get((page_id, stable_id))
        clone = updated_modules.setdefault(page_id, json.loads(json.dumps(module)))
        if component is None:
            if policy != "connectivity_wins":
                foreign = _foreign_block_from_shape(
                    ["LIB", stable_id or f"foreign_{len(applied)}", instance.get("refdes", "U?"), instance["position"]["x"] * MM_PER_UNIT, instance["position"]["y"] * MM_PER_UNIT, instance.get("rotation", 0)]
                )
                foreign["id"] = stable_id or foreign["id"]
                foreign["stable_id"] = stable_id or foreign["id"]
                foreign["position"] = instance["position"]
                foreign["rotation"] = instance.get("rotation", 0)
                foreign["eda"]["foreign_symbol"] = str(
                    instance.get("foreign_symbol") or foreign["eda"].get("foreign_symbol", "")
                )
                if instance.get("value"):
                    foreign["value"] = instance["value"]
                clone.setdefault("components", []).append(foreign)
                applied.append(f"{page_id}:{foreign['id']}:foreign")
            continue
        target = None
        for entry in clone.get("components", []) or []:
            if isinstance(entry, dict) and _component_key(entry) == _component_key(component):
                target = entry
                break
        if target is None:
            continue
        target["position"] = instance["position"]
        target["rotation"] = instance.get("rotation", 0)
        if instance.get("value"):
            target["value"] = instance["value"]
        eda = dict(target.get("eda") or {})
        if instance.get("refdes"):
            eda["refdes"] = instance["refdes"]
        target["eda"] = eda
        key = _component_key(component)
        id_map[key] = {"peer_kind": "jlceda", "page_id": page_id, "refdes": instance.get("refdes", "")}
        applied.append(f"{page_id}:{key}")

    conflicts: list[dict[str, Any]] = []
    connectivity_before = connectivity_hash(project, modules) if project else ""
    connectivity_after = connectivity_hash(project, updated_modules or modules) if project else connectivity_before
    effective_policy = policy or "manual_review"
    blocked = effective_policy == "connectivity_wins" and conflicts
    ok = not blocked and bool(applied)

    return {
        "ok": ok,
        "conflicts": conflicts,
        "updated_modules": {} if blocked else updated_modules,
        "id_map": id_map,
        "connectivity_hash_before": connectivity_before,
        "connectivity_hash_after": connectivity_after,
        "applied": applied,
        "warnings": warnings,
        "peer_instance_count": len(instances),
    }
