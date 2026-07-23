"""Project kind gates for simulation / pcb_schematic / analog_ic."""

from __future__ import annotations

from typing import Any, Iterable

PROJECT_KINDS = ("simulation", "pcb_schematic", "analog_ic")
DEFAULT_PROJECT_KIND = "simulation"

# Desktop module model always allows these; simulation netlist gate is stricter.
BASE_COMPONENT_TYPES = {"R", "C", "L", "D", "Q", "M", "V", "I", "BLOCK"}
PCB_COMPONENT_TYPES = BASE_COMPONENT_TYPES | {"U", "X", "E"}
IC_COMPONENT_TYPES = PCB_COMPONENT_TYPES | {"F", "G", "H", "B"}  # controlled / behavioral IC macros

SIM_NETLIST_PREFIXES = {"R", "C", "L", "Q", "M", "D", "V", "I"}
PCB_NETLIST_PREFIXES = SIM_NETLIST_PREFIXES | {"X", "U", "E"}
IC_NETLIST_PREFIXES = PCB_NETLIST_PREFIXES | {"F", "G", "H", "B"}

FORBIDDEN_DIRECTIVES_BY_KIND = {
    "simulation": {".subckt", ".ends", ".include", ".lib"},
    "pcb_schematic": set(),  # opaque spice attachments allowed
    "analog_ic": set(),
}


def normalize_project_kind(value: Any) -> str:
    text = str(value or "").strip().casefold()
    if text in PROJECT_KINDS:
        return text
    aliases = {
        "sim": "simulation",
        "spice": "simulation",
        "pcb": "pcb_schematic",
        "pcb-schematic": "pcb_schematic",
        "schematic": "pcb_schematic",
        "ic": "analog_ic",
        "analog-ic": "analog_ic",
        "analog": "analog_ic",
    }
    if not text:
        return DEFAULT_PROJECT_KIND
    if text in aliases:
        return aliases[text]
    raise ValueError(
        f"unsupported project_kind: {value!r} (expected one of: {', '.join(PROJECT_KINDS)})"
    )


def ensure_project_kind(project: dict[str, Any]) -> str:
    raw = project.get("project_kind")
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        # Compatibility migration for projects written before project_kind was
        # introduced.  An explicit value is never silently reclassified.
        kind = DEFAULT_PROJECT_KIND
    else:
        text = str(raw).strip().casefold()
        if text not in PROJECT_KINDS:
            raise ValueError(
                f"stored project_kind must be canonical ({', '.join(PROJECT_KINDS)}): {raw!r}"
            )
        kind = text
    project["project_kind"] = kind
    return kind


def allowed_component_types(project_kind: str) -> set[str]:
    kind = normalize_project_kind(project_kind)
    if kind == "pcb_schematic":
        return set(PCB_COMPONENT_TYPES)
    if kind == "analog_ic":
        return set(IC_COMPONENT_TYPES)
    return set(BASE_COMPONENT_TYPES)


def allowed_netlist_prefixes(project_kind: str) -> set[str]:
    kind = normalize_project_kind(project_kind)
    if kind == "pcb_schematic":
        return set(PCB_NETLIST_PREFIXES)
    if kind == "analog_ic":
        return set(IC_NETLIST_PREFIXES)
    return set(SIM_NETLIST_PREFIXES)


def forbidden_directives(project_kind: str) -> set[str]:
    return set(FORBIDDEN_DIRECTIVES_BY_KIND[normalize_project_kind(project_kind)])


def requires_simulation(project_kind: str) -> bool:
    return normalize_project_kind(project_kind) in {"simulation", "analog_ic"}


def supports_lcsc_binding(project_kind: str) -> bool:
    return normalize_project_kind(project_kind) == "pcb_schematic"


def supports_eda_bridge(project_kind: str) -> bool:
    return normalize_project_kind(project_kind) == "pcb_schematic"


def supports_virtuoso_export(project_kind: str) -> bool:
    return normalize_project_kind(project_kind) == "analog_ic"


def kind_summary(project_kind: str) -> dict[str, Any]:
    kind = normalize_project_kind(project_kind)
    return {
        "project_kind": kind,
        "allowed_component_types": sorted(allowed_component_types(kind)),
        "allowed_netlist_prefixes": sorted(allowed_netlist_prefixes(kind)),
        "forbidden_directives": sorted(forbidden_directives(kind)),
        "requires_simulation": requires_simulation(kind),
        "supports_lcsc_binding": supports_lcsc_binding(kind),
        "supports_eda_bridge": supports_eda_bridge(kind),
        "supports_virtuoso_export": supports_virtuoso_export(kind),
        "default_bridges": ["kicad", "jlceda"] if supports_eda_bridge(kind) else [],
    }


def validate_component_type(component_type: str, project_kind: str) -> None:
    allowed = allowed_component_types(project_kind)
    if component_type not in allowed:
        raise ValueError(
            f"unsupported component type for project_kind={normalize_project_kind(project_kind)}: "
            f"{component_type} (allowed: {', '.join(sorted(allowed))})"
        )


def iter_kinds() -> Iterable[str]:
    return PROJECT_KINDS
