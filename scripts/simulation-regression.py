#!/usr/bin/env python3
"""Run deterministic ngspice waveform regressions against the v2 simulation pipeline."""

from __future__ import annotations

import importlib.util
import json
import math
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "playwright"
PROJECT_TOOL = ROOT / "skills" / "circuit-design-ngspice" / "scripts" / "circuit_project.py"


def load_project_tool():
    spec = importlib.util.spec_from_file_location("actoviq_circuit_project", PROJECT_TOOL)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {PROJECT_TOOL}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CASES = {
    "divider-op": """* Divider operating point
V1 in 0 DC 10
R1 in out 1k
R2 out 0 1k
.op
.end
""",
    "divider-dc": """* Divider DC sweep
Vin in 0 DC 0
R1 in out 1k
R2 out 0 1k
.dc Vin 0 10 0.25
.end
""",
    "rc-ac": """* RC low pass AC
V1 in 0 DC 0 AC 1
R1 in out 1k
C1 out 0 100n
.ac dec 30 10 1meg
.meas ac gain_1khz_db find vdb(out) at=1k
.end
""",
    "rectifier-tran": """* Diode rectifier transient
V1 in 0 SIN(0 5 1k)
D1 in out DMOD
C1 out 0 10u
R1 out 0 1k
.model DMOD D(IS=1e-14 N=1)
.tran 10u 5m
.end
""",
    "mos-common-source-ac": """* MOS common source AC
VDD vdd 0 DC 5
VIN gate 0 DC 1.5 AC 1
RD vdd out 10k
M1 out gate 0 0 NM W=20u L=1u
.model NM NMOS(LEVEL=1 VTO=0.7 KP=120u LAMBDA=0.01)
.ac dec 20 10 1meg
.end
""",
    "cmos-inverter-dc": """* CMOS inverter transfer
VDD vdd 0 DC 5
VIN in 0 DC 0
MP out in vdd vdd PM W=40u L=1u
MN out in 0 0 NM W=20u L=1u
.model NM NMOS(LEVEL=1 VTO=0.7 KP=120u)
.model PM PMOS(LEVEL=1 VTO=-0.7 KP=60u)
.dc VIN 0 5 0.1
.end
""",
    "opamp-slew-tran": """* Slew-limited RC follower
VIN in 0 PULSE(0 5 1m 1u 1u 4m 10m)
E1 drive 0 in 0 1
R1 drive out 1k
C1 out 0 1u
.tran 10u 12m
.end
""",
    "two-port-sp": """* 50 ohm two-port
V1 in 0 DC 0 AC 1 portnum 1 Z0 50
V2 out 0 DC 0 AC 0 portnum 2 Z0 50
R1 in out 50
.sp dec 20 1meg 1gig
.end
""",
}


def trace(dataset: dict, name: str) -> dict:
    return next(item for item in dataset["traces"] if item["name"].lower() == name.lower())


def metric(run: dict, name: str) -> float:
    item = next(value for value in run["metrics"] if value["name"] == name)
    if item["value"] is None:
        raise AssertionError(f"metric {name} was not measured")
    return float(item["value"])


def validate(case_id: str, run: dict, dataset: dict) -> None:
    if not run["ok"]:
        raise AssertionError(f"{case_id} failed: {run['analyses'][0].get('diagnostics')}")
    if dataset["point_count"] <= 0 or not dataset["traces"]:
        raise AssertionError(f"{case_id} produced an empty dataset")
    if case_id == "divider-op":
        assert math.isclose(trace(dataset, "v(out)")["real"][0], 5.0, rel_tol=1e-6)
    elif case_id == "divider-dc":
        output = trace(dataset, "v(out)")["real"]
        assert output[0] < 1e-9 and math.isclose(output[-1], 5.0, rel_tol=1e-6)
    elif case_id == "rc-ac":
        assert -1.0 > metric(run, "gain_1khz_db") > -2.0
        assert 1400 < metric(run, "bandwidth_3db") < 1800
    elif case_id == "rectifier-tran":
        output = trace(dataset, "v(out)")["real"]
        assert max(output) > 3.5 and min(output[-100:]) > 0
    elif case_id == "mos-common-source-ac":
        assert max(trace(dataset, "v(out)")["magnitude"]) > 0.05
    elif case_id == "cmos-inverter-dc":
        output = trace(dataset, "v(out)")["real"]
        assert output[0] > 4.5 and output[-1] < 0.5
    elif case_id == "opamp-slew-tran":
        assert metric(run, "rise_time_10_90") > 0
        assert metric(run, "slew_rate_positive") > 0
    elif case_id == "two-port-sp":
        assert dataset["analysis_type"] == "sparameter"
        assert any(item.get("imag") for item in dataset["traces"])


def main() -> int:
    project_tool = load_project_tool()
    executable = project_tool.resolve_ngspice("")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    summaries = []
    with tempfile.TemporaryDirectory(prefix="simulation-regression-", dir=OUTPUT) as temp:
        temp_root = Path(temp)
        for case_id, netlist in CASES.items():
            case_root = temp_root / case_id
            if case_id == "divider-op":
                case_root = case_root / ("long-module-path-" + "x" * 72) / ("nested-build-" + "y" * 72)
            case_root.mkdir(parents=True)
            netlist_path = case_root / "design.cir"
            netlist_path.write_text(netlist, encoding="utf-8")
            if case_id == "divider-op":
                expected_analysis_path = netlist_path.parent / "simulation" / "runs" / ("r" * 40) / "op-1"
                assert len(str(expected_analysis_path)) > 260
            digest = project_tool.hashlib.sha256(netlist.encode("utf-8")).hexdigest()
            run = project_tool.execute_simulation_run(
                case_root,
                executable,
                netlist_path,
                1,
                digest,
                f"regression:{case_id}",
            )
            analysis = run["analyses"][0]
            dataset_path = case_root / "simulation" / analysis["dataset"]["path"]
            dataset = json.loads(dataset_path.read_text(encoding="utf-8"))
            validate(case_id, run, dataset)
            summaries.append({
                "case": case_id,
                "analysis": analysis["type"],
                "points": dataset["point_count"],
                "traces": len(dataset["traces"]),
                "metrics": len(run["metrics"]),
            })
    report_path = OUTPUT / "simulation-regression.json"
    report_path.write_text(json.dumps({"ok": True, "cases": summaries}, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "report": str(report_path), "cases": summaries}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}), file=sys.stderr)
        raise
