#!/usr/bin/env python3
"""Validate module boundaries before composing a large flat SPICE design."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path


NODE_COUNTS = {"R": 2, "C": 2, "L": 2, "D": 2, "V": 2, "I": 2, "Q": 3, "M": 4}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate partitioned module interfaces")
    parser.add_argument("--job-root", required=True)
    parser.add_argument("--module-plan-path", default="planning/module-plan.json")
    parser.add_argument("--output-path", default="verification/module-interface-check.json")
    parser.add_argument("--require-partitioned", action="store_true")
    parser.add_argument("--max-components-per-module", type=int, default=16)
    return parser


def parse_components(path: Path) -> tuple[list[str], set[str]]:
    names: list[str] = []
    nodes: set[str] = set()
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith(("*", ";", ".")):
            continue
        tokens = line.split()
        node_count = NODE_COUNTS.get(tokens[0][0].upper())
        if node_count is None or len(tokens) < node_count + 2:
            continue
        names.append(tokens[0])
        nodes.update(tokens[1 : 1 + node_count])
    return names, nodes


def main() -> int:
    args = build_parser().parse_args()
    root = Path(args.job_root).resolve()
    plan = json.loads((root / args.module_plan_path).read_text(encoding="utf-8-sig"))
    modules = plan.get("modules", [])
    violations: list[dict] = []
    reports = []
    all_names: list[str] = []

    if args.require_partitioned and plan.get("strategy") != "partitioned":
        violations.append({"kind": "strategy", "message": "partitioned strategy is required"})
    if plan.get("strategy") == "partitioned" and len(modules) < 2:
        violations.append({"kind": "module_count", "message": "at least two modules are required"})

    shared_nets = set(plan.get("shared_nets", [])) | {"0"}
    producer = Counter()
    consumer = Counter()
    for module in modules:
        name = module.get("name", "unnamed")
        module_path = root / module.get("file", "")
        if not module_path.exists():
            violations.append({"kind": "missing_module", "module": name, "message": str(module_path)})
            continue
        component_names, nodes = parse_components(module_path)
        all_names.extend(component_names)
        input_nets = set(module.get("input_nets", []))
        output_nets = set(module.get("output_nets", []))
        prefix = str(module.get("local_net_prefix", ""))
        for net in input_nets:
            consumer[net] += 1
        for net in output_nets:
            producer[net] += 1
        for net in sorted(input_nets | output_nets):
            if net not in nodes:
                violations.append({"kind": "missing_interface_net", "module": name, "net": net})
        boundary_nets = shared_nets | input_nets | output_nets
        invalid_local = sorted(
            net for net in nodes if net not in boundary_nets and prefix and not net.startswith(prefix)
        )
        if invalid_local:
            violations.append({"kind": "local_net_prefix", "module": name, "nets": invalid_local})
        if len(component_names) > args.max_components_per_module:
            violations.append(
                {
                    "kind": "module_too_large",
                    "module": name,
                    "component_count": len(component_names),
                    "max": args.max_components_per_module,
                }
            )
        declared = set(module.get("component_names", []))
        if declared and declared != set(component_names):
            violations.append(
                {
                    "kind": "component_manifest_mismatch",
                    "module": name,
                    "missing": sorted(declared - set(component_names)),
                    "unexpected": sorted(set(component_names) - declared),
                }
            )
        reports.append(
            {
                "name": name,
                "file": module.get("file"),
                "component_count": len(component_names),
                "nodes": sorted(nodes),
            }
        )

    for component, count in Counter(all_names).items():
        if count > 1:
            violations.append({"kind": "duplicate_component", "component": component, "count": count})

    top_inputs = set(plan.get("top_level_input_nets", []))
    top_outputs = set(plan.get("top_level_output_nets", []))
    for net in sorted((set(producer) | set(consumer)) - shared_nets - top_inputs - top_outputs):
        if producer[net] != 1 or consumer[net] < 1:
            violations.append(
                {
                    "kind": "unbalanced_interface",
                    "net": net,
                    "producers": producer[net],
                    "consumers": consumer[net],
                }
            )

    result = {
        "ok": not violations,
        "strategy": plan.get("strategy"),
        "module_count": len(modules),
        "component_count": len(all_names),
        "modules": reports,
        "violations": violations,
    }
    output_path = root / args.output_path
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
