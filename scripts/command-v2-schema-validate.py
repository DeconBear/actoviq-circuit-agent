#!/usr/bin/env python3
"""Validate command.v2.schema.json: legal commands pass, malformed ones reject.

Covers the discriminated-union guarantees from ADR-0003: each operation type
must reject missing required fields, extraneous fields, and invalid enum
values. v1 commands are intentionally not valid against this schema.

Run:  python scripts/command-v2-schema-validate.py
"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import jsonschema

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = ROOT / "skills" / "circuit-design-ngspice" / "schemas" / "command.v2.schema.json"

BASE = {
    "schema": "actoviq.command.v2",
    "command_id": "c1",
    "actor": "playwright",
    "project_id": "p1",
    "module_id": "filter",
    "base_revision": 0,
    "expected_module_revision": 0,
}

COMPONENT = {
    "id": "r1", "type": "R", "name": "R1", "value": "1k",
    "position": {"x": 100, "y": 100}, "rotation": 0,
    "pins": [{"id": "a", "name": "1", "net": "in"}],
}

WIRE = {
    "wire_id": "w1",
    "points": [{"x": 0, "y": 0}, {"x": 10, "y": 0}],
    "from": {"x": 0, "y": 0, "junction_id": "j1"},
    "to": {"x": 10, "y": 0, "junction_id": "j2"},
    "net": "in",
    "net_id": "net_in",
}


def op(**kwargs):
    return kwargs


CASES = [
    ("place_component valid", [op(op="place_component", component=COMPONENT)], True),
    ("place_component missing component", [op(op="place_component")], False),
    ("update_component valid", [op(op="update_component", component_id="r1", value="2k")], True),
    ("update_component missing component_id", [op(op="update_component", value="2k")], False),
    ("move_entities free valid", [op(op="move_entities", entity_ids=["r1"], delta={"x": 10, "y": 0}, mode="free")], True),
    ("move_entities stretch valid", [op(op="move_entities", entity_ids=["r1"], delta={"x": 10, "y": 0}, mode="stretch")], True),
    ("move_entities invalid mode", [op(op="move_entities", entity_ids=["r1"], delta={"x": 10, "y": 0}, mode="invalid")], False),
    ("move_entities extra field rejected", [op(op="move_entities", entity_ids=["r1"], delta={"x": 10, "y": 0}, mode="free", extra=True)], False),
    ("delete_entities valid", [op(op="delete_entities", entity_ids=["r1"])], True),
    ("create_wire valid", [op(op="create_wire", **WIRE)], True),
    ("create_wire too few points", [op(op="create_wire", **{**WIRE, "points": [{"x": 0, "y": 0}]})], False),
    ("create_wire missing endpoint rejected", [op(op="create_wire", **{key: value for key, value in WIRE.items() if key != "to"})], False),
    ("create_wire missing net_id rejected", [op(op="create_wire", **{key: value for key, value in WIRE.items() if key != "net_id"})], False),
    ("edit_wire_path valid", [op(op="edit_wire_path", wire_id="w1", points=[{"x": 0, "y": 0}, {"x": 20, "y": 0}])], True),
    ("split_wire valid", [op(op="split_wire", wire_id="w1", point={"x": 10, "y": 0})], True),
    ("join_wires valid", [op(op="join_wires", wire_ids=["w1", "w2"])], True),
    ("join_wires too few", [op(op="join_wires", wire_ids=["w1"])], False),
    ("upsert_junction valid", [op(op="upsert_junction", junction_id="j1", point={"x": 10, "y": 0}, net="in")], True),
    ("rename_net valid", [op(op="rename_net", old_net="in", new_net="input")], True),
    ("upsert_port valid", [op(op="upsert_port", port={"id": "p1", "name": "P1", "direction": "input", "signal_type": "analog", "net": "in"})], True),
    ("upsert_port invalid direction", [op(op="upsert_port", port={"id": "p1", "name": "P1", "direction": "sideways", "signal_type": "analog", "net": "in"})], False),
    ("place_module_instance valid", [op(op="place_module_instance", component_id="m1", module_ref={"module_id": "amp"}, position={"x": 0, "y": 0}, pins=[{"id": "in", "name": "IN", "net": "m1_in"}])], True),
    ("place_module_instance without pins rejected", [op(op="place_module_instance", component_id="m1", module_ref={"module_id": "amp"}, position={"x": 0, "y": 0})], False),
    ("set_module_metadata valid", [op(op="set_module_metadata", name="Filter")], True),
    ("unknown op rejected", [op(op="frobnicate")], False),
    ("wrong schema const rejected", None, False),
    ("missing base_revision rejected", None, False),
    ("missing expected_module_revision rejected", None, False),
]


def main() -> int:
    with SCHEMA_PATH.open(encoding="utf-8") as f:
        schema = json.load(f)
    validator = jsonschema.Draft202012Validator(schema)

    passed = 0
    failed = 0
    for name, operations, expect_valid in CASES:
        if operations is None and name == "wrong schema const rejected":
            cmd = copy.deepcopy(BASE)
            cmd["schema"] = "actoviq.command.v1"
            cmd["operations"] = [op(op="place_component", component=COMPONENT)]
        elif operations is None and name == "missing base_revision rejected":
            cmd = copy.deepcopy(BASE)
            del cmd["base_revision"]
            cmd["operations"] = [op(op="place_component", component=COMPONENT)]
        elif operations is None and name == "missing expected_module_revision rejected":
            cmd = copy.deepcopy(BASE)
            del cmd["expected_module_revision"]
            cmd["operations"] = [op(op="place_component", component=COMPONENT)]
        else:
            cmd = copy.deepcopy(BASE)
            cmd["operations"] = operations
        is_valid = validator.is_valid(cmd)
        ok = is_valid == expect_valid
        if ok:
            passed += 1
            print(f"PASS {name}")
        else:
            failed += 1
            errors = sorted(validator.iter_errors(cmd), key=lambda e: list(e.path))
            msg = errors[0].message if errors else "(no error)"
            print(f"FAIL {name}: expected_valid={expect_valid} actual={is_valid} :: {msg}")

    print(json.dumps({"ok": failed == 0, "passed": passed, "failed": failed, "total": len(CASES)}, indent=2))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
