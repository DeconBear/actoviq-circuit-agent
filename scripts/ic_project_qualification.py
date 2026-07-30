#!/usr/bin/env python3
"""Verify and archive evidence for a real hierarchical IC design run."""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SKILL_SCRIPTS = ROOT / "skills" / "circuit-design-ngspice" / "scripts"
sys.path.insert(0, str(SKILL_SCRIPTS))

from circuit_project import project_document_hash  # noqa: E402
from eda_export import connectivity_hash  # noqa: E402
from module_hierarchy import ordered_connectivity_hash  # noqa: E402
from verification_contracts import (  # noqa: E402
    validate_simulation_run,
    validate_verification_run,
)
from xschem_bridge import module_hash as xschem_module_hash  # noqa: E402


REQUIRED_TOOLS = ("ngspice", "xyce", "openvaf", "xschem")


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected a JSON object: {path}")
    return value


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical_hash(value: Any) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def load_project(project_root: Path) -> tuple[dict[str, Any], dict[str, dict[str, Any]], dict[str, Path]]:
    project_path = project_root / "project.circuit.json"
    project = read_json(project_path)
    modules: dict[str, dict[str, Any]] = {}
    paths: dict[str, Path] = {}
    for module_ref in project.get("modules", []):
        module_id = str(module_ref.get("id") or "")
        source = str(module_ref.get("source") or f"modules/{module_id}/module.circuit.json")
        source_path = (project_root / source).resolve()
        try:
            source_path.relative_to(project_root)
        except ValueError as error:
            raise ValueError(f"module source escapes project root: {source}") from error
        modules[module_id] = read_json(source_path)
        paths[module_id] = source_path
    if not modules:
        raise ValueError("qualification project has no modules")
    return project, modules, paths


def unwrap_installation(value: dict[str, Any]) -> dict[str, Any]:
    installation = value.get("installation")
    return installation if isinstance(installation, dict) else value


def environment_state(allow_fixture: bool) -> dict[str, Any]:
    release = platform.release()
    wsl = "microsoft" in release.casefold() or "wsl" in release.casefold()
    native_linux = sys.platform.startswith("linux") and not wsl
    try:
        os_release = platform.freedesktop_os_release() if native_linux else {}
    except OSError:
        os_release = {}
    return {
        "platform": sys.platform,
        "release": release,
        "distribution": str(os_release.get("ID") or ""),
        "distribution_version": str(os_release.get("VERSION_ID") or ""),
        "native_linux": native_linux,
        "wsl": wsl,
        "eligible": native_linux or allow_fixture,
    }


def gate(gate_id: str, passed: bool, *diagnostics: str, blocked: bool = False) -> dict[str, Any]:
    return {
        "id": gate_id,
        "status": "passed" if passed else "blocked" if blocked else "failed",
        "diagnostics": [message for message in diagnostics if message],
    }


def has_waveform(run: dict[str, Any]) -> bool:
    for analysis in run.get("analyses", []):
        if not isinstance(analysis, dict):
            continue
        tables = analysis.get("tables")
        if not isinstance(tables, dict):
            continue
        for table in tables.values():
            if not isinstance(table, dict):
                continue
            if any(isinstance(values, list) and len(values) >= 2 for values in table.values()):
                return True
    return False


def tool_record_matches_environment(
    tool_record: dict[str, Any],
    environment: dict[str, Any],
    allow_fixture: bool,
) -> bool:
    if allow_fixture:
        return True
    return bool(
        tool_record.get("schema") == "actoviq.ic-tool-qualification.v1"
        and tool_record.get("native_eligible") is True
        and tool_record.get("wsl") is False
        and tool_record.get("ineligible_environment") is False
        and str(tool_record.get("platform") or "") == str(environment.get("platform") or "")
        and str(tool_record.get("platform_release") or "") == str(environment.get("release") or "")
    )


def simulation_matches_tool_record(
    run: dict[str, Any],
    tool_id: str,
    tools: dict[str, Any],
) -> bool:
    provider = run.get("provider")
    provider = provider if isinstance(provider, dict) else {}
    tool = tools.get(tool_id)
    tool = tool if isinstance(tool, dict) else {}
    provider_executable = str(provider.get("executable") or "").strip()
    tool_executable = str(tool.get("executable") or "").strip()
    return bool(
        provider.get("id") == tool_id
        and str(provider.get("version") or "").strip()
        == str(tool.get("version") or "").strip()
        and provider_executable
        and tool_executable
        and Path(provider_executable).resolve() == Path(tool_executable).resolve()
    )


