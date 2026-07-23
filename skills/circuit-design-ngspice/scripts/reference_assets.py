#!/usr/bin/env python3
"""Workspace reference-asset catalog: circuit + schematic layout imports."""

from __future__ import annotations

import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from workspace_paths import get_active_workspace

ASSET_SCHEMA = "actoviq.reference-asset.v1"
LAYOUT_REF_SCHEMA = "actoviq.schematic-layout-reference.v1"
IDIOM_SCHEMA = "actoviq.layout-idiom.v1"

BUILTIN_IDIOMS_DIR = Path(__file__).resolve().parents[1] / "assets" / "layout-idioms"


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _slugify(value: str) -> str:
    text = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip()).strip("-_.")
    return (text or "asset")[:80]


def catalog_root(references_dir: Path | None = None) -> Path:
    if references_dir is None:
        override = __import__("os").environ.get("ACTOVIQ_REFERENCES_DIR", "").strip()
        if override:
            references_dir = Path(override)
        else:
            references_dir = Path(get_active_workspace()["referencesDir"])
    root = Path(references_dir) / "catalog"
    root.mkdir(parents=True, exist_ok=True)
    return root


def asset_dir(asset_id: str, references_dir: Path | None = None) -> Path:
    return catalog_root(references_dir) / asset_id


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def list_catalog(references_dir: Path | None = None) -> dict[str, Any]:
    root = catalog_root(references_dir)
    ensure_builtin_idioms(references_dir)
    assets: list[dict[str, Any]] = []
    for entry in sorted(root.iterdir() if root.exists() else []):
        if not entry.is_dir():
            continue
        manifest_path = entry / "asset.json"
        if not manifest_path.exists():
            continue
        try:
            asset = read_json(manifest_path)
        except (OSError, json.JSONDecodeError):
            continue
        if asset.get("schema") != ASSET_SCHEMA:
            continue
        assets.append(
            {
                **asset,
                "root_path": str(entry.resolve()),
                "relative_path": f"catalog/{entry.name}",
            }
        )
    assets.sort(
        key=lambda item: (
            0 if item.get("preferred_for_agent_reuse") else 1,
            str(item.get("kind", "")),
            str(item.get("id", "")),
        )
    )
    return {"ok": True, "schema": "actoviq.reference-catalog.v1", "assets": assets, "count": len(assets)}


def load_asset(asset_id: str, references_dir: Path | None = None) -> dict[str, Any]:
    path = asset_dir(asset_id, references_dir) / "asset.json"
    if not path.exists():
        raise ValueError(f"unknown reference asset: {asset_id}")
    asset = read_json(path)
    if asset.get("schema") != ASSET_SCHEMA:
        raise ValueError(f"invalid reference asset schema: {asset_id}")
    asset["root_path"] = str(path.parent.resolve())
    return asset


def _new_asset_id(prefix: str, references_dir: Path | None = None) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    base = f"{_slugify(prefix)}-{stamp}"
    candidate = base
    index = 1
    while asset_dir(candidate, references_dir).exists():
        index += 1
        candidate = f"{base}-{index}"
    return candidate


def write_asset(
    *,
    asset_id: str,
    kind: str,
    name: str,
    trust: str,
    use_as: list[str],
    payload_files: dict[str, str | None],
    binds_to: dict[str, Any] | None = None,
    provenance: dict[str, Any] | None = None,
    preferred_for_agent_reuse: bool = False,
    model_hints: list[str] | None = None,
    children: list[str] | None = None,
    license_text: str | None = None,
    references_dir: Path | None = None,
) -> dict[str, Any]:
    root = asset_dir(asset_id, references_dir)
    payload_root = root / "payload"
    payload_root.mkdir(parents=True, exist_ok=True)
    asset: dict[str, Any] = {
        "schema": ASSET_SCHEMA,
        "id": asset_id,
        "kind": kind,
        "name": name,
        "trust": trust,
        "use_as": use_as,
        "preferred_for_agent_reuse": preferred_for_agent_reuse,
        "binds_to": binds_to or {},
        "provenance": {
            "created_at": _utc_now(),
            **(provenance or {}),
        },
        "payload": {
            "root": "payload",
            "files": payload_files,
        },
    }
    if model_hints:
        asset["model_hints"] = model_hints
    if children:
        asset["children"] = children
    if license_text:
        asset["license"] = license_text
    write_json(root / "asset.json", asset)
    return {**asset, "root_path": str(root.resolve())}


