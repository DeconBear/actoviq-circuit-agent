"""Focused module-schema regressions for structured editor-only fields."""

from __future__ import annotations

import copy
import json
from pathlib import Path

from jsonschema import Draft202012Validator


ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads(
    (ROOT / "skills" / "circuit-design-ngspice" / "schemas" / "module.schema.json").read_text(
        encoding="utf-8"
    )
)
VALIDATOR = Draft202012Validator(SCHEMA)

BASE_MODULE = {
    "schema": "actoviq.module.v2",
    "module_id": "no_connect_fixture",
    "name": "No-connect fixture",
    "revision": 0,
    "ports": [],
    "components": [
        {
            "id": "spare",
            "type": "BLOCK",
            "name": "SPARE",
            "value": "unused",
            "position": {"x": 0, "y": 0},
            "rotation": 0,
            "pins": [
                {
                    "id": "nc",
                    "name": "NC",
                    "net": "spare",
                    "no_connect": True,
                }
            ],
        }
    ],
}


def main() -> None:
    valid_errors = list(VALIDATOR.iter_errors(BASE_MODULE))
    assert not valid_errors, valid_errors
    print("PASS boolean pin no_connect")

    invalid = copy.deepcopy(BASE_MODULE)
    invalid["components"][0]["pins"][0]["no_connect"] = "yes"
    assert list(VALIDATOR.iter_errors(invalid))
    print("PASS non-boolean pin no_connect rejected")
    print(json.dumps({"ok": True, "passed": 2, "failed": 0, "total": 2}, indent=2))


if __name__ == "__main__":
    main()
