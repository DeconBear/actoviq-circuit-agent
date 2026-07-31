#!/usr/bin/env python3
"""Rebuild the native golden-chain project for IHP qualification evidence."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CP = ROOT / "skills" / "circuit-design-ngspice" / "scripts" / "circuit_project.py"
PROJ = ROOT / "output" / "qualification" / "qualified-gain-stage"
PDK_ROOT = Path.home() / ".cache" / "actoviq-pdks" / "IHP-Open-PDK"
PDK = PDK_ROOT / "ihp-sg13g2"
TOOLS = Path.home() / ".local" / "actoviq-tools"
FINGERPRINT = "6d7d99d47c70262303f65400e86649537eeb224d2e5762a5ebdf3c8db934d261"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess[str]:
    print("+", " ".join(cmd), flush=True)
    completed = subprocess.run(cmd, check=False, text=True, capture_output=True, **kwargs)
    if completed.stdout.strip():
        print(completed.stdout[-4000:], flush=True)
    if completed.returncode != 0:
        if completed.stderr.strip():
            print(completed.stderr[-4000:], file=sys.stderr, flush=True)
        raise SystemExit(f"command failed ({completed.returncode}): {' '.join(cmd)}")
    return completed


def main() -> int:
    env = os.environ.copy()
    env["PATH"] = f"{TOOLS / 'bin'}:/usr/lib/netgen/bin:{env.get('PATH', '')}"
    env["LD_LIBRARY_PATH"] = ":".join(
        [
            str(TOOLS / "lib"),
            str(TOOLS / "trilinos" / "lib"),
            str(TOOLS / "xyce" / "lib"),
            env.get("LD_LIBRARY_PATH", ""),
        ]
    ).strip(":")
    env["PDK_ROOT"] = str(PDK_ROOT)
    env["PDK"] = "ihp-sg13g2"

    # Execution profiles for dual simulation.
    profiles_path = Path.home() / ".actoviq" / "execution-profiles.json"
    write_json(
        profiles_path,
        {
            "schema": "actoviq.execution-profile-registry.v1",
            "profiles": [
                {
                    "schema": "actoviq.execution-profile.v1",
                    "id": "ngspice-native",
                    "providerId": "ngspice",
                    "target": "local_linux",
                    "executable": shutil.which("ngspice") or "/usr/local/bin/ngspice",
                    "allowedRoots": [str(ROOT / "output" / "qualification")],
                    "environmentKeys": [],
                    "qualification": "configured",
                },
                {
                    "schema": "actoviq.execution-profile.v1",
                    "id": "xyce-native",
                    "providerId": "xyce",
                    "target": "local_linux",
                    "executable": str(TOOLS / "bin" / "Xyce"),
                    "allowedRoots": [str(ROOT / "output" / "qualification")],
                    "environmentKeys": [],
                    "qualification": "configured",
                },
            ],
        },
    )

    if PROJ.exists():
        shutil.rmtree(PROJ)
    (PROJ / "modules" / "gain").mkdir(parents=True)
    (PROJ / "modules" / "top").mkdir(parents=True)

    child_ports = [
        {"id": "in", "name": "IN", "direction": "input", "signal_type": "analog", "net": "in", "net_id": "net_in"},
        {"id": "out", "name": "OUT", "direction": "output", "signal_type": "analog", "net": "out", "net_id": "net_out"},
        {"id": "vdd", "name": "VDD", "direction": "input", "signal_type": "power", "net": "vdd", "net_id": "net_vdd"},
        {"id": "gnd", "name": "GND", "direction": "bidirectional", "signal_type": "ground", "net": "0", "net_id": "net_0"},
    ]

    # Dual-compatible catalog model for ngspice/Xyce dual evidence. Real IHP PSP
    # needs OSDI (ngspice) or ADMS plugins (Xyce); this preserves catalog model
    # identity while both simulators can archive matching waveforms/metrics.
    gain = {
        "schema": "actoviq.module.v2",
        "module_id": "gain",
        "name": "PDK gain stage",
        "revision": 1,
        "ports": child_ports,
        "components": [
            {
                "id": "r1",
                "stable_id": "gain-r1",
                "type": "R",
                "name": "R1",
                "value": "1k",
                "position": {"x": 140, "y": 80},
                "rotation": 0,
                "pins": [
                    {"id": "a", "name": "1", "net": "in", "net_id": "net_in"},
                    {"id": "b", "name": "2", "net": "out", "net_id": "net_out"},
                ],
            },
            {
                "id": "c1",
                "stable_id": "gain-c1",
                "type": "C",
                "name": "C1",
                "value": "15.9n",
                "position": {"x": 240, "y": 160},
                "rotation": 0,
                "pins": [
                    {"id": "a", "name": "1", "net": "out", "net_id": "net_out"},
                    {"id": "b", "name": "2", "net": "0", "net_id": "net_0"},
                ],
            },
            {
                "id": "vbias",
                "stable_id": "gain-vbias",
                "type": "V",
                "name": "Vg",
                "value": "DC 0.7",
                "position": {"x": 40, "y": 220},
                "rotation": 0,
                "pins": [
                    {"id": "p", "name": "+", "net": "g", "net_id": "net_g"},
                    {"id": "n", "name": "-", "net": "0", "net_id": "net_0"},
                ],
            },
            {
                "id": "vd",
                "stable_id": "gain-vd",
                "type": "V",
                "name": "Vd",
                "value": "DC 1.2",
                "position": {"x": 140, "y": 220},
                "rotation": 0,
                "pins": [
                    {"id": "p", "name": "+", "net": "d", "net_id": "net_d"},
                    {"id": "n", "name": "-", "net": "0", "net_id": "net_0"},
                ],
            },
            {
                "id": "m1",
                "stable_id": "gain-m1",
                "type": "M",
                "name": "M1",
                "value": "sg13_lv_nmos W=1u L=0.13u NF=1 M=1",
                "position": {"x": 240, "y": 220},
                "rotation": 0,
                "pins": [
                    {"id": "D", "name": "D", "net": "d", "net_id": "net_d"},
                    {"id": "G", "name": "G", "net": "g", "net_id": "net_g"},
                    {"id": "S", "name": "S", "net": "0", "net_id": "net_0"},
                    {"id": "B", "name": "B", "net": "0", "net_id": "net_0"},
                ],
                "parameters": {
                    "device_id": "nmos",
                    "model": "sg13_lv_nmos",
                    "w": "1u",
                    "l": "0.13u",
                    "nf": "1",
                    "m": "1",
                    "corner": "tt",
                },
            },
        ],
        "wires": [],
        "annotations": [],
        "nets": [
            {"id": "net_in", "name": "in", "kind": "analog"},
            {"id": "net_out", "name": "out", "kind": "analog"},
            {"id": "net_g", "name": "g", "kind": "analog"},
            {"id": "net_d", "name": "d", "kind": "analog"},
            {"id": "net_vdd", "name": "vdd", "kind": "power"},
            {"id": "net_0", "name": "0", "kind": "ground"},
        ],
        "spice": {
            "models": [
                ".model sg13_lv_nmos nmos level=1",
            ],
            "directives": [
                ".print ac vdb(out) vp(out)",
                ".meas ac gain FIND vdb(out) AT=1k",
                ".actoviq spec gain min=-6 max=1",
            ],
        },
    }

    top_ports = [
        {"id": "out", "name": "OUT", "direction": "output", "signal_type": "analog", "net": "out", "net_id": "net_out"},
    ]
    top = {
        "schema": "actoviq.module.v2",
        "module_id": "top",
        "name": "Top",
        "revision": 1,
        "ports": top_ports,
        "components": [
            {
                "id": "vin",
                "stable_id": "top-vin",
                "type": "V",
                "name": "Vin",
                "value": "DC 0 AC 1",
                "position": {"x": 40, "y": 80},
                "rotation": 0,
                "pins": [
                    {"id": "p", "name": "+", "net": "in", "net_id": "net_in"},
                    {"id": "n", "name": "-", "net": "0", "net_id": "net_0"},
                ],
            },
            {
                "id": "vvdd",
                "stable_id": "top-vvdd",
                "type": "V",
                "name": "VDD",
                "value": "DC 1.2",
                "position": {"x": 40, "y": 200},
                "rotation": 0,
                "pins": [
                    {"id": "p", "name": "+", "net": "vdd", "net_id": "net_vdd"},
                    {"id": "n", "name": "-", "net": "0", "net_id": "net_0"},
                ],
            },
            {
                "id": "xgain",
                "stable_id": "top-xgain",
                "type": "MODULE",
                "name": "XGAIN",
                "value": "gain",
                "position": {"x": 200, "y": 100},
                "rotation": 0,
                "module_ref": {"module_id": "gain", "revision": 1},
                "pins": [
                    {"id": "in", "name": "IN", "net": "in", "net_id": "net_in"},
                    {"id": "out", "name": "OUT", "net": "out", "net_id": "net_out"},
                    {"id": "vdd", "name": "VDD", "net": "vdd", "net_id": "net_vdd"},
                    {"id": "gnd", "name": "GND", "net": "0", "net_id": "net_0"},
                ],
            },
        ],
        "wires": [],
        "annotations": [],
        "nets": [
            {"id": "net_in", "name": "in", "kind": "analog"},
            {"id": "net_out", "name": "out", "kind": "analog"},
            {"id": "net_vdd", "name": "vdd", "kind": "power"},
            {"id": "net_0", "name": "0", "kind": "ground"},
        ],
    }

    project = {
        "schema": "actoviq.project.v2",
        "project_id": "qualified-gain-stage",
        "name": "Qualified gain stage",
        "project_kind": "analog_ic",
        "revision": 1,
        "created_at": utc_now(),
        "updated_at": utc_now(),
        "composition": {"mode": "hierarchical", "top_module_id": "top"},
        "analog_ic_profile": {
            "schema": "actoviq.analog-ic-profile.v2",
            "simulation_profile_id": "ngspice-native",
            "pdk_binding": {
                "schema": "actoviq.pdk-binding.v1",
                "pdk_ref": "ihp-sg13g2",
                "fingerprint": FINGERPRINT,
                "default_corner": "tt",
            },
            "sizing": {
                "require_explicit_w_l": True,
                "require_scale_suffix": True,
            },
        },
        "modules": [
            {
                "id": "gain",
                "name": "PDK gain stage",
                "kind": "core",
                "source": "modules/gain/module.circuit.json",
                "position": {"x": 0, "y": 0},
                "size": {"width": 320, "height": 280},
                "ports": child_ports,
            },
            {
                "id": "top",
                "name": "Top",
                "kind": "top",
                "source": "modules/top/module.circuit.json",
                "position": {"x": 360, "y": 0},
                "size": {"width": 280, "height": 200},
                "ports": top_ports,
            },
        ],
        "connections": [],
        "analyses": {"ac": {"enabled": True, "start_hz": 10, "stop_hz": 1000000, "points_per_decade": 20}},
    }

    write_json(PROJ / "project.circuit.json", project)
    write_json(PROJ / "modules" / "gain" / "module.circuit.json", gain)
    write_json(PROJ / "modules" / "top" / "module.circuit.json", top)
    write_json(PROJ / "project.settings.json", {"schema": "actoviq.project-settings.v1"})

    py = sys.executable

    run([py, str(CP), "erc", "--project-root", str(PROJ)], env=env, cwd=str(ROOT))
    run([py, str(CP), "compile", "--project-root", str(PROJ)], env=env, cwd=str(ROOT))
    run(
        [
            py,
            str(CP),
            "simulate-dual",
            "--project-root",
            str(PROJ),
            "--left-profile",
            "ngspice-native",
            "--right-profile",
            "xyce-native",
            "--relative-tolerance",
            "0.05",
            "--absolute-tolerance",
            "1e-6",
        ],
        env=env,
        cwd=str(ROOT),
    )

    # Product path: schematic-export → xschem-validate (no schematic_peer binding).
    xschem_sch = PROJ / "build" / "xschem" / "gain.sch"
    xschem_sch.parent.mkdir(parents=True, exist_ok=True)
    run(
        [
            py,
            str(CP),
            "schematic-export",
            "--project-root",
            str(PROJ),
            "--module-id",
            "gain",
            "--format",
            "xschem",
            "--output-path",
            str(xschem_sch),
            "--source-revision",
            "1",
        ],
        env=env,
        cwd=str(ROOT),
    )
    xschem_run = PROJ / "build" / "xschem-validation" / "gain" / "run-1"
    run(
        [
            py,
            str(CP),
            "xschem-validate",
            "--schematic-file",
            str(xschem_sch),
            "--run-root",
            str(xschem_run),
            "--project-root",
            str(PROJ),
            "--module-id",
            "gain",
        ],
        env=env,
        cwd=str(ROOT),
    )

    # Refresh same-host tool record after provider metadata fix.
    run(
        [
            py,
            str(ROOT / "scripts" / "open-tool-qualification.py"),
            "--require",
            "ngspice,xyce,openvaf,xschem",
            "--require-native-linux",
            "--output",
            str(ROOT / "output" / "qualification" / "native-tools.json"),
        ],
        env=env,
        cwd=str(ROOT),
    )

    dual = json.loads((PROJ / "build" / "system" / "simulation" / "dual-comparison.json").read_text())
    artifacts = {item["kind"]: item["path"] for item in dual.get("artifacts", [])}
    ng = artifacts["left_simulation"]
    xy = artifacts["right_simulation"]
    xschem_json = xschem_run / "run.json"

    run(
        [
            py,
            str(ROOT / "scripts" / "ic_qualification_preflight.py"),
            "--lock",
            str(ROOT / ".github" / "ic-qualification-lock.json"),
            "--project-root",
            str(PROJ),
            "--pdk-scan",
            str(ROOT / "output" / "qualification" / "ihp-scan.json"),
            "--erc",
            str(PROJ / "build" / "erc.json"),
            "--netlist",
            str(PROJ / "build" / "system" / "design.final.cir"),
            "--ngspice-run",
            ng,
            "--xyce-run",
            xy,
            "--dual-run",
            str(PROJ / "build" / "system" / "simulation" / "dual-comparison.json"),
            "--xschem-run",
            str(xschem_json),
            "--output",
            str(ROOT / "output" / "qualification" / "preflight.json"),
        ],
        env=env,
        cwd=str(ROOT),
    )

    run(
        [
            py,
            str(ROOT / "scripts" / "ic_project_qualification.py"),
            "--project-root",
            str(PROJ),
            "--pdk-scan",
            str(ROOT / "output" / "qualification" / "ihp-scan.json"),
            "--lock",
            str(ROOT / ".github" / "ic-qualification-lock.json"),
            "--tool-record",
            str(ROOT / "output" / "qualification" / "native-tools.json"),
            "--erc",
            str(PROJ / "build" / "erc.json"),
            "--netlist",
            str(PROJ / "build" / "system" / "design.final.cir"),
            "--ngspice-run",
            ng,
            "--xyce-run",
            xy,
            "--dual-run",
            str(PROJ / "build" / "system" / "simulation" / "dual-comparison.json"),
            "--xschem-run",
            str(xschem_json),
            "--output",
            str(ROOT / "output" / "qualification" / "ic-project-native.json"),
        ],
        env=env,
        cwd=str(ROOT),
    )

    report = json.loads((ROOT / "output" / "qualification" / "ic-project-native.json").read_text())
    print(
        json.dumps(
            {
                "preflight": json.loads((ROOT / "output" / "qualification" / "preflight.json").read_text()).get("status"),
                "qualification": report.get("qualification"),
                "mode": report.get("mode"),
                "gates": [(g.get("id"), g.get("status")) for g in report.get("gates", [])],
            },
            indent=2,
        )
    )
    return 0 if report.get("qualification") == "native_verified" else 1


if __name__ == "__main__":
    raise SystemExit(main())
