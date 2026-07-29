#!/usr/bin/env python3
"""Regression checks for project ERC no-connect semantics."""

from __future__ import annotations

import copy
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL_ROOT = ROOT / "skills" / "circuit-design-ngspice"
sys.path.insert(0, str(SKILL_ROOT / "scripts"))

from circuit_project import evaluate_erc  # noqa: E402


def fixture() -> tuple[dict, dict]:
    project = {
        "schema": "actoviq.project.v2",
        "project_id": "live-erc-no-connect",
        "name": "Live ERC no-connect",
        "project_kind": "simulation",
        "revision": 0,
        "modules": [{"id": "core", "ports": []}],
        "connections": [],
    }
    module = {
        "schema": "actoviq.module.v2",
        "module_id": "core",
        "name": "Core",
        "revision": 0,
        "ports": [],
        "components": [
            {
                "id": "m1",
                "name": "M1",
                "type": "M",
                "value": "nch",
                "pins": [
                    {"id": "g", "name": "G", "net": "NC_GATE", "no_connect": True},
                    {"id": "d", "name": "D", "net": "0"},
                    {"id": "s", "name": "S", "net": "0"},
                    {"id": "b", "name": "B", "net": "0"},
                ],
            }
        ],
        "nets": [{"id": "net_0", "name": "0", "kind": "ground"}],
        "wires": [],
        "annotations": [],
        "spice": {"models": [".model nch NMOS"]},
    }
    return project, module


def diagnostic_kinds(project: dict, module: dict) -> list[str]:
    return [
        str(item.get("code"))
        for item in evaluate_erc(project, {"core": module}).get("diagnostics", [])
    ]


def main() -> int:
    project, module = fixture()
    kinds = diagnostic_kinds(project, module)
    assert "floating_critical_pin" not in kinds
    assert "connected_no_connect" not in kinds

    wired_module = copy.deepcopy(module)
    wired_module["wires"] = [
        {
            "id": "wire_nc",
            "net_id": "net_nc",
            "from": {"component_id": "m1", "pin_id": "g"},
            "to": {"junction_id": "junction_nc"},
            "points": [{"x": 0, "y": 0}, {"x": 40, "y": 0}],
        }
    ]
    wired_kinds = diagnostic_kinds(project, wired_module)
    assert "connected_no_connect" in wired_kinds

    print(
        {
            "ok": True,
            "suite": "live-erc-regression",
            "no_connect_suppresses_floating": True,
            "connected_no_connect_is_error": True,
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
