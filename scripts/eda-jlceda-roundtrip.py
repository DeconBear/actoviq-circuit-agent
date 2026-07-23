#!/usr/bin/env python3
"""Round-trip coverage for JLCEDA / EasyEDA bridge push/pull geometry preservation."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
SKILL_SCRIPTS = REPO / "skills" / "circuit-design-ngspice" / "scripts"
sys.path.insert(0, str(SKILL_SCRIPTS))

from circuit_project import (  # noqa: E402
    MODULE_SCHEMA,
    atomic_write_json,
    initialize_project,
    load_project,
    module_path,
    project_document_hash,
)
from eda_bridge import link_bridge, pull_bridge, push_bridge  # noqa: E402
from stable_ids import ensure_module_stable_ids  # noqa: E402


def make_module() -> dict:
    module = {
        "schema": MODULE_SCHEMA,
        "module_id": "divider",
        "name": "Resistor Divider",
        "revision": 0,
        "ports": [
            {"id": "vin", "name": "VIN", "direction": "input", "signal_type": "power", "net": "vin"},
            {"id": "vout", "name": "VOUT", "direction": "output", "signal_type": "analog", "net": "vout"},
            {"id": "gnd", "name": "GND", "direction": "bidirectional", "signal_type": "ground", "net": "0"},
        ],
        "components": [
            {
                "id": "r_top",
                "type": "R",
                "name": "R1",
                "value": "10k",
                "position": {"x": 240, "y": 180},
                "rotation": 0,
                "pins": [{"id": "a", "name": "1", "net": "vin"}, {"id": "b", "name": "2", "net": "vout"}],
            },
            {
                "id": "r_bot",
                "type": "R",
                "name": "R2",
                "value": "10k",
                "position": {"x": 240, "y": 360},
                "rotation": 90,
                "pins": [{"id": "a", "name": "1", "net": "vout"}, {"id": "b", "name": "2", "net": "0"}],
            },
        ],
        "nets": [
            {"id": "net_vin", "name": "vin", "kind": "power"},
            {"id": "net_vout", "name": "vout", "kind": "analog"},
            {"id": "net_0", "name": "0", "kind": "ground"},
        ],
        "wires": [],
        "annotations": [],
    }
    ensure_module_stable_ids(module)
    return module


def write_divider_project(root: Path) -> None:
    module = make_module()
    project_path = root / "project.circuit.json"
    project = json.loads(project_path.read_text(encoding="utf-8"))
    project["project_kind"] = "pcb_schematic"
    project["modules"] = [{"id": "divider", "name": module["name"], "ports": module["ports"]}]
    atomic_write_json(project_path, project)
    atomic_write_json(module_path(root, "divider"), module)


def find_easyeda_document(peer_root: Path) -> Path:
    path = peer_root / "actoviq-sync" / "jlceda" / "schematic.easyeda.json"
    if not path.is_file():
        raise AssertionError("JLCEDA push did not produce schematic.easyeda.json")
    return path


def mutate_easyeda_geometry(document_path: Path, *, dx_mm: float, dy_mm: float, delta_rot: int) -> None:
    payload = json.loads(document_path.read_text(encoding="utf-8"))
    actoviq = payload.get("actoviq") or {}
    pages = actoviq.get("pages") or []
    assert pages, "EasyEDA export must embed actoviq page metadata"
    metadata_before = json.loads(json.dumps(actoviq))

    shape = payload.setdefault("shape", [])
    for entry in shape:
        if isinstance(entry, list) and entry and entry[0] == "LIB":
            entry[3] = float(entry[3]) + dx_mm
            entry[4] = float(entry[4]) + dy_mm
            entry[5] = (int(entry[5]) + delta_rot) % 360
            attrs = entry[8]
            attrs["Value"] = "22k-shape-edit"
            attrs["Reference"] = "R77"
            break
    else:
        raise AssertionError("expected an editable EasyEDA LIB shape")

    assert payload["actoviq"] == metadata_before, "regression must edit only shape, not embedded metadata"
    document_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    temp_root = Path(tempfile.mkdtemp(prefix="actoviq-jlceda-roundtrip-"))
    try:
        projects_root = temp_root / "projects"
        peer_root = temp_root / "peer-jlceda"
        projects_root.mkdir(parents=True)
        peer_root.mkdir(parents=True)

        project_root = initialize_project(
            projects_root,
            "JLCEDA Roundtrip",
            "jlceda-roundtrip",
            demo=False,
            project_kind="pcb_schematic",
        )
        write_divider_project(project_root)
        project, modules = load_project(project_root)
        document_hash = project_document_hash(project, modules)
        stable_ids_before = {
            component["id"]: component.get("stable_id")
            for component in modules["divider"]["components"]
        }
        positions_before = {
            component["id"]: dict(component["position"])
            for component in modules["divider"]["components"]
        }

        link_bridge(project_root, "jlceda", peer_root, policy="layout_wins")
        push_result = push_bridge(
            project_root,
            "jlceda",
            project=project,
            modules=modules,
            document_hash=document_hash,
            source_revision=project["revision"],
        )
        assert push_result["ok"], push_result
        document_path = find_easyeda_document(peer_root)
        mutate_easyeda_geometry(document_path, dx_mm=50.8, dy_mm=25.4, delta_rot=180)

        pull_result = pull_bridge(
            project_root,
            "jlceda",
            project=project,
            modules=modules,
            policy="layout_wins",
        )
        assert pull_result["ok"], pull_result
        updated = pull_result["updated_modules"]["divider"]
        r_top = next(item for item in updated["components"] if item["id"] == "r_top")
        assert r_top.get("stable_id") == stable_ids_before["r_top"], "stable_id must be preserved"
        assert r_top["position"] != positions_before["r_top"], "position should reflect peer geometry edit"
        assert int(r_top.get("rotation", 0)) == 180, "rotation should reflect peer geometry edit"
        assert r_top["value"] == "22k-shape-edit", "shape value must override embedded metadata"
        assert r_top["eda"]["refdes"] == "R77", "shape refdes must override embedded metadata"

        print(
            json.dumps(
                {
                    "ok": True,
                    "project_root": str(project_root),
                    "peer_root": str(peer_root),
                    "document": str(document_path),
                    "applied": pull_result.get("applied", []),
                },
                ensure_ascii=False,
            )
        )
        return 0
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
