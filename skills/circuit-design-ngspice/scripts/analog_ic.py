#!/usr/bin/env python3
"""Analog-IC PDK and transistor-sizing audit for Actoviq projects."""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any


PROFILE_SCHEMA = "actoviq.analog-ic-profile.v1"
AUDIT_SCHEMA = "actoviq.analog-ic-audit.v1"
NUMBER_RE = re.compile(
    r"^([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)"
    r"(meg|[fpnumkgt])?$",
    re.IGNORECASE,
)
PARAM_REF_RE = re.compile(r"^\{?([A-Za-z_][A-Za-z0-9_]*)\}?$")
MOS_SUBCKT_RE = re.compile(r"(?:^|[_-])(?:n|p)?(?:mos|fet)(?:[_-]|$)", re.IGNORECASE)
INCLUDE_RE = re.compile(
    r"^(\s*\.(?:include|lib)\s+)(?:\"([^\"]+)\"|'([^']+)'|([^\s;]+))(.*)$",
    re.IGNORECASE,
)


def _looks_like_spice_file_path(path_text: str) -> bool:
    text = str(path_text or "").strip()
    if not text:
        return False
    if any(sep in text for sep in ("/", "\\")):
        return True
    name = Path(text).name
    return "." in name and not name.startswith(".")


def _is_lib_section_marker(directive: str, path_text: str, suffix: str) -> bool:
    """True for in-library `.lib <section>` markers, not `.lib <file> [corner]`."""
    if str(directive or "").casefold() != ".lib":
        return False
    if str(suffix or "").strip():
        return False
    return not _looks_like_spice_file_path(path_text)
SCALE = {
    "": 1.0,
    "f": 1e-15,
    "p": 1e-12,
    "n": 1e-9,
    "u": 1e-6,
    "m": 1e-3,
    "k": 1e3,
    "meg": 1e6,
    "g": 1e9,
    "t": 1e12,
}


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False
    ) as handle:
        handle.write(content)
        temp_path = Path(handle.name)
    os.replace(temp_path, path)


def validate_profile(profile: Any) -> list[dict[str, str]]:
    errors: list[dict[str, str]] = []
    if not isinstance(profile, dict):
        return [{"code": "profile_missing", "message": "analog_ic_profile is required"}]
    if profile.get("schema") != PROFILE_SCHEMA:
        errors.append({"code": "profile_schema", "message": f"profile schema must be {PROFILE_SCHEMA}"})
    if profile.get("simulator") != "ngspice":
        errors.append({"code": "profile_simulator", "message": "analog IC simulator must be ngspice"})
    pdk = profile.get("pdk")
    if not isinstance(pdk, dict):
        errors.append({"code": "profile_pdk", "message": "profile.pdk must be an object"})
    else:
        if not str(pdk.get("name") or "").strip():
            errors.append({"code": "pdk_name", "message": "profile.pdk.name is required"})
        if not str(pdk.get("model_library") or "").strip():
            errors.append({"code": "pdk_model_library", "message": "profile.pdk.model_library is required"})
        temperature = pdk.get("temperature_c")
        if temperature is not None and not isinstance(temperature, (int, float)):
            errors.append({"code": "pdk_temperature", "message": "profile.pdk.temperature_c must be numeric"})
    sizing = profile.get("sizing", {})
    if not isinstance(sizing, dict):
        errors.append({"code": "profile_sizing", "message": "profile.sizing must be an object"})
    else:
        if sizing.get("require_explicit_w_l", True) is not True:
            errors.append({
                "code": "profile_explicit_w_l_required",
                "message": "analog IC projects cannot disable explicit transistor W/L geometry",
            })
        if sizing.get("require_scale_suffix", True) is not True:
            errors.append({
                "code": "profile_scale_suffix_required",
                "message": "analog IC projects cannot disable explicit SPICE scale suffixes for W/L",
            })
    return errors


def _strip_comment(line: str) -> str:
    stripped = line.strip()
    if not stripped or stripped.startswith(("*", ";")):
        return ""
    return stripped.split(";", 1)[0].strip()


def _merged_lines(source: str) -> list[str]:
    result: list[str] = []
    current = ""
    for raw in source.splitlines():
        stripped = raw.strip()
        if stripped.startswith("+"):
            current = f"{current} {stripped[1:].strip()}".strip()
            continue
        if current:
            result.append(current)
        current = raw
    if current:
        result.append(current)
    return result