def build_layout_reference(
    module_id: str,
    module: dict[str, Any],
    *,
    connectivity_hash_value: str,
    readability_score: float | None = None,
    preview: str | None = None,
) -> dict[str, Any]:
    placements: list[dict[str, Any]] = []
    for component in module.get("components", []) or []:
        if not isinstance(component, dict):
            continue
        component_id = str(component.get("id", "")).strip()
        if not component_id:
            continue
        position = component.get("position") if isinstance(component.get("position"), dict) else {}
        placements.append(
            {
                "component_id": component_id,
                "x": float(position.get("x", component.get("x", 0)) or 0),
                "y": float(position.get("y", component.get("y", 0)) or 0),
                "rotation": int(component.get("rotation", 0) or 0) % 360,
            }
        )
    port_placements: list[dict[str, Any]] = []
    for port in module.get("ports", []) or []:
        if not isinstance(port, dict):
            continue
        port_id = str(port.get("id", "")).strip()
        position = port.get("position") if isinstance(port.get("position"), dict) else None
        if not port_id or not isinstance(position, dict):
            continue
        port_placements.append(
            {
                "port_id": port_id,
                "x": float(position.get("x", 0) or 0),
                "y": float(position.get("y", 0) or 0),
            }
        )
    payload: dict[str, Any] = {
        "schema": LAYOUT_REF_SCHEMA,
        "module_id": module_id,
        "connectivity_hash": connectivity_hash_value.lower(),
        "view": "design",
        "placements": placements,
        "port_placements": port_placements,
    }
    if readability_score is not None:
        payload["readability_score"] = readability_score
    if preview:
        payload["preview"] = preview
    return payload


def extract_model_hints(spice_text: str) -> list[str]:
    hints: list[str] = []
    for line in spice_text.splitlines():
        stripped = line.strip()
        lowered = stripped.lower()
        if lowered.startswith(".lib ") or lowered.startswith(".include "):
            hints.append(stripped)
    return hints


def flatten_spice_for_module(spice_text: str, *, subckt_name: str | None = None) -> dict[str, Any]:
    """Flatten a SPICE file into a single-module notebook body (no X hierarchy)."""
    text = spice_text.replace("\r\n", "\n")
    subckt_re = re.compile(r"(?im)^\s*\.subckt\s+(\S+)(.*)$")
    ends_re = re.compile(r"(?im)^\s*\.ends\b")
    matches = list(subckt_re.finditer(text))
    model_hints = extract_model_hints(text)

    if not matches:
        body_lines = [
            line
            for line in text.splitlines()
            if line.strip() and not line.strip().lower().startswith(".title")
        ]
        if body_lines and body_lines[-1].strip().lower() == ".end":
            body_lines = body_lines[:-1]
        return {
            "spice": "\n".join(body_lines).strip() + "\n",
            "subckt_name": None,
            "candidates": [],
            "model_hints": model_hints,
        }

    candidates = [match.group(1) for match in matches]
    chosen = subckt_name
    if chosen is None:
        if len(candidates) != 1:
            raise ValueError(
                "multiple .subckt definitions found; pass --subckt-name. "
                f"candidates={candidates}"
            )
        chosen = candidates[0]
    if chosen not in candidates:
        raise ValueError(f"subckt not found: {chosen}; candidates={candidates}")

    start = None
    ports: list[str] = []
    for match in matches:
        if match.group(1) == chosen:
            start = match.end()
            ports = [token for token in match.group(2).split() if token]
            break
    assert start is not None
    rest = text[start:]
    end_match = ends_re.search(rest)
    body = rest[: end_match.start()] if end_match else rest
    # Keep top-level .model / .lib lines outside the subckt as well.
    preamble_lines: list[str] = []
    for line in text[: matches[0].start()].splitlines():
        lowered = line.strip().lower()
        if lowered.startswith(".model") or lowered.startswith(".lib") or lowered.startswith(".include"):
            preamble_lines.append(line.rstrip())
    spice_body = "\n".join([*preamble_lines, body.strip()]).strip() + "\n"
    return {
        "spice": spice_body,
        "subckt_name": chosen,
        "ports": ports,
        "candidates": candidates,
        "model_hints": model_hints,
    }


def spice_to_notebook(spice: str, title: str, body: str = "") -> str:
    prose = f"# {title}\n\n{body}\n\n" if body else f"# {title}\n\n"
    return prose + "```spice\n" + spice.strip() + "\n```\n"