def successful_waveform_run(run: dict[str, Any], document_hash: str, source_revision: int) -> bool:
    verification = run.get("verification")
    verification = verification if isinstance(verification, dict) else {}
    return bool(
        run.get("ok") is True
        and run.get("execution_status") == "success"
        and run.get("measurement_status") == "success"
        and run.get("specification_status") == "passed"
        and run.get("verified") is True
        and run.get("document_hash") == document_hash
        and run.get("source_revision") == source_revision
        and verification.get("executed") is True
        and verification.get("measured") is True
        and verification.get("spec_passed") is True
        and has_waveform(run)
    )


def module_evidence(
    modules: dict[str, dict[str, Any]],
    device_catalog: dict[str, Any],
) -> tuple[int, int, list[str]]:
    instances = 0
    pdk_devices = 0
    diagnostics: list[str] = []
    catalog_devices = {
        str(device.get("device_id") or "").casefold(): device
        for device in device_catalog.get("devices", [])
        if isinstance(device, dict)
    }
    for module_id, module in modules.items():
        for component in module.get("components", []):
            if component.get("type") == "MODULE":
                instances += 1
                module_ref = component.get("module_ref")
                child_id = str(module_ref.get("module_id") or "") if isinstance(module_ref, dict) else ""
                if child_id not in modules:
                    diagnostics.append(f"{module_id}.{component.get('id')}: missing child module {child_id}")
                else:
                    child = modules[child_id]
                    if module_ref.get("revision") != child.get("revision"):
                        diagnostics.append(f"{module_id}.{component.get('id')}: stale child module revision")
                    child_ports = {str(port.get("id") or "") for port in child.get("ports", [])}
                    instance_pins = {str(pin.get("id") or "") for pin in component.get("pins", [])}
                    if child_ports != instance_pins:
                        diagnostics.append(f"{module_id}.{component.get('id')}: child port map differs")
            parameters = component.get("parameters")
            if not isinstance(parameters, dict) or not parameters.get("device_id"):
                continue
            pdk_devices += 1
            device_id = str(parameters.get("device_id") or "").casefold()
            catalog_device = catalog_devices.get(device_id)
            if not catalog_device:
                diagnostics.append(f"{module_id}.{component.get('id')}: PDK device is absent from the scanned catalog")
                continue
            for field in ("model", "w", "l"):
                if not str(parameters.get(field) or "").strip():
                    diagnostics.append(f"{module_id}.{component.get('id')}: missing PDK parameter {field}")
            spice = catalog_device.get("spice") if isinstance(catalog_device.get("spice"), dict) else {}
            if str(parameters.get("model") or "") != str(spice.get("model") or ""):
                diagnostics.append(f"{module_id}.{component.get('id')}: model differs from the scanned catalog")
            expected_pins = [str(pin) for pin in spice.get("pin_order", [])]
            actual_pins = [str(pin.get("id") or "") for pin in component.get("pins", [])]
            if expected_pins and actual_pins != expected_pins:
                diagnostics.append(f"{module_id}.{component.get('id')}: pin order differs from the scanned catalog")
    return instances, pdk_devices, diagnostics


def artifact(
    artifact_id: str,
    kind: str,
    path: Path,
    project_root: Path,
) -> dict[str, Any]:
    resolved = path.resolve()
    try:
        recorded_path = resolved.relative_to(project_root).as_posix()
        external = False
    except ValueError:
        recorded_path = resolved.name
        external = True
    return {
        "id": artifact_id,
        "kind": kind,
        "path": recorded_path,
        "sha256": sha256_file(resolved),
        "external": external,
    }


