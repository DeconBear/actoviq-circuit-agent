#!/usr/bin/env python3
"""Resolve Actoviq desktop workspaces the same way the Electron GUI does.

Config file (shared with GUI):
  ~/.actoviq/actoviq-circuit-agent-workspaces.json

Default workspace root when no config exists:
  <repo>/workspace/workspaces/default

Environment overrides:
  ACTOVIQ_CIRCUIT_AGENT_WORKSPACE_ROOT  -> treat as the active workspace root
  ACTOVIQ_E2E_WORKSPACE_ROOT            -> same, for Playwright/e2e
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


WORKSPACE_CONFIG_NAME = "actoviq-circuit-agent-workspaces.json"
WORKSPACE_MARKER_NAME = ".actoviq-workspace.json"
WORKSPACE_ROOT_ENV = "ACTOVIQ_CIRCUIT_AGENT_WORKSPACE_ROOT"
E2E_WORKSPACE_ROOT_ENV = "ACTOVIQ_E2E_WORKSPACE_ROOT"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")[:48]
    return slug or "workspace"


def repo_root() -> Path:
    # scripts/ -> circuit-design-ngspice/ -> skills/ -> repo
    return Path(__file__).resolve().parents[3]


def settings_dir() -> Path:
    return Path.home() / ".actoviq"


def workspace_config_path() -> Path:
    return settings_dir() / WORKSPACE_CONFIG_NAME


def default_workspace_root() -> Path:
    e2e = os.environ.get(E2E_WORKSPACE_ROOT_ENV, "").strip()
    if e2e:
        return Path(e2e).expanduser().resolve()
    override = os.environ.get(WORKSPACE_ROOT_ENV, "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return (repo_root() / "workspace" / "workspaces" / "default").resolve()


def build_workspace(
    workspace_id: str,
    name: str,
    root: str | Path,
    created_at: str | None = None,
    last_opened_at: str | None = None,
) -> dict[str, Any]:
    normalized = Path(root).expanduser().resolve()
    stamp = created_at or utc_now()
    return {
        "id": workspace_id,
        "name": name,
        "root": str(normalized),
        "jobsDir": str(normalized / "jobs"),
        "projectsDir": str(normalized / "projects"),
        "referencesDir": str(normalized / "references"),
        "createdAt": stamp,
        "lastOpenedAt": last_opened_at or stamp,
    }


def ensure_workspace_dirs(workspace: dict[str, Any]) -> dict[str, Any]:
    root = Path(workspace["root"])
    projects = Path(workspace["projectsDir"])
    jobs = Path(workspace["jobsDir"])
    references = Path(workspace["referencesDir"])
    for path in (root, projects, jobs, references):
        path.mkdir(parents=True, exist_ok=True)
    marker = root / WORKSPACE_MARKER_NAME
    if not marker.exists():
        marker.write_text(
            json.dumps(
                {
                    "version": "actoviq.workspace.v1",
                    "id": workspace["id"],
                    "name": workspace["name"],
                    "jobsDir": "jobs",
                    "projectsDir": "projects",
                    "referencesDir": "references",
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
    return workspace


def _env_override_workspace() -> dict[str, Any] | None:
    for env_name in (E2E_WORKSPACE_ROOT_ENV, WORKSPACE_ROOT_ENV):
        value = os.environ.get(env_name, "").strip()
        if value:
            root = Path(value).expanduser().resolve()
            return ensure_workspace_dirs(
                build_workspace("env-override", f"Env ({env_name})", root)
            )
    return None


def read_workspace_config(*, persist_default: bool = False) -> dict[str, Any]:
    override = _env_override_workspace()
    if override is not None:
        return {
            "activeWorkspaceId": override["id"],
            "workspaces": [override],
            "source": "env",
            "config_path": str(workspace_config_path()),
        }

    path = workspace_config_path()
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
        workspaces_raw = parsed.get("workspaces")
        if isinstance(workspaces_raw, list) and workspaces_raw:
            workspaces = [
                build_workspace(
                    str(item.get("id") or "workspace"),
                    str(item.get("name") or item.get("id") or "Workspace"),
                    item.get("root") or default_workspace_root(),
                    item.get("createdAt"),
                    item.get("lastOpenedAt"),
                )
                for item in workspaces_raw
                if isinstance(item, dict) and item.get("root")
            ]
            if workspaces:
                active_id = str(parsed.get("activeWorkspaceId") or workspaces[0]["id"])
                if not any(item["id"] == active_id for item in workspaces):
                    active_id = workspaces[0]["id"]
                return {
                    "activeWorkspaceId": active_id,
                    "workspaces": workspaces,
                    "source": "config",
                    "config_path": str(path),
                }
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        pass

    workspace = build_workspace("default", "Default Workspace", default_workspace_root())
    config = {
        "activeWorkspaceId": workspace["id"],
        "workspaces": [workspace],
        "source": "default",
        "config_path": str(path),
    }
    if persist_default:
        write_workspace_config(config)
    return config


def write_workspace_config(config: dict[str, Any]) -> dict[str, Any]:
    settings_dir().mkdir(parents=True, exist_ok=True)
    workspaces = [ensure_workspace_dirs(item) for item in config["workspaces"]]
    payload = {
        "activeWorkspaceId": config["activeWorkspaceId"],
        "workspaces": workspaces,
    }
    path = workspace_config_path()
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return {
        **payload,
        "source": "config",
        "config_path": str(path),
    }


def list_workspaces(*, ensure: bool = True) -> dict[str, Any]:
    config = read_workspace_config(persist_default=True)
    if ensure:
        config["workspaces"] = [ensure_workspace_dirs(item) for item in config["workspaces"]]
    active_id = config["activeWorkspaceId"]
    return {
        "ok": True,
        "config_path": config["config_path"],
        "source": config["source"],
        "active_workspace_id": active_id,
        "workspaces": [
            {
                **item,
                "active": item["id"] == active_id,
            }
            for item in config["workspaces"]
        ],
    }


def get_active_workspace(*, ensure: bool = True) -> dict[str, Any]:
    config = read_workspace_config(persist_default=True)
    active = next(
        (item for item in config["workspaces"] if item["id"] == config["activeWorkspaceId"]),
        config["workspaces"][0],
    )
    if ensure:
        active = ensure_workspace_dirs(active)
    return {
        "ok": True,
        "config_path": config["config_path"],
        "source": config["source"],
        "workspace": active,
        "projects_root": active["projectsDir"],
        "jobs_dir": active["jobsDir"],
        "references_dir": active["referencesDir"],
        "workspace_root": active["root"],
    }


def select_workspace(workspace_id: str) -> dict[str, Any]:
    if _env_override_workspace() is not None:
        raise ValueError(
            f"{WORKSPACE_ROOT_ENV} or {E2E_WORKSPACE_ROOT_ENV} is set; "
            "unset it before selecting a workspace from config."
        )
    config = read_workspace_config(persist_default=True)
    match = next((item for item in config["workspaces"] if item["id"] == workspace_id), None)
    if match is None:
        known = ", ".join(item["id"] for item in config["workspaces"]) or "(none)"
        raise ValueError(f"Workspace not found: {workspace_id}. Known: {known}")
    match["lastOpenedAt"] = utc_now()
    config["activeWorkspaceId"] = workspace_id
    config["workspaces"] = [
        match if item["id"] == workspace_id else item for item in config["workspaces"]
    ]
    write_workspace_config(config)
    return get_active_workspace()


def resolve_projects_root(
    *,
    projects_root: str | None = None,
    workspace_id: str | None = None,
) -> dict[str, Any]:
    """Resolve where new projects should be created.

    Priority:
      1. explicit --projects-root
      2. --workspace-id (that workspace's projectsDir; does not change active)
      3. active GUI/env workspace projectsDir
    """
    if projects_root and str(projects_root).strip():
        root = Path(projects_root).expanduser().resolve()
        root.mkdir(parents=True, exist_ok=True)
        return {
            "ok": True,
            "projects_root": str(root),
            "source": "projects-root",
            "workspace": None,
        }

    if workspace_id and str(workspace_id).strip():
        config = read_workspace_config(persist_default=True)
        match = next(
            (item for item in config["workspaces"] if item["id"] == workspace_id),
            None,
        )
        if match is None:
            known = ", ".join(item["id"] for item in config["workspaces"]) or "(none)"
            raise ValueError(f"Workspace not found: {workspace_id}. Known: {known}")
        match = ensure_workspace_dirs(match)
        return {
            "ok": True,
            "projects_root": match["projectsDir"],
            "source": "workspace-id",
            "workspace": match,
        }

    active = get_active_workspace()
    return {
        "ok": True,
        "projects_root": active["projects_root"],
        "source": "active-workspace",
        "workspace": active["workspace"],
        "config_path": active["config_path"],
    }