def import_circuit_reference(
    source_file: Path,
    *,
    as_kind: str = "circuit_module",
    name: str | None = None,
    subckt_name: str | None = None,
    references_dir: Path | None = None,
) -> dict[str, Any]:
    if as_kind not in {"circuit_module", "circuit_project"}:
        raise ValueError("as_kind must be circuit_module or circuit_project")
    source_file = Path(source_file).resolve()
    if not source_file.exists():
        raise ValueError(f"circuit file not found: {source_file}")
    raw = source_file.read_text(encoding="utf-8", errors="replace")
    flattened = flatten_spice_for_module(raw, subckt_name=subckt_name)
    asset_id = _new_asset_id(name or source_file.stem, references_dir)
    root = asset_dir(asset_id, references_dir)
    payload = root / "payload"
    payload.mkdir(parents=True, exist_ok=True)
    (payload / "source.cir").write_text(raw, encoding="utf-8")
    (payload / "module.cir").write_text(flattened["spice"], encoding="utf-8")
    notebook = spice_to_notebook(
        flattened["spice"],
        name or source_file.stem,
        "Imported circuit reference (flattened; no X/.subckt hierarchy).",
    )
    (payload / "netlist-notebook.md").write_text(notebook, encoding="utf-8")
    meta = {
        "subckt_name": flattened.get("subckt_name"),
        "ports": flattened.get("ports") or [],
        "source_file": source_file.name,
    }
    write_json(payload / "import-meta.json", meta)
    use_as = ["seed_new_project", "insert_module", "agent_context_only"]
    asset = write_asset(
        asset_id=asset_id,
        kind=as_kind,
        name=name or source_file.stem,
        trust="user_upload",
        use_as=use_as,
        payload_files={
            "source_cir": "source.cir",
            "module_cir": "module.cir",
            "netlist_notebook": "netlist-notebook.md",
            "import_meta": "import-meta.json",
        },
        provenance={"source": str(source_file), "notes": "circuit import"},
        model_hints=flattened.get("model_hints") or [],
        references_dir=references_dir,
    )
    return {"ok": True, "asset": asset, "flattened": meta}


def import_visual_reference(
    source_file: Path,
    *,
    name: str | None = None,
    references_dir: Path | None = None,
) -> dict[str, Any]:
    source_file = Path(source_file).resolve()
    if not source_file.exists():
        raise ValueError(f"visual file not found: {source_file}")
    suffix = source_file.suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf"}:
        raise ValueError(f"unsupported visual reference type: {suffix}")
    asset_id = _new_asset_id(name or source_file.stem, references_dir)
    root = asset_dir(asset_id, references_dir)
    payload = root / "payload"
    payload.mkdir(parents=True, exist_ok=True)
    preview_name = "preview.png" if suffix == ".pdf" else f"preview{suffix if suffix != '.jpeg' else '.jpg'}"
    if suffix == ".pdf":
        # PDF rasterization is performed by the desktop host when available.
        # Store the PDF and a placeholder note; host may overwrite preview.png.
        shutil.copyfile(source_file, payload / "source.pdf")
        note = {
            "needs_rasterize": True,
            "source": "source.pdf",
            "page": 0,
        }
        write_json(payload / "rasterize.json", note)
        preview_rel = "preview.png"
        files = {"source_pdf": "source.pdf", "rasterize": "rasterize.json", "preview": preview_rel}
    else:
        shutil.copyfile(source_file, payload / preview_name)
        preview_rel = preview_name
        files = {"preview": preview_rel}
    asset = write_asset(
        asset_id=asset_id,
        kind="layout_visual",
        name=name or source_file.stem,
        trust="user_upload",
        use_as=["agent_context_only"],
        payload_files=files,
        provenance={"source": str(source_file), "notes": "visual layout reference"},
        references_dir=references_dir,
    )
    return {"ok": True, "asset": asset, "preview_path": str((payload / preview_rel).resolve())}