def _parameter_values(source: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in _merged_lines(source):
        line = _strip_comment(raw)
        if not line.lower().startswith(".param "):
            continue
        body = line.split(maxsplit=1)[1]
        for name, value in re.findall(r"([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\s]+)", body):
            values[name.casefold()] = value
    return values


def _parse_scalar(raw: str, parameters: dict[str, str]) -> tuple[float | None, bool, str]:
    value = raw.strip().strip("'")
    reference = PARAM_REF_RE.fullmatch(value)
    if reference and not NUMBER_RE.fullmatch(value):
        resolved = parameters.get(reference.group(1).casefold())
        if resolved is None:
            return None, False, "unresolved_parameter"
        value = resolved.strip().strip("'")
    match = NUMBER_RE.fullmatch(value)
    if not match:
        return None, False, "unsupported_expression"
    suffix = (match.group(2) or "").casefold()
    numeric = float(match.group(1)) * SCALE[suffix]
    return numeric, bool(suffix), ""


def _assignments(tokens: list[str]) -> dict[str, str]:
    values: dict[str, str] = {}
    for token in tokens:
        if "=" not in token:
            continue
        key, value = token.split("=", 1)
        values[key.strip().casefold()] = value.strip()
    return values


def _safe_project_child(project_root: Path, *parts: str) -> Path:
    root = project_root.resolve()
    candidate = root.joinpath(*parts).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"path escapes project root: {candidate}") from exc
    return candidate


def _sanitize_spice_token(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]+", "_", value).strip("_") or "node"


def _compiled_component_reference(module_id: str, component: dict[str, Any]) -> str:
    component_type = str(component.get("type") or "").upper()
    raw_name = str(component.get("name") or component.get("id") or "component")
    name = _sanitize_spice_token(f"{module_id}_{raw_name}")
    return name if name.upper().startswith(component_type) else f"{component_type}{name}"


