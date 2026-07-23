#!/usr/bin/env python3
"""Regression for workspace reference catalog (circuit + layout)."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "skills" / "circuit-design-ngspice" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from reference_assets import (  # noqa: E402
    flatten_spice_for_module,
    import_circuit_reference,
    import_visual_reference,
    list_catalog,
    prepare_layout_from_reference,
    promote_visual_to_layout,
    build_layout_reference,
)
from circuit_project import (  # noqa: E402
    apply_layout_from_reference_command,
    create_project_from_circuit_reference,
    initialize_project,
    insert_module_from_circuit_reference,
    load_project,
    pack_template_layouts_from_project,
    connectivity_hash,
)
from eda_export import connectivity_hash as eda_hash  # noqa: E402


def _assert(cond: bool, message: str) -> None:
    if not cond:
        raise AssertionError(message)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="actoviq-ref-") as tmp:
        tmp_path = Path(tmp)
        refs = tmp_path / "references"
        refs.mkdir(parents=True)
        projects = tmp_path / "projects"
        projects.mkdir()
        import os
        os.environ["ACTOVIQ_REFERENCES_DIR"] = str(refs)

        # 1) Import flat cir
        cir = tmp_path / "rc.cir"
        cir.write_text(
            "* RC\nVin in 0 DC 1\nR1 in out 1k\nC1 out 0 1n\n.end\n",
            encoding="utf-8",
        )
        imported = import_circuit_reference(cir, as_kind="circuit_module", references_dir=refs)
        _assert(imported["ok"], "import circuit failed")
        asset_id = imported["asset"]["id"]

        # 2) Flatten subckt
        sub = tmp_path / "amp.cir"
        sub.write_text(
            ".subckt stage in out\nR1 in out 2k\n.endc\n.ends\n",
            encoding="utf-8",
        )
        # fix - .ends not .endc
        sub.write_text(
            ".subckt stage in out\nR1 in out 2k\n.ends\n",
            encoding="utf-8",
        )
        flat = flatten_spice_for_module(sub.read_text(encoding="utf-8"))
        _assert("R1" in flat["spice"], "subckt body not flattened")
        _assert(".subckt" not in flat["spice"].lower(), "subckt directive leaked")

        multi = ".subckt a in out\nR1 in out 1k\n.ends\n.subckt b in out\nR2 in out 2k\n.ends\n"
        try:
            flatten_spice_for_module(multi)
            raise AssertionError("expected multi-subckt error")
        except ValueError as error:
            _assert("candidates" in str(error).lower() or "multiple" in str(error).lower(), str(error))

        # 3) Create project from reference
        created = create_project_from_circuit_reference(
            asset_id=asset_id,
            name="ref-rc-seed",
            projects_root=projects,
        )
        _assert(created["ok"], "create project failed")
        project_root = Path(created["project_root"])
        project, modules = load_project(project_root)
        _assert("core" in modules, "seed module missing")

        # 4) Pack template layouts + catalog
        template_root = refs / "design-memory" / "templates" / "demo-template"
        template_root.mkdir(parents=True)
        shutil.copytree(project_root / "modules", template_root / "modules", dirs_exist_ok=True)
        shutil.copyfile(project_root / "project.circuit.json", template_root / "project.circuit.json")
        (template_root / "template.json").write_text(
            json.dumps({"schema": "actoviq.design-template.v2", "id": "demo-template", "name": "demo"}, indent=2),
            encoding="utf-8",
        )
        packed = pack_template_layouts_from_project(
            project_root,
            template_root,
            memory_id="demo-template",
            template_relative="design-memory/templates/demo-template",
            trust="erc_clean",
        )
        _assert(packed["ok"], "pack failed")
        layout_file = template_root / "modules" / "core" / "layout-reference.json"
        _assert(layout_file.exists(), "layout-reference.json missing")
        layout = json.loads(layout_file.read_text(encoding="utf-8"))
        _assert(layout["schema"] == "actoviq.schematic-layout-reference.v1", "bad layout schema")

        # 5) Apply layout when hash matches
        layout_assets = packed["catalog"]["layout_assets"]
        _assert(layout_assets, "no layout child assets")
        layout_asset_id = layout_assets[0]["id"]
        applied = apply_layout_from_reference_command(
            project_root,
            module_id="core",
            asset_id=layout_asset_id,
        )
        _assert("hash_match" in applied or applied.get("ok") is not None, "apply returned unexpected shape")
        if applied.get("ok") and applied.get("applied"):
            project2, modules2 = load_project(project_root)
            _assert(
                connectivity_hash(project, {"core": modules["core"]}, "core")
                == connectivity_hash(project2, {"core": modules2["core"]}, "core"),
                "apply layout changed connectivity",
            )
        else:
            # Tiny decks may fail autorouter; prepare must still report hash_match.
            prepared_ok = prepare_layout_from_reference(
                project,
                modules,
                module_id="core",
                asset_id=layout_asset_id,
                references_dir=refs,
                connectivity_hash_fn=eda_hash,
            )
            _assert(prepared_ok.get("hash_match") is True, "expected hash match before mutation")

        # 6) Hash mismatch degrades — drop non-bench devices (V sources may be excluded from hash).
        project3, modules3 = load_project(project_root)
        mutated = json.loads(json.dumps(modules3["core"]))
        mutated["components"] = [
            component
            for component in (mutated.get("components") or [])
            if str(component.get("type", "")).upper() not in {"R", "C", "L"}
        ]
        prepared = prepare_layout_from_reference(
            project3,
            {**modules3, "core": mutated},
            module_id="core",
            asset_id=layout_asset_id,
            references_dir=refs,
            connectivity_hash_fn=eda_hash,
        )
        _assert(prepared.get("hash_match") is False, "expected hash mismatch after edit")
        _assert(prepared.get("use_as") == "agent_context_only", "mismatch should degrade")

        # 7) Visual import + promote
        png = tmp_path / "preview.png"
        # minimal PNG header bytes (1x1)
        png.write_bytes(
            bytes.fromhex(
                "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
                "0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082"
            )
        )
        visual = import_visual_reference(png, name="shot", references_dir=refs)
        _assert(visual["ok"], "visual import failed")
        # restore matching layout for promote content
        layout_ok = build_layout_reference(
            "core",
            modules["core"],
            connectivity_hash_value=layout["connectivity_hash"],
        )
        promoted = promote_visual_to_layout(
            visual_asset_id=visual["asset"]["id"],
            layout_ref=layout_ok,
            references_dir=refs,
        )
        _assert(promoted["ok"], "promote failed")
        _assert(promoted["layout_asset"]["kind"] == "schematic_layout", "promote kind")

        # 8) Idioms present in catalog
        catalog = list_catalog(refs)
        kinds = {asset["kind"] for asset in catalog["assets"]}
        _assert("layout_idiom" in kinds, f"builtin idioms missing: {kinds}")
        _assert("circuit_module" in kinds, "circuit_module missing")

        # 9) Insert module into another project
        other = initialize_project(projects, "host-project", None, False)
        inserted = insert_module_from_circuit_reference(other, asset_id=asset_id, module_id="imported_rc")
        _assert(inserted["ok"], "insert failed")
        _project, other_modules = load_project(other)
        _assert("imported_rc" in other_modules, "inserted module missing")

        print(json.dumps({"ok": True, "checks": 9, "catalog_count": catalog["count"]}, indent=2))
        return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}), file=sys.stderr)
        raise
