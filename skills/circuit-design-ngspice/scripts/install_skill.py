#!/usr/bin/env python3
"""Install this portable skill for Codex, Claude Code, or both."""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path


SKILL_NAME = "circuit-design-ngspice"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Install the circuit design skill")
    parser.add_argument("--agent", choices=["all", "codex", "claude"], default="all")
    parser.add_argument("--scope", choices=["user", "project"], default="user")
    parser.add_argument("--project-root", default=".", help="Project root for project installs")
    parser.add_argument("--force", action="store_true", help="Replace an installed copy")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def target_roots(agent: str, scope: str, project_root: Path) -> list[Path]:
    agents = ["codex", "claude"] if agent == "all" else [agent]
    roots: list[Path] = []
    for name in agents:
        base = Path.home() if scope == "user" else project_root
        hidden_dir = ".codex" if name == "codex" else ".claude"
        roots.append(base / hidden_dir / "skills" / SKILL_NAME)
    return roots


def ignore_file(_directory: str, names: list[str]) -> set[str]:
    ignored = {"__pycache__", ".DS_Store"}
    return {name for name in names if name in ignored or name.endswith((".pyc", ".pyo"))}


def main() -> int:
    args = build_parser().parse_args()
    source = Path(__file__).resolve().parents[1]
    project_root = Path(args.project_root).resolve()

    for target in target_roots(args.agent, args.scope, project_root):
        print(f"{source} -> {target}")
        if args.dry_run:
            continue
        if target.exists():
            if not args.force:
                raise SystemExit(f"target exists: {target}; pass --force to replace it")
            shutil.rmtree(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, target, ignore=ignore_file)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