def build_report(
    *,
    project_root: Path,
    pdk_scan_path: Path,
    lock_path: Path,
    tool_record_path: Path,
    erc_path: Path,
    netlist_path: Path,
    ngspice_run_path: Path,
    xyce_run_path: Path,
    dual_run_path: Path,
    xschem_run_path: Path,
    allow_fixture: bool,
    commercial_attested: bool,
) -> dict[str, Any]:
    project_root = project_root.resolve()
    project, modules, module_paths = load_project(project_root)
    installation = unwrap_installation(read_json(pdk_scan_path))
    lock = read_json(lock_path)
    tool_record = read_json(tool_record_path)
    erc = read_json(erc_path)
    ngspice_run = validate_simulation_run(read_json(ngspice_run_path))
    xyce_run = validate_simulation_run(read_json(xyce_run_path))
    dual_run = validate_verification_run(read_json(dual_run_path))
    xschem_run = validate_verification_run(read_json(xschem_run_path))

    environment = environment_state(allow_fixture)
    locked_environment = lock.get("environment")
    locked_environment = locked_environment if isinstance(locked_environment, dict) else {}
    environment_lock_ok = allow_fixture or (
        environment["native_linux"]
        and locked_environment.get("platform") == "native_linux"
        and locked_environment.get("wsl") is False
        and str(locked_environment.get("distribution") or "").casefold()
        == str(environment["distribution"]).casefold()
        and str(locked_environment.get("version") or "")
        == str(environment["distribution_version"])
    )
    project_kind = str(project.get("project_kind") or "")
    document_hash = project_document_hash(project, modules)
    source_connectivity_hash = connectivity_hash(project, modules, view="simulation")
    device_catalog = (
        installation.get("device_catalog")
        if isinstance(installation.get("device_catalog"), dict)
        else {}
    )
    instances, pdk_devices, module_diagnostics = module_evidence(modules, device_catalog)

    pdk_id = str(installation.get("logical_id") or "")
    pdk_lock = (lock.get("open_pdks") or {}).get(pdk_id)
    pdk_lock = pdk_lock if isinstance(pdk_lock, dict) else {}
    locked_revision = str(pdk_lock.get("revision") or "")
    pdk_revision = str(installation.get("revision") or "")
    binding = ((project.get("analog_ic_profile") or {}).get("pdk_binding") or {})
    binding_ok = (
        str(binding.get("pdk_ref") or "") == pdk_id
        and str(binding.get("fingerprint") or "") == str(installation.get("fingerprint") or "")
    )

    tools = tool_record.get("tools")
    tools = tools if isinstance(tools, dict) else {}
    tool_versions = {
        tool_id: str((tools.get(tool_id) or {}).get("version") or "")
        for tool_id in REQUIRED_TOOLS
    }
    required_tool_set = set(tool_record.get("required") or [])
    locked_required_tools = set(lock.get("required_tools") or [])
    smoke = tool_record.get("smoke")
    smoke = smoke if isinstance(smoke, dict) else {}
    tools_ok = bool(
        tool_record_matches_environment(tool_record, environment, allow_fixture)
        and tool_record.get("passed") is True
        and not (tool_record.get("missing") or [])
        and not (tool_record.get("failed_smoke") or [])
        and (
            allow_fixture
            or all(bool((smoke.get(tool_id) or {}).get("passed")) for tool_id in ("ngspice", "xyce"))
        )
        and all(
            tool_id in required_tool_set
            and tool_id in locked_required_tools
            and bool((tools.get(tool_id) or {}).get("available"))
            and (tools.get(tool_id) or {}).get("exit_code") == 0
            and bool(tool_versions[tool_id])
            for tool_id in REQUIRED_TOOLS
        )
    )

    erc_ok = (
        erc.get("blocking") is False
        and int((erc.get("summary") or {}).get("errors", -1)) == 0
        and erc.get("source_revision") == project.get("revision")
        and erc.get("document_hash") == document_hash
    )
    netlist_text = netlist_path.read_text(encoding="utf-8", errors="replace")
    device_models = {
        str((component.get("parameters") or {}).get("model") or "")
        for module in modules.values()
        for component in module.get("components", [])
        if isinstance(component.get("parameters"), dict)
        and component["parameters"].get("device_id")
    }
    netlist_ok = bool(netlist_text.strip()) and all(model in netlist_text for model in device_models)
    source_revision = int(project.get("revision") or 0)
    ngspice_ok = successful_waveform_run(ngspice_run, document_hash, source_revision)
    xyce_ok = successful_waveform_run(xyce_run, document_hash, source_revision)
    dual_metadata = dual_run.get("metadata") if isinstance(dual_run.get("metadata"), dict) else {}
    comparison = dual_metadata.get("comparison") if isinstance(dual_metadata.get("comparison"), dict) else {}
    comparison_metrics = {
        str(item.get("metric") or "")
        for item in comparison.get("comparisons", [])
        if isinstance(item, dict) and str(item.get("metric") or "")
    }
    ngspice_metrics = {
        str(item.get("name") or "")
        for item in ngspice_run.get("metrics", [])
        if isinstance(item, dict) and str(item.get("name") or "")
    }
    xyce_metrics = {
        str(item.get("name") or "")
        for item in xyce_run.get("metrics", [])
        if isinstance(item, dict) and str(item.get("name") or "")
    }
    archived_run_linkage_ok = bool(
        simulation_matches_tool_record(ngspice_run, "ngspice", tools)
        and simulation_matches_tool_record(xyce_run, "xyce", tools)
        and dual_metadata.get("source_revision") == source_revision
        and dual_metadata.get("document_hash") == document_hash
        and {
            str(dual_metadata.get("left_run_id") or ""),
            str(dual_metadata.get("right_run_id") or ""),
        }
        == {
            str(ngspice_run.get("run_id") or ""),
            str(xyce_run.get("run_id") or ""),
        }
        and str(dual_metadata.get("left_profile_id") or "")
        and str(dual_metadata.get("right_profile_id") or "")
        and dual_metadata.get("left_profile_id") != dual_metadata.get("right_profile_id")
        and comparison_metrics
        and comparison_metrics <= (ngspice_metrics & xyce_metrics)
    )
    dual_ok = (
        dual_run.get("status") == "passed"
        and dual_run.get("executed") is True
        and archived_run_linkage_ok
        and dual_metadata.get("document_hash") == document_hash
        and comparison.get("ok") is True
        and bool(comparison.get("comparisons"))
    )
    xschem_metadata = xschem_run.get("metadata") if isinstance(xschem_run.get("metadata"), dict) else {}
    xschem_comparison = (
        xschem_metadata.get("connectivity_comparison")
        if isinstance(xschem_metadata.get("connectivity_comparison"), dict)
        else {}
    )
    xschem_ok = (
        xschem_run.get("status") == "passed"
        and xschem_run.get("executed") is True
        and xschem_comparison.get("ok") is True
        and xschem_metadata.get("source_module_id") in modules
        and xschem_metadata.get("source_module_hash")
        == xschem_module_hash(modules[str(xschem_metadata.get("source_module_id") or "")])
        and xschem_metadata.get("source_connectivity_hash")
        == ordered_connectivity_hash(modules[str(xschem_metadata.get("source_module_id") or "")])
        and xschem_metadata.get("topology_writeback") is False
    )

    source_kind = str(installation.get("source_kind") or "")
    boundary_attested = source_kind != "commercial" or commercial_attested
    gates = [
        gate(
            "native_linux_environment",
            environment["eligible"] and environment_lock_ok,
            "WSL2/Windows may run fixture checks but cannot produce native_verified evidence.",
            blocked=not allow_fixture,
        ),
        gate("tool_versions_and_smoke", tools_ok, "ngspice, Xyce, OpenVAF, and Xschem must all be required, available, and versioned."),
        gate(
            "locked_pdk",
            bool(
                pdk_id
                and pdk_id == str(lock.get("golden_pdk") or "")
                and pdk_revision
                and pdk_revision == locked_revision
                and installation.get("fingerprint")
                and installation.get("license_hash")
                and binding_ok
            ),
            "PDK revision/fingerprint/license hash and project binding must match the qualification lock.",
        ),
        gate(
            "hierarchical_pdk_design",
            project_kind in {"analog_ic", "mixed_signal_ic"}
            and len(modules) >= 2
            and instances > 0
            and pdk_devices > 0
            and not module_diagnostics,
            *module_diagnostics,
        ),
        gate("erc", erc_ok, "ERC must be non-blocking and match the exact project revision/document hash."),
        gate("canonical_netlist", netlist_ok, "Canonical netlist must contain every placed PDK model."),
        gate("ngspice_waveform", ngspice_ok, "ngspice must execute successfully and archive waveform samples."),
        gate("xyce_waveform", xyce_ok, "Xyce must execute successfully and archive waveform samples."),
        gate(
            "archived_run_linkage",
            archived_run_linkage_ok,
            "Simulation providers/versions, run IDs, profiles, revision, document hash, and compared metrics must match the archived tool and run records.",
        ),
        gate("dual_simulation_compare", dual_ok, "Dual simulation must compare common measurements for this document hash."),
        gate("xschem_reference_compare", xschem_ok, "Xschem reference netlist connectivity must pass without topology writeback."),
        gate("commercial_pdk_boundary", boundary_attested, "Commercial qualification requires an explicit no-copy/no-package/no-upload attestation."),
    ]

    artifacts = [
        artifact("project", "project", project_root / "project.circuit.json", project_root),
        *[
            artifact(f"module-{module_id}", "module", path, project_root)
            for module_id, path in sorted(module_paths.items())
        ],
        artifact("pdk-scan", "pdk_metadata", pdk_scan_path, project_root),
        artifact("qualification-lock", "qualification_lock", lock_path, project_root),
        artifact("tool-record", "tool_record", tool_record_path, project_root),
        artifact("erc", "erc", erc_path, project_root),
        artifact("netlist", "canonical_netlist", netlist_path, project_root),
        artifact("ngspice", "simulation", ngspice_run_path, project_root),
        artifact("xyce", "simulation", xyce_run_path, project_root),
        artifact("dual", "verification", dual_run_path, project_root),
        artifact("xschem", "verification", xschem_run_path, project_root),
    ]
    passed = all(item["status"] == "passed" for item in gates)
    blocked = any(item["status"] == "blocked" for item in gates)
    mode = "fixture" if allow_fixture else "native"
    qualification = (
        "native_verified"
        if passed and mode == "native"
        else "fixture_verified"
        if passed
        else "blocked"
        if blocked
        else "failed"
    )
    return {
        "schema": "actoviq.ic-project-qualification.v1",
        "qualified_at": datetime.now(timezone.utc).isoformat(),
        "mode": mode,
        "qualification": qualification,
        "passed": passed,
        "environment": environment,
        "project": {
            "project_id": str(project.get("project_id") or ""),
            "project_kind": project_kind,
            "revision": int(project.get("revision") or 0),
            "project_hash": sha256_file(project_root / "project.circuit.json"),
            "document_hash": document_hash,
            "connectivity_hash": source_connectivity_hash,
            "module_hashes": {
                module_id: sha256_file(path)
                for module_id, path in sorted(module_paths.items())
            },
            "module_count": len(modules),
            "module_instance_count": instances,
            "pdk_device_count": pdk_devices,
        },
        "pdk": {
            "logical_id": pdk_id,
            "source_kind": source_kind,
            "revision": pdk_revision,
            "fingerprint": str(installation.get("fingerprint") or ""),
            "license_hash": str(installation.get("license_hash") or ""),
            "lock_hash": canonical_hash(lock),
        },
        "tools": {
            "record_hash": sha256_file(tool_record_path),
            "versions": tool_versions,
        },
        "gates": gates,
        "artifacts": artifacts,
        "commercial_boundary": {
            "attested": boundary_attested,
            "pdk_content_copied": False,
            "pdk_content_packaged": False,
            "pdk_content_uploaded": False,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--pdk-scan", required=True)
    parser.add_argument("--lock", required=True)
    parser.add_argument("--tool-record", required=True)
    parser.add_argument("--erc", required=True)
    parser.add_argument("--netlist", required=True)
    parser.add_argument("--ngspice-run", required=True)
    parser.add_argument("--xyce-run", required=True)
    parser.add_argument("--dual-run", required=True)
    parser.add_argument("--xschem-run", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--allow-fixture", action="store_true")
    parser.add_argument("--commercial-boundary-attested", action="store_true")
    args = parser.parse_args()
    report = build_report(
        project_root=Path(args.project_root),
        pdk_scan_path=Path(args.pdk_scan),
        lock_path=Path(args.lock),
        tool_record_path=Path(args.tool_record),
        erc_path=Path(args.erc),
        netlist_path=Path(args.netlist),
        ngspice_run_path=Path(args.ngspice_run),
        xyce_run_path=Path(args.xyce_run),
        dual_run_path=Path(args.dual_run),
        xschem_run_path=Path(args.xschem_run),
        allow_fixture=bool(args.allow_fixture),
        commercial_attested=bool(args.commercial_boundary_attested),
    )
    target = Path(args.output).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "passed": report["passed"],
        "qualification": report["qualification"],
        "output": str(target),
    }))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