def register_layout_reference_asset(
    layout_ref: dict[str, Any],
    *,
    name: str,
    parent_asset_id: str | None = None,
    trust: str = "verified_layout",
    references_dir: Path | None = None,
) -> dict[str, Any]:
    if layout_ref.get("schema") != LAYOUT_REF_SCHEMA:
        raise ValueError("layout_ref must use actoviq.schematic-layout-reference.v1")
    asset_id = _new_asset_id(name, references_dir)
    root = asset_dir(asset_id, references_dir)
    payload = root / "payload"
    payload.mkdir(parents=True, exist_ok=True)
    write_json(payload / "layout-reference.json", layout_ref)
    asset = write_asset(
        asset_id=asset_id,
        kind="schematic_layout",
        name=name,
        trust=trust,
        use_as=["apply_layout_seed", "agent_context_only"],
        payload_files={"layout_reference": "layout-reference.json"},
        binds_to={
            "connectivity_hash": str(layout_ref.get("connectivity_hash", "")).lower(),
            "module_role": str(layout_ref.get("module_id") or ""),
        },
        provenance={
            "parent_asset_id": parent_asset_id,
            "notes": "schematic layout snapshot",
        },
        preferred_for_agent_reuse=trust == "verified_layout",
        references_dir=references_dir,
    )
    return {"ok": True, "asset": asset}


def register_project_template_catalog(
    *,
    memory_id: str,
    project_name: str,
    template_relative: str,
    layout_refs: list[dict[str, Any]],
    trust: str,
    source_project_id: str,
    source_revision: int,
    references_dir: Path | None = None,
) -> dict[str, Any]:
    """Register a design-memory template as a circuit_project catalog asset."""
    children: list[str] = []
    child_results = []
    for entry in layout_refs:
        layout_ref = entry["layout"]
        module_id = entry.get("module_id") or layout_ref.get("module_id") or "module"
        child = register_layout_reference_asset(
            layout_ref,
            name=f"{project_name}-{module_id}-layout",
            trust="verified_layout" if trust in {"verified", "simulated"} else "agent_draft",
            references_dir=references_dir,
        )
        children.append(child["asset"]["id"])
        child_results.append(child["asset"])

    asset_id = memory_id
    root = asset_dir(asset_id, references_dir)
    # Point payload at the design-memory template via a pointer file (no full copy).
    payload = root / "payload"
    payload.mkdir(parents=True, exist_ok=True)
    write_json(
        payload / "template-pointer.json",
        {
            "template_id": memory_id,
            "relative_path": template_relative,
            "kind": "design_memory_template",
        },
    )
    hashes = [
        str(item.get("binds_to", {}).get("connectivity_hash") or "")
        for item in child_results
        if item.get("binds_to", {}).get("connectivity_hash")
    ]
    asset = write_asset(
        asset_id=asset_id,
        kind="circuit_project",
        name=project_name,
        trust="verified_sim" if trust in {"verified", "simulated"} else "agent_draft",
        use_as=["seed_new_project", "agent_context_only"],
        payload_files={"template_pointer": "template-pointer.json"},
        binds_to={"topology_tags": ["design_memory_template"]},
        provenance={
            "source_project_id": source_project_id,
            "source_revision": source_revision,
            "source": template_relative,
        },
        preferred_for_agent_reuse=trust == "verified",
        children=children,
        references_dir=references_dir,
    )
    # Attach multi-hash summary for agents
    if hashes:
        asset["binds_to"] = {**asset.get("binds_to", {}), "connectivity_hashes": hashes}
        write_json(root / "asset.json", {k: v for k, v in asset.items() if k != "root_path"})
    return {"ok": True, "asset": asset, "layout_assets": child_results}


def ensure_builtin_idioms(references_dir: Path | None = None) -> None:
    if not BUILTIN_IDIOMS_DIR.exists():
        return
    for path in sorted(BUILTIN_IDIOMS_DIR.glob("*.json")):
        try:
            idiom = read_json(path)
        except (OSError, json.JSONDecodeError):
            continue
        if idiom.get("schema") != IDIOM_SCHEMA:
            continue
        idiom_id = str(idiom.get("idiom_id") or path.stem)
        asset_id = f"idiom-{idiom_id}"
        existing = asset_dir(asset_id, references_dir) / "asset.json"
        if existing.exists():
            continue
        root = asset_dir(asset_id, references_dir)
        payload = root / "payload"
        payload.mkdir(parents=True, exist_ok=True)
        write_json(payload / "idiom.json", idiom)
        write_asset(
            asset_id=asset_id,
            kind="layout_idiom",
            name=str(idiom.get("name") or idiom_id),
            trust="agent_draft",
            use_as=["guide_router", "agent_context_only"],
            payload_files={"idiom": "idiom.json"},
            binds_to={
                "topology_tags": list(idiom.get("topology_tags") or []),
                "module_role": (idiom.get("module_roles") or [None])[0] or "",
            },
            provenance={"source": "builtin", "notes": f"bundled idiom {idiom_id}"},
            preferred_for_agent_reuse=True,
            references_dir=references_dir,
        )


