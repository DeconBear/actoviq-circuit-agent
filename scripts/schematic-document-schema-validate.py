"""Validate serialized schematic-document projections against the schema.

Reads a JSON array of serialized projections from stdin (produced by
`npx tsx scripts/schematic-document-serialize.ts`) and validates each against
skills/circuit-design-ngspice/schemas/schematic-document.schema.json using
jsonschema Draft 2020-12.

Run:  npx tsx scripts/schematic-document-serialize.ts | python scripts/schematic-document-schema-validate.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import jsonschema
import referencing
import referencing.jsonschema

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_DIR = ROOT / "skills" / "circuit-design-ngspice" / "schemas"
SCHEMA_PATH = SCHEMA_DIR / "schematic-document.schema.json"


def load_registry() -> referencing.Registry:
    """Load every schema in the schemas dir so $ref URIs resolve."""
    resources: list[tuple[str, dict]] = []
    for path in SCHEMA_DIR.glob("*.schema.json"):
        with path.open(encoding="utf-8") as f:
            schema = json.load(f)
        uri = schema.get("$id") or f"file://{path}"
        resources.append((uri, schema))
    return referencing.Registry().with_resources(
        [(uri, referencing.jsonschema.DRAFT202012.create_resource(s)) for uri, s in resources]
    )


def main() -> int:
    with SCHEMA_PATH.open(encoding="utf-8") as f:
        schema = json.load(f)
    validator = jsonschema.Draft202012Validator(schema, registry=load_registry())

    docs = json.load(sys.stdin)
    failures = 0
    for doc in docs:
        errors = sorted(validator.iter_errors(doc), key=lambda e: list(e.path))
        if errors:
            failures += 1
            first = errors[0]
            print(f"FAIL {doc['moduleId']}: {first.message} (at {list(first.path)})")
        else:
            print(f"PASS {doc['moduleId']}")

    print(json.dumps({"ok": failures == 0, "fixtureCount": len(docs), "failures": failures}, indent=2))
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