def _include_records(source: str, project_root: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line_number, raw in enumerate(source.splitlines(), start=1):
        line = _strip_comment(raw)
        match = INCLUDE_RE.match(line)
        if not match:
            continue
        directive = match.group(1).strip().split()[0].casefold()
        path_text = next((value for value in match.groups()[1:4] if value is not None), "")
        suffix = match.group(5).strip()
        # Skip `.lib tt` / `.lib section` markers inside PDK libraries; those are
        # section selectors, not nested file includes.
        if _is_lib_section_marker(directive, path_text, suffix):
            continue
        expanded = Path(os.path.expandvars(os.path.expanduser(path_text)))
        resolved = (expanded if expanded.is_absolute() else project_root / expanded).resolve()
        records.append({
            "line": line_number,
            "directive": directive,
            "path": path_text,
            "resolved": resolved,
            "suffix": suffix,
        })
    return records


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _audit_include_tree(
    source: str,
    base_dir: Path,
    project_root: Path,
    trusted_pdk_root: Path | None,
    module_id: str,
    errors: list[dict[str, Any]],
    *,
    visited: set[Path] | None = None,
    depth: int = 0,
) -> list[dict[str, Any]]:
    """Validate project-authored include trees; external configured PDK files are trusted inputs."""
    seen = visited if visited is not None else set()
    records: list[dict[str, Any]] = []
    if depth > 32:
        _diagnostic(
            errors,
            "include_depth_exceeded",
            "project-local SPICE include depth exceeds the safety limit",
            module_id=module_id,
        )
        return records
    for include in _include_records(source, base_dir):
        records.append(include)
        included_path = Path(include["resolved"]).resolve()
        if not included_path.is_file():
            _diagnostic(
                errors,
                "included_model_missing",
                f"SPICE model include does not exist: {included_path}",
                module_id=module_id,
                line=include["line"],
            )
            continue
        inside_project = _is_within(included_path, project_root)
        inside_pdk = trusted_pdk_root is not None and _is_within(included_path, trusted_pdk_root)
        if not inside_project and not inside_pdk:
            _diagnostic(
                errors,
                "model_include_outside_pdk_root",
                f"SPICE model include is outside the project and configured PDK roots: {included_path}",
                module_id=module_id,
                line=include["line"],
            )
            continue
        if not inside_project or included_path in seen:
            continue
        seen.add(included_path)
        try:
            nested_source = included_path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            _diagnostic(
                errors,
                "included_model_unreadable",
                f"project-local SPICE include cannot be safety-audited: {included_path} ({exc})",
                module_id=module_id,
                line=include["line"],
            )
            continue
        if re.search(r"(?im)^\s*\.(?:control|endc)\b", nested_source):
            _diagnostic(
                errors,
                "unsafe_included_control_block",
                f"project-local include contains a forbidden .control/.endc block: {included_path}",
                module_id=module_id,
                line=include["line"],
            )
        records.extend(
            _audit_include_tree(
                nested_source,
                included_path.parent,
                project_root,
                trusted_pdk_root,
                module_id,
                errors,
                visited=seen,
                depth=depth + 1,
            )
        )
    return records


def rewrite_model_paths(source: str, project_root: Path) -> str:
    """Make top-level .include/.lib paths stable from ngspice's temp cwd."""
    rewritten: list[str] = []
    for raw in source.splitlines():
        match = INCLUDE_RE.match(raw)
        if not match:
            rewritten.append(raw)
            continue
        directive = match.group(1).strip().split()[0].casefold()
        path_text = next((value for value in match.groups()[1:4] if value is not None), "")
        suffix = match.group(5)
        if _is_lib_section_marker(directive, path_text, suffix):
            rewritten.append(raw)
            continue
        expanded = Path(os.path.expandvars(os.path.expanduser(path_text)))
        resolved = (expanded if expanded.is_absolute() else project_root / expanded).resolve()
        rewritten.append(f'{match.group(1)}"{resolved.as_posix()}"{suffix}')
    trailing_newline = "\n" if source.endswith(("\n", "\r")) else ""
    return "\n".join(rewritten) + trailing_newline


def extract_mos_devices(source: str) -> list[dict[str, Any]]:
    devices: list[dict[str, Any]] = []
    for raw in _merged_lines(source):
        line = _strip_comment(raw)
        if not line or line.startswith("."):
            continue
        tokens = line.split()
        if not tokens:
            continue
        prefix = tokens[0][:1].upper()
        if prefix == "M" and len(tokens) >= 6:
            devices.append({
                "reference": tokens[0],
                "kind": "mos_primitive",
                "model": tokens[5],
                "parameters": _assignments(tokens[6:]),
            })
            continue
        if prefix != "X" or len(tokens) < 3:
            continue
        first_assignment = next((index for index, token in enumerate(tokens[1:], start=1) if "=" in token), len(tokens))
        if first_assignment < 2:
            continue
        model_index = first_assignment - 1
        if tokens[model_index].casefold() == "params:" and model_index > 1:
            model_index -= 1
        model = tokens[model_index]
        assignments = _assignments(tokens[first_assignment:])
        if not ({"w", "l"} & assignments.keys()) and not MOS_SUBCKT_RE.search(model):
            continue
        devices.append({
            "reference": tokens[0],
            "kind": "mos_subcircuit",
            "model": model,
            "parameters": assignments,
        })
    return devices


def extract_structured_mos_devices(module_id: str, module: dict[str, Any]) -> list[dict[str, Any]]:
    devices: list[dict[str, Any]] = []
    for component in module.get("components", []):
        if not isinstance(component, dict):
            continue
        component_type = str(component.get("type") or "").upper()
        if component_type not in {"M", "X"}:
            continue
        value_tokens = str(component.get("value") or "").split()
        if not value_tokens:
            continue
        assignments = _assignments(value_tokens[1:])
        model = value_tokens[0]
        if component_type == "X" and not ({"w", "l"} & assignments.keys()) and not MOS_SUBCKT_RE.search(model):
            continue
        reference = str(component.get("name") or component.get("id") or "")
        compiled_reference = _compiled_component_reference(module_id, component)
        devices.append({
            "reference": reference,
            "compiled_reference": compiled_reference,
            "identity": str(component.get("stable_id") or component.get("id") or reference),
            "aliases": list(dict.fromkeys([reference.casefold(), compiled_reference.casefold()])),
            "kind": "mos_primitive" if component_type == "M" else "mos_subcircuit",
            "model": model,
            "parameters": assignments,
        })
    return devices


def extract_notebook_netlist(markdown: str) -> str:
    blocks = re.findall(r"```(?:spice|cir|netlist)\s*\n(.*?)```", markdown, flags=re.IGNORECASE | re.DOTALL)
    return "\n".join(block.strip() for block in blocks if block.strip())


def _diagnostic(target: list[dict[str, Any]], code: str, message: str, **location: Any) -> None:
    target.append({"code": code, "message": message, **location})


def audit_project(
    project_root: Path,
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    profile_errors = validate_profile(project.get("analog_ic_profile"))
    errors = list(profile_errors)
    warnings: list[dict[str, Any]] = []
    device_rows: list[dict[str, Any]] = []
    if str(project.get("project_kind") or "simulation") != "analog_ic":
        _diagnostic(errors, "wrong_project_kind", "analog IC audit requires project_kind=analog_ic")

    profile = project.get("analog_ic_profile") if isinstance(project.get("analog_ic_profile"), dict) else {}
    pdk = profile.get("pdk") if isinstance(profile.get("pdk"), dict) else {}
    sizing = profile.get("sizing") if isinstance(profile.get("sizing"), dict) else {}
    require_w_l = True
    require_suffix = True

    model_library = str(pdk.get("model_library") or "").strip()
    resolved_model: Path | None = None
    if model_library:
        expanded = Path(os.path.expandvars(os.path.expanduser(model_library)))
        resolved_model = (expanded if expanded.is_absolute() else project_root / expanded).resolve()
        if not resolved_model.exists():
            _diagnostic(
                errors,
                "model_library_missing",
                f"PDK model library does not exist: {resolved_model}",
            )
    model_reference_found = False
    corner_reference_found = False
    combined_sources: list[str] = []
    for module_id, module in modules.items():
        spice = module.get("spice") if isinstance(module.get("spice"), dict) else {}
        stored_source = str(spice.get("source") or "")
        notebook_path = _safe_project_child(project_root, "modules", str(module_id), "netlist-notebook.md")
        if notebook_path.is_file():
            source = extract_notebook_netlist(notebook_path.read_text(encoding="utf-8"))
            if stored_source.strip() and source.strip() != stored_source.strip():
                _diagnostic(
                    errors,
                    "notebook_source_mismatch",
                    "module spice.source does not match the netlist notebook used by compile",
                    module_id=module_id,
                )
        else:
            source = ""
            if stored_source.strip():
                _diagnostic(
                    errors,
                    "notebook_missing",
                    "analog IC module has preserved SPICE but no netlist notebook for compile",
                    module_id=module_id,
                )
        combined_sources.append(source)
        if re.search(r"(?im)^\s*\.(?:control|endc)\b", source):
            _diagnostic(
                errors,
                "unsafe_control_block",
                "user-authored .control/.endc blocks are not allowed; use declared analyses or .actoviq directives",
                module_id=module_id,
            )
        if re.search(r"(?im)^\s*\.subckt\b", source):
            _diagnostic(
                errors,
                "embedded_subcircuit_scope_unsupported",
                "editable analog notebooks currently support one flat scope per Actoviq module; "
                "place reusable subcircuits in the configured PDK/model library and instantiate them with X",
                module_id=module_id,
            )
        include_records = _audit_include_tree(
            source,
            project_root,
            project_root,
            resolved_model.parent if resolved_model is not None else None,
            str(module_id),
            errors,
        )
        for include in include_records:
            included_path = Path(include["resolved"]).resolve()
            if resolved_model is not None and included_path == resolved_model:
                model_reference_found = True
                suffix_tokens = {token.casefold() for token in str(include["suffix"]).split()}
                if str(pdk.get("corner") or "").strip().casefold() in suffix_tokens:
                    corner_reference_found = True
        parameters = _parameter_values(source)
        source_devices = extract_mos_devices(source)
        structured_devices = extract_structured_mos_devices(str(module_id), module)
        source_by_reference: dict[str, dict[str, Any]] = {}
        for source_device in source_devices:
            key = str(source_device["reference"]).casefold()
            if key in source_by_reference:
                _diagnostic(
                    errors,
                    "duplicate_spice_reference",
                    f"duplicate SPICE instance reference: {source_device['reference']}",
                    module_id=module_id,
                    component=source_device["reference"],
                )
            else:
                source_by_reference[key] = source_device
        alias_owner: dict[str, str] = {}
        for structured in structured_devices:
            for alias in structured["aliases"]:
                owner = alias_owner.get(alias)
                if owner is not None and owner != structured["identity"]:
                    _diagnostic(
                        errors,
                        "structured_reference_collision",
                        f"structured MOS references collide after SPICE name normalization: {alias}",
                        module_id=module_id,
                        component=structured["identity"],
                    )
                else:
                    alias_owner[alias] = structured["identity"]
        matched_source_references: set[str] = set()
        structured_identity_by_source: dict[str, str] = {}
        for structured in structured_devices:
            matched = {
                alias: source_by_reference[alias]
                for alias in structured["aliases"]
                if alias in source_by_reference
            }
            matched_keys = list(dict.fromkeys(matched))
            if len(matched_keys) > 1:
                _diagnostic(
                    errors,
                    "ambiguous_structured_reference",
                    f"both source and compiled aliases exist for structured MOS {structured['reference']}",
                    module_id=module_id,
                    component=structured["identity"],
                )
                source_device = None
            else:
                source_device = matched[matched_keys[0]] if matched_keys else None
            if source_device is None:
                if notebook_path.is_file():
                    _diagnostic(
                        errors,
                        "structured_source_mismatch",
                        f"structured MOS {structured['reference']} is absent from the simulation notebook",
                        module_id=module_id,
                        component=structured["identity"],
                    )
                continue
            source_key = str(source_device["reference"]).casefold()
            matched_source_references.add(source_key)
            structured_identity_by_source[source_key] = structured["identity"]
            structured_signature = {
                "model": str(structured["model"]).casefold(),
                **{key: str(value).casefold() for key, value in structured["parameters"].items() if key in {"w", "l", "m", "nf"}},
            }
            source_signature = {
                "model": str(source_device["model"]).casefold(),
                **{key: str(value).casefold() for key, value in source_device["parameters"].items() if key in {"w", "l", "m", "nf"}},
            }
            if structured_signature != source_signature:
                _diagnostic(
                    errors,
                    "structured_source_mismatch",
                    f"structured MOS sizing differs from the simulation notebook: {structured['reference']}",
                    module_id=module_id,
                    component=structured["identity"],
                )
        if structured_devices:
            for source_device in source_devices:
                source_key = str(source_device["reference"]).casefold()
                if source_key not in matched_source_references:
                    _diagnostic(
                        errors,
                        "source_without_structured_device",
                        f"simulation notebook MOS is absent from structured module data: {source_device['reference']}",
                        module_id=module_id,
                        component=source_device["reference"],
                    )
        audited_devices = source_devices if notebook_path.is_file() else structured_devices
        for device in audited_devices:
            assignments = dict(device.get("parameters") or {})
            row = {
                "module_id": module_id,
                **{key: value for key, value in device.items() if key not in {"parameters", "aliases"}},
                "assignments": assignments,
            }
            structured_identity = structured_identity_by_source.get(str(device["reference"]).casefold())
            if structured_identity:
                row["structured_id"] = structured_identity
            width_raw = assignments.get("w")
            length_raw = assignments.get("l")
            for field, raw_value in (("w", width_raw), ("l", length_raw)):
                if raw_value is None:
                    if require_w_l:
                        _diagnostic(
                            errors,
                            f"missing_{field}",
                            f"{device['reference']} requires explicit {field.upper()} geometry",
                            module_id=module_id,
                            component=device["reference"],
                        )
                    continue
                numeric, has_suffix, reason = _parse_scalar(raw_value, parameters)
                row[f"{field}_m"] = numeric
                if reason:
                    _diagnostic(
                        errors,
                        f"invalid_{field}",
                        f"{device['reference']} {field.upper()} cannot be resolved: {raw_value}",
                        module_id=module_id,
                        component=device["reference"],
                    )
                elif numeric is None or numeric <= 0:
                    _diagnostic(
                        errors,
                        f"nonpositive_{field}",
                        f"{device['reference']} {field.upper()} must be positive",
                        module_id=module_id,
                        component=device["reference"],
                    )
                elif require_suffix and not has_suffix:
                    _diagnostic(
                        errors,
                        f"missing_scale_suffix_{field}",
                        f"{device['reference']} {field.upper()} must use an explicit SPICE scale suffix",
                        module_id=module_id,
                        component=device["reference"],
                    )
            width = row.get("w_m")
            length = row.get("l_m")
            if isinstance(width, (int, float)) and isinstance(length, (int, float)) and length > 0:
                row["w_over_l"] = width / length
            for count_name in ("m", "nf"):
                raw_count = assignments.get(count_name)
                if raw_count is None:
                    continue
                count_value, _, reason = _parse_scalar(raw_count, parameters)
                invalid_integer = count_name == "nf" and count_value is not None and not float(count_value).is_integer()
                if reason or count_value is None or count_value <= 0 or invalid_integer:
                    _diagnostic(
                        errors,
                        f"invalid_{count_name}",
                        f"{device['reference']} {count_name.upper()} must be a positive"
                        + (" integer" if count_name == "nf" else " scalar"),
                        module_id=module_id,
                        component=device["reference"],
                    )
                else:
                    row[count_name] = count_value
            device_rows.append(row)

    combined_source = "\n".join(combined_sources)
    if not device_rows:
        _diagnostic(errors, "no_mos_devices", "analog IC project contains no auditable MOS devices")
    if resolved_model is not None and resolved_model.exists() and not model_reference_found:
        _diagnostic(
            errors,
            "model_library_not_referenced",
            f"module SPICE does not reference configured model library {resolved_model.name}",
        )
    corner = str(pdk.get("corner") or "").strip()
    if corner and model_library and not corner_reference_found:
        _diagnostic(errors, "corner_not_selected", f"configured PDK corner is not selected by .lib: {corner}")
    temperature = pdk.get("temperature_c")
    if temperature is not None and not re.search(r"(?im)^\s*\.temp\b", combined_source):
        _diagnostic(
            warnings,
            "temperature_not_declared",
            "profile temperature is metadata only until a matching .temp directive is present",
        )

    return {
        "schema": AUDIT_SCHEMA,
        "ok": not errors,
        "project_id": str(project.get("project_id") or ""),
        "source_revision": int(project.get("revision", 0)),
        "profile": profile if not profile_errors else None,
        "model_library_resolved": str(resolved_model.resolve()) if resolved_model and resolved_model.exists() else "",
        "devices": device_rows,
        "errors": errors,
        "warnings": warnings,
        "summary": {
            "module_count": len(modules),
            "mos_device_count": len(device_rows),
            "error_count": len(errors),
            "warning_count": len(warnings),
        },
    }


def load_project(project_root: Path) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    project = json.loads(_safe_project_child(project_root, "project.circuit.json").read_text(encoding="utf-8"))
    modules: dict[str, dict[str, Any]] = {}
    for module_ref in project.get("modules", []):
        module_id = str(module_ref.get("id") or "")
        if not module_id:
            continue
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", module_id):
            raise ValueError(f"invalid module id in project: {module_id!r}")
        path = _safe_project_child(project_root, "modules", module_id, "module.circuit.json")
        modules[module_id] = json.loads(path.read_text(encoding="utf-8"))
    return project, modules


def run_audit(project_root: Path, output_path: Path | None = None) -> dict[str, Any]:
    project, modules = load_project(project_root)
    result = audit_project(project_root, project, modules)
    if output_path is not None:
        atomic_write_json(output_path, result)
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Audit an Actoviq analog-IC project")
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--output-path", default="")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    root = Path(args.project_root).resolve()
    output = Path(args.output_path).resolve() if args.output_path else root / "build" / "analog-ic" / "audit.json"
    try:
        result = run_audit(root, output)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        result = {
            "schema": AUDIT_SCHEMA,
            "ok": False,
            "project_id": "",
            "source_revision": 0,
            "profile": None,
            "model_library_resolved": "",
            "devices": [],
            "errors": [{"code": "audit_failed", "message": str(exc)}],
            "warnings": [],
            "summary": {
                "module_count": 0,
                "mos_device_count": 0,
                "error_count": 1,
                "warning_count": 0,
            },
        }
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
