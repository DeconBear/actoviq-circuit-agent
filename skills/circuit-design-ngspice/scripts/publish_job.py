#!/usr/bin/env python3
"""Publish a skill-generated circuit job for the Actoviq desktop GUI."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Publish a circuit job to the GUI")
    parser.add_argument("--job-root", required=True)
    parser.add_argument("--job-id", default="")
    return parser


def read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8-sig"))


def target_text(rule: object) -> str:
    if not isinstance(rule, dict):
        return str(rule)
    if "min" in rule and "max" in rule:
        return f"{rule['min']} .. {rule['max']}"
    if "min" in rule:
        return f">= {rule['min']}"
    if "max" in rule:
        return f"<= {rule['max']}"
    return str(rule.get("value", rule))


def main() -> int:
    args = build_parser().parse_args()
    root = Path(args.job_root).resolve()
    job_id = args.job_id.strip() or root.name
    required = {
        "design_final": "design/design.final.cir",
        "schematic_svg": "render/netlistsvg.svg",
        "final_summary": "reports/final-summary.md",
        "final_review": "verification/final-review.md",
    }
    missing = [relative for relative in required.values() if not (root / relative).exists()]
    if missing:
        raise SystemExit(f"cannot publish; missing artifacts: {', '.join(missing)}")

    spec = read_json(root / "planning/spec.normalized.json")
    metrics_payload = read_json(root / "verification/final-simulation/metrics.json")
    evaluation = read_json(root / "verification/final-simulation/evaluation.json")
    metrics = metrics_payload.get("metrics", metrics_payload)
    targets = spec.get("targets_eval", spec.get("targets", {}))
    failed_names = {
        str(item.get("name")) if isinstance(item, dict) else str(item)
        for item in evaluation.get("failed_metrics", [])
    }
    missing_names = {
        str(item.get("name")) if isinstance(item, dict) else str(item)
        for item in evaluation.get("missing_metrics", [])
    }
    gap_names = {
        str(item.get("name")) for item in evaluation.get("gaps", []) if isinstance(item, dict)
    }
    aliases = spec.get("metric_aliases", {})
    gui_metrics = []
    for name, rule in targets.items():
        source_name = name if name in metrics else next(
            (alias for alias in aliases.get(name, []) if alias in metrics),
            "",
        )
        measured = metrics.get(source_name) if source_name else None
        gui_metrics.append(
            {
                "name": name,
                "target": target_text(rule),
                "measured": (
                    "missing"
                    if measured is None
                    else f"{measured:.6g}"
                    if isinstance(measured, float)
                    else str(measured)
                ),
                "pass": measured is not None and name not in failed_names | missing_names | gap_names,
            }
        )

    gui_metrics_path = root / "verification/final-simulation/gui-metrics.json"
    gui_metrics_path.parent.mkdir(parents=True, exist_ok=True)
    gui_metrics_path.write_text(json.dumps(gui_metrics, indent=2) + "\n", encoding="utf-8")

    module_manifest = "design/module-manifest.json"
    manifest = {
        "version": "actoviq.job.v1",
        "job_id": job_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "completed" if evaluation.get("pass") else "failed",
        **required,
        "simulation_metrics": "verification/final-simulation/gui-metrics.json",
        "module_manifest": module_manifest if (root / module_manifest).exists() else None,
    }
    reports_dir = root / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)
    (reports_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    display = {
        "version": "actoviq.display.v1",
        "preferred_view": "schematic",
        "schematic_svg": required["schematic_svg"],
        "netlist": required["design_final"],
        "summary": required["final_summary"],
        "simulation_metrics": "verification/final-simulation/gui-metrics.json",
        "module_manifest": manifest["module_manifest"],
    }
    (reports_dir / "actoviq-display.json").write_text(
        json.dumps(display, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"ok": True, "job_id": job_id, "manifest": manifest}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