def load_layout_reference_payload(asset: dict[str, Any]) -> dict[str, Any]:
    root = Path(asset["root_path"])
    files = (asset.get("payload") or {}).get("files") or {}
    rel = files.get("layout_reference") or "layout-reference.json"
    path = root / "payload" / rel
    if not path.exists():
        # also allow layout-reference at module path inside design-memory copies
        alt = root / rel
        if alt.exists():
            path = alt
        else:
            raise ValueError(f"layout reference payload missing for {asset.get('id')}")
    layout = read_json(path)
    if layout.get("schema") != LAYOUT_REF_SCHEMA:
        raise ValueError("invalid schematic layout reference payload")
    return layout


def load_idiom_payload(asset: dict[str, Any]) -> dict[str, Any]:
    root = Path(asset["root_path"])
    files = (asset.get("payload") or {}).get("files") or {}
    rel = files.get("idiom") or "idiom.json"
    path = root / "payload" / rel
    if not path.exists():
        raise ValueError(f"idiom payload missing for {asset.get('id')}")
    idiom = read_json(path)
    if idiom.get("schema") != IDIOM_SCHEMA:
        raise ValueError("invalid layout idiom payload")
    return idiom


def idiom_to_layout_patch(module: dict[str, Any], idiom: dict[str, Any]) -> dict[str, Any]:
    """Convert an idiom into a constrained layout-patch (lane / rotation only)."""
    operations: list[dict[str, Any]] = []
    components = [c for c in (module.get("components") or []) if isinstance(c, dict)]
    for lane_spec in idiom.get("lanes") or []:
        match = lane_spec.get("match") or {}
        type_match = str(match.get("type") or "").upper()
        name_regex = match.get("name_regex")
        pattern = re.compile(name_regex, re.IGNORECASE) if name_regex else None
        for component in components:
            comp_type = str(component.get("type") or "").upper()
            name = str(component.get("name") or component.get("id") or "")
            if type_match and comp_type != type_match:
                continue
            if pattern and not pattern.search(name):
                continue
            operations.append(
                {
                    "op": "set_layout_lane",
                    "component_id": str(component.get("id")),
                    "rank": int(lane_spec.get("rank", 0)),
                    "lane": int(lane_spec.get("lane", 0)),
                }
            )
            if "rotation" in lane_spec:
                operations.append(
                    {
                        "op": "rotate_component",
                        "component_id": str(component.get("id")),
                        "rotation": int(lane_spec["rotation"]) % 360,
                    }
                )
            break  # first matching component per lane rule
    return {
        "schema": "actoviq.layout-patch.v1",
        "operations": operations[:32],
    }


def apply_placements_to_components(
    module: dict[str, Any],
    layout_ref: dict[str, Any],
) -> list[dict[str, Any]]:
    by_id = {
        str(item["component_id"]): item
        for item in layout_ref.get("placements") or []
        if isinstance(item, dict) and item.get("component_id")
    }
    components: list[dict[str, Any]] = []
    for component in module.get("components") or []:
        if not isinstance(component, dict):
            continue
        next_component = json.loads(json.dumps(component))
        placement = by_id.get(str(component.get("id")))
        if placement:
            next_component["position"] = {"x": placement["x"], "y": placement["y"]}
            next_component["x"] = placement["x"]
            next_component["y"] = placement["y"]
            if "rotation" in placement:
                next_component["rotation"] = placement["rotation"]
        components.append(next_component)
    return components


