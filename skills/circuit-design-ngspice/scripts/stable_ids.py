"""Persistent stable_id helpers for EDA round-trip identity."""

from __future__ import annotations

import uuid
from typing import Any


def new_stable_id(*parts: Any) -> str:
    seed = ":".join(str(part) for part in parts if part is not None and str(part) != "")
    if seed:
        return str(uuid.uuid5(uuid.NAMESPACE_URL, f"actoviq:stable:{seed}"))
    return str(uuid.uuid4())


def _ensure_id(target: dict[str, Any], *seed_parts: Any) -> str:
    existing = target.get("stable_id")
    if isinstance(existing, str) and existing.strip():
        return existing.strip()
    value = new_stable_id(*seed_parts)
    target["stable_id"] = value
    return value


def ensure_module_stable_ids(module: dict[str, Any]) -> dict[str, Any]:
    module_id = str(module.get("module_id", module.get("id", "module")))
    _ensure_id(module, "module", module_id)
    for port in module.get("ports", []) or []:
        if isinstance(port, dict):
            _ensure_id(port, module_id, "port", port.get("id"))
    for net in module.get("nets", []) or []:
        if isinstance(net, dict):
            _ensure_id(net, module_id, "net", net.get("id"))
    for component in module.get("components", []) or []:
        if not isinstance(component, dict):
            continue
        component_id = str(component.get("id", ""))
        _ensure_id(component, module_id, "component", component_id)
        for pin in component.get("pins", []) or []:
            if isinstance(pin, dict):
                _ensure_id(pin, module_id, component_id, "pin", pin.get("id"))
    for wire in module.get("wires", []) or []:
        if isinstance(wire, dict):
            _ensure_id(wire, module_id, "wire", wire.get("id"))
    return module


def ensure_project_stable_ids(
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    project_id = str(project.get("project_id", "project"))
    _ensure_id(project, "project", project_id)
    for module_ref in project.get("modules", []) or []:
        if isinstance(module_ref, dict):
            _ensure_id(module_ref, project_id, "module-ref", module_ref.get("id"))
            for port in module_ref.get("ports", []) or []:
                if isinstance(port, dict):
                    _ensure_id(port, project_id, module_ref.get("id"), "ref-port", port.get("id"))
    for connection in project.get("connections", []) or []:
        if isinstance(connection, dict):
            _ensure_id(connection, project_id, "connection", connection.get("id"))
    if modules:
        for module in modules.values():
            ensure_module_stable_ids(module)
    return project
