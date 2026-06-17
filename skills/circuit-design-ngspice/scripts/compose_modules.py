#!/usr/bin/env python3
"""Compose a flat primitive SPICE netlist from a partitioned module plan."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Compose partitioned circuit modules")
    parser.add_argument("--job-root", required=True)
    parser.add_argument("--module-plan-path", default="planning/module-plan.json")
    parser.add_argument("--analysis-path", default="design/analysis.cir")
    parser.add_argument("--output-path", default="design/design.final.cir")
    parser.add_argument("--manifest-path", default="design/module-manifest.json")
    return parser


def clean_module(text: str) -> str:
    return "\n".join(
        line.rstrip() for line in text.splitlines() if line.strip().lower() != ".end"
    ).strip()


def count_components(text: str) -> int:
    return sum(
        1
        for raw in text.splitlines()
        if raw.strip() and not raw.strip().startswith(("*", ";", "."))
    )


def main() -> int:
    args = build_parser().parse_args()
    root = Path(args.job_root).resolve()
    plan = json.loads((root / args.module_plan_path).read_text(encoding="utf-8-sig"))
    modules = plan.get("modules", [])
    if plan.get("strategy") != "partitioned" or not modules:
        raise SystemExit("module plan must use strategy=partitioned and contain modules")

    output_parts = [f"* {plan.get('project_name', root.name)}", "* Composed by circuit-design-ngspice"]
    manifest_modules = []
    for index, module in enumerate(modules, start=1):
        module_path = root / module["file"]
        if not module_path.exists():
            raise SystemExit(f"missing module file: {module_path}")
        text = clean_module(module_path.read_text(encoding="utf-8-sig"))
        output_parts.extend(["", f"* MODULE {index}: {module['name']}", text])
        manifest_modules.append(
            {
                "order": index,
                "name": module["name"],
                "file": module["file"],
                "input_nets": module.get("input_nets", []),
                "output_nets": module.get("output_nets", []),
                "component_count": count_components(text),
                "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            }
        )

    analysis_path = root / args.analysis_path
    if analysis_path.exists():
        output_parts.extend(["", "* ANALYSIS", clean_module(analysis_path.read_text(encoding="utf-8-sig"))])
    output_parts.extend(["", ".end", ""])

    output_path = root / args.output_path
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(output_parts), encoding="utf-8")

    manifest = {
        "version": "actoviq.module-manifest.v1",
        "strategy": "partitioned",
        "module_count": len(manifest_modules),
        "component_count": sum(item["component_count"] for item in manifest_modules),
        "shared_nets": plan.get("shared_nets", []),
        "modules": manifest_modules,
        "composed_netlist": args.output_path.replace("\\", "/"),
    }
    manifest_path = root / args.manifest_path
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, **manifest}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
