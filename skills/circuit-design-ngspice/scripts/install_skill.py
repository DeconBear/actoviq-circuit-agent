#!/usr/bin/env python3
"""Install this portable skill for Codex, Claude Code, or both."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path


SKILL_NAME = "circuit-design-ngspice"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Install the circuit design skill")
    parser.add_argument("--agent", choices=["all", "codex", "claude"], default="all")
    parser.add_argument("--scope", choices=["user", "project"], default="user")
    parser.add_argument("--project-root", default=".", help="Project root for project installs")
    parser.add_argument("--force", action="store_true", help="Replace an installed copy")
    parser.add_argument("--check", action="store_true", help="Check versions and installed content without copying")
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
    ignored = {"__pycache__", ".DS_Store", "parts-cache"}
    return {name for name in names if name in ignored or name.endswith((".pyc", ".pyo"))}


def content_hash(root: Path) -> str:
    digest = hashlib.sha256()
    if not root.is_dir():
        return ""
    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if any(part in {"__pycache__", "parts-cache"} for part in relative.parts):
            continue
        if path.name == ".DS_Store" or path.suffix in {".pyc", ".pyo"}:
            continue
        relative_text = relative.as_posix()
        digest.update(relative_text.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def main() -> int:
    args = build_parser().parse_args()
    source = Path(__file__).resolve().parents[1]
    project_root = Path(args.project_root).resolve()
    source_manifest = json.loads((source / "skill-version.json").read_text(encoding="utf-8"))
    source_hash = content_hash(source)
    outdated = False
    written_targets: set[Path] = set()

    for target in target_roots(args.agent, args.scope, project_root):
        effective_target = target.resolve() if target.is_symlink() else target
        installed_manifest_path = effective_target / "skill-version.json"
        installed_manifest = None
        if installed_manifest_path.exists():
            try:
                installed_manifest = json.loads(installed_manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                installed_manifest = None
        installed_hash = content_hash(effective_target)
        current = bool(
            installed_manifest
            and installed_manifest.get("skill_version") == source_manifest.get("skill_version")
            and installed_manifest.get("protocol_version") == source_manifest.get("protocol_version")
            and installed_hash == source_hash
        )
        print(json.dumps({
            "source": str(source),
            "target": str(target),
            "effective_target": str(effective_target),
            "status": "current" if current else "outdated" if effective_target.exists() else "missing",
            "source_version": source_manifest.get("skill_version"),
            "installed_version": (installed_manifest or {}).get("skill_version"),
            "protocol_version": source_manifest.get("protocol_version"),
            "source_content_hash": source_hash,
            "installed_content_hash": installed_hash,
        }))
        outdated = outdated or not current
        if args.check:
            continue
        if args.dry_run:
            continue
        normalized_target = effective_target.resolve()
        if normalized_target in written_targets:
            continue
        written_targets.add(normalized_target)
        if effective_target.exists():
            if not args.force:
                raise SystemExit(f"target exists: {target}; pass --force to replace it")
            shutil.rmtree(effective_target)
        effective_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, effective_target, ignore=ignore_file)
    return 1 if args.check and outdated else 0


if __name__ == "__main__":
    raise SystemExit(main())
