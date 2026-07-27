#!/usr/bin/env python3
"""Regression for explicit Xschem ownership and safe-field synchronization."""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL_SCRIPTS = ROOT / "skills" / "circuit-design-ngspice" / "scripts"
sys.path.insert(0, str(SKILL_SCRIPTS))

from circuit_project import apply_operation  # noqa: E402
from xschem_bridge import headless_validate, link_existing, make_binding, pull, push  # noqa: E402


def fixture() -> dict:
    return {
        "schema": "actoviq.module.v2",
        "module_id": "core",
        "name": "Core",
        "revision": 1,
        "ports": [],
        "nets": [{"id": "n-in", "name": "in"}, {"id": "n-out", "name": "out"}],
        "components": [{
            "id": "m1",
            "stable_id": "component-m1",
            "type": "M",
            "name": "M1",
            "value": "nmos W=1u L=0.13u M=1 NF=1",
            "position": {"x": 100.0, "y": 200.0},
            "rotation": 0,
            "pins": [
                {"id": "G", "name": "G", "net": "in", "net_id": "n-in"},
                {"id": "D", "name": "D", "net": "out", "net_id": "n-out"},
            ],
        }],
        "wires": [{
            "id": "wire-1",
            "net": "out",
            "net_id": "n-out",
            "points": [{"x": 100.0, "y": 200.0}, {"x": 160.0, "y": 200.0}],
        }],
        "annotations": [],
    }


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="actoviq-xschem-regression-") as temporary:
        root = Path(temporary)
        peer_file = root / "core.sch"
        module = fixture()
        binding = make_binding("bridge", str(peer_file))
        pushed = push(module, binding, 1)
        assert peer_file.is_file()
        assert "ACTOVIQ_ID" in peer_file.read_text(encoding="utf-8")
        fake_xschem = root / "fake_xschem.py"
        fake_xschem.write_text(
            "import pathlib, sys\n"
            "out = pathlib.Path(sys.argv[sys.argv.index('-o') + 1])\n"
            "name = sys.argv[sys.argv.index('-N') + 1]\n"
            "(out / name).write_text('M1 in out sg13_lv_nmos\\n.end\\n', encoding='utf-8')\n",
            encoding="utf-8",
        )
        validation = headless_validate(peer_file, root / "headless", str(fake_xschem), module)
        assert validation["status"] == "passed"
        assert validation["metadata"]["connectivity_comparison"]["compared_instance_count"] == 1
        assert validation["metadata"]["topology_writeback"] is False

        mismatched = json.loads(json.dumps(module))
        mismatched["components"][0]["pins"][1]["net"] = "different"
        mismatch = headless_validate(peer_file, root / "headless-mismatch", str(fake_xschem), mismatched)
        assert mismatch["status"] == "failed"
        assert any("connectivity differs" in item for item in mismatch["diagnostics"])

        edited = peer_file.read_text(encoding="utf-8")
        edited = edited.replace("100.000 200.000 0 0", "120.000 220.000 1 0", 1)
        edited = edited.replace("W=1u L=0.13u", "W=2u L=0.18u", 1)
        edited += 'T {puts "must-not-run"} 0 0 0 0 0.2 0.2 {}\n'
        peer_file.write_text(edited, encoding="utf-8")
        pulled = pull(module, pushed["binding"])
        assert not pulled["requires_review"]
        updated = pulled["updated_module"]
        component = updated["components"][0]
        assert component["position"] == {"x": 120.0, "y": 220.0}
        assert component["rotation"] == 90
        assert "W=2u" in component["value"] and "L=0.18u" in component["value"]
        assert pulled["opaque_record_count"] == 1

        linked = link_existing(updated, {**pulled["binding"], "mode": "external"}, 2)
        assert linked["binding"]["mode"] == "external"
        updated["schematic_peer"] = linked["binding"]
        project = {
            "project_id": "xschem-test",
            "project_kind": "analog_ic",
            "revision": 2,
            "modules": [{"id": "core", "ports": []}],
            "connections": [],
        }
        try:
            apply_operation(
                root,
                project,
                {"core": updated},
                {"op": "move_component", "module_id": "core", "component_id": "m1", "x": 0, "y": 0},
                set(),
                {},
                {},
            )
            raise AssertionError("external Xschem mode accepted an Actoviq canvas edit")
        except ValueError as error:
            assert "read-only" in str(error)

        local_changed = json.loads(json.dumps(updated))
        local_changed["components"][0]["position"]["x"] = 500
        peer_file.write_text(peer_file.read_text(encoding="utf-8").replace("120.000", "130.000", 1), encoding="utf-8")
        conflict = pull(local_changed, linked["binding"])
        assert conflict["requires_review"]
        assert any(item["kind"] == "concurrent_edit" for item in conflict["conflicts"])

    print(json.dumps({"ok": True, "suite": "xschem-bridge-regression"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