def prepare_layout_from_reference(
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    *,
    module_id: str,
    asset_id: str,
    references_dir: Path | None = None,
    connectivity_hash_fn: Any = None,
) -> dict[str, Any]:
    if module_id not in modules:
        raise ValueError(f"unknown module: {module_id}")
    asset = load_asset(asset_id, references_dir)
    module = modules[module_id]
    current_hash = ""
    if connectivity_hash_fn is not None:
        current_hash = connectivity_hash_fn(project, {module_id: module}, module_id, "design")

    if asset["kind"] == "schematic_layout":
        layout_ref = load_layout_reference_payload(asset)
        expected = str(layout_ref.get("connectivity_hash") or "").lower()
        match = bool(expected) and expected == current_hash.lower()
        return {
            "ok": True,
            "mode": "snapshot",
            "asset_id": asset_id,
            "module_id": module_id,
            "connectivity_hash": current_hash,
            "reference_connectivity_hash": expected,
            "hash_match": match,
            "use_as": "apply_layout_seed" if match else "agent_context_only",
            "layout_reference": layout_ref if match else None,
            "message": (
                "connectivity_hash matches; layout snapshot can be applied"
                if match
                else "connectivity_hash mismatch; layout reference degraded to agent_context_only"
            ),
        }

    if asset["kind"] == "layout_idiom":
        idiom = load_idiom_payload(asset)
        tags = set(str(tag) for tag in (idiom.get("topology_tags") or []))
        roles = set(str(role) for role in (idiom.get("module_roles") or []))
        module_kind = str((project.get("modules") or [{}])[0].get("kind") if False else "")
        # Prefer explicit module ref kind/function from project modules list
        module_ref = next((m for m in project.get("modules", []) if m.get("id") == module_id), {})
        module_kind = str(module_ref.get("kind") or "")
        module_function = str(module_ref.get("function") or "")
        tag_haystack = {module_kind.lower(), module_function.lower(), module_id.lower()}
        tag_match = (not tags) or any(tag.lower() in " ".join(tag_haystack) for tag in tags) or any(
            any(tag.lower() in item for item in tag_haystack) for tag in tags
        )
        role_match = (not roles) or module_kind in roles or any(role in module_function for role in roles)
        matched = tag_match or role_match
        patch = idiom_to_layout_patch(module, idiom) if matched else {"schema": "actoviq.layout-patch.v1", "operations": []}
        return {
            "ok": True,
            "mode": "idiom",
            "asset_id": asset_id,
            "module_id": module_id,
            "connectivity_hash": current_hash,
            "hash_match": False,
            "tag_match": matched,
            "use_as": "guide_router" if matched and patch.get("operations") else "agent_context_only",
            "layout_patch": patch,
            "idiom": idiom,
            "message": (
                "idiom tags matched; guide_router patch prepared"
                if matched and patch.get("operations")
                else "idiom did not match module role/tags"
            ),
        }

    if asset["kind"] == "layout_visual":
        return {
            "ok": True,
            "mode": "visual",
            "asset_id": asset_id,
            "module_id": module_id,
            "connectivity_hash": current_hash,
            "hash_match": False,
            "use_as": "agent_context_only",
            "message": "layout_visual requires vision promotion before apply_layout_seed",
            "promote_required": True,
        }

    raise ValueError(f"asset kind cannot prepare layout: {asset.get('kind')}")


def catalog_summary_for_agent(
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    *,
    references_dir: Path | None = None,
    connectivity_hash_fn: Any = None,
) -> dict[str, Any]:
    catalog = list_catalog(references_dir)
    module_hashes: dict[str, str] = {}
    if connectivity_hash_fn is not None:
        for module_id, module in modules.items():
            try:
                module_hashes[module_id] = connectivity_hash_fn(
                    project, {module_id: module}, module_id, "design"
                )
            except Exception:
                continue
    entries = []
    for asset in catalog["assets"]:
        binds = asset.get("binds_to") or {}
        expected = str(binds.get("connectivity_hash") or "").lower()
        matches = []
        if expected:
            for module_id, value in module_hashes.items():
                if value.lower() == expected:
                    matches.append(module_id)
        entries.append(
            {
                "id": asset.get("id"),
                "kind": asset.get("kind"),
                "name": asset.get("name"),
                "trust": asset.get("trust"),
                "use_as": asset.get("use_as"),
                "preferred_for_agent_reuse": bool(asset.get("preferred_for_agent_reuse")),
                "topology_tags": binds.get("topology_tags") or [],
                "connectivity_hash": expected or None,
                "matching_modules": matches,
            }
        )
    return {
        "schema": "actoviq.reference-catalog-agent.v1",
        "count": len(entries),
        "module_connectivity_hashes": module_hashes,
        "assets": entries,
    }


def promote_visual_to_layout(
    *,
    visual_asset_id: str,
    layout_ref: dict[str, Any],
    name: str | None = None,
    references_dir: Path | None = None,
) -> dict[str, Any]:
    visual = load_asset(visual_asset_id, references_dir)
    if visual.get("kind") != "layout_visual":
        raise ValueError("promote requires a layout_visual asset")
    result = register_layout_reference_asset(
        layout_ref,
        name=name or f"{visual.get('name')}-layout",
        parent_asset_id=visual_asset_id,
        trust="verified_layout",
        references_dir=references_dir,
    )
    # Keep visual as provenance-only context.
    return {
        "ok": True,
        "visual_asset_id": visual_asset_id,
        "layout_asset": result["asset"],
    }
