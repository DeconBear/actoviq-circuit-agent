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
.actoviq spec bandwidth_3db min=1400 max=1800 unit=Hz
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
    "rc-noise": """* RC output noise
V1 in 0 DC 0 AC 1
R1 in out 1k
C1 out 0 100n
.noise v(out) V1 dec 20 10 1meg
.end
""",
    "rc-pz": """* RC pole-zero analysis
V1 in 0 DC 0 AC 1
R1 in out 1k
C1 out 0 100n
.pz in 0 out 0 vol pz
.end
""",
    "sine-fft": """* Deterministic FFT
V1 out 0 SIN(0 1 1k)
R1 out 0 1k
.tran 10u 10m
.actoviq fft v(out) window=blackman
.end
""",
    "divider-parameter-sweep": """* Divider parameter sweep
.param RVAL=1k
V1 in 0 DC 10
R1 in out {RVAL}
R2 out 0 1k
.dc V1 0 10 1
.actoviq sweep param:RVAL 800 1200 5 analysis=dc
.end
""",
    "divider-monte-carlo": """* Divider Monte Carlo
V1 in 0 DC 10
R1 in out 1k
R2 out 0 1k
.op
.actoviq montecarlo R1 1k 0.05 8 seed=42 analysis=op
.end
""",
    "spec-fail-separation": """* Executable design with an intentionally failing specification
V1 in 0 DC 0
R1 in out 1k
R2 out 0 1k
.dc V1 0 10 1
.actoviq spec dc_output_max min=6 unit=V
.end
""",
    "ldo-startup": (
        ROOT / "skills" / "circuit-design-ngspice" / "assets" / "templates" / "ldo_mos_series_bench.cir"
    ).read_text(encoding="utf-8"),
    "buck-transient": (
        ROOT / "skills" / "circuit-design-ngspice" / "assets" / "templates" / "buck_mos_power_bench.cir"
    ).read_text(encoding="utf-8"),
}


TARGET_ANALYSIS = {
    "sine-fft": "fft",
    "divider-parameter-sweep": "parameter_sweep",
    "divider-monte-carlo": "monte_carlo",
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
        assert run["specification_status"] == "passed"
        resistor_current = trace(dataset, "i(@r1[i])")
        assert resistor_current["source"] == "derived_from_ac_node_voltages"
        assert 9e-4 < resistor_current["magnitude"][-1] < 1.1e-3
        capacitor_current = trace(dataset, "i(@c1[i])")
        assert capacitor_current["source"] == "derived_from_ac_node_voltages"
        assert math.isclose(
            resistor_current["magnitude"][-1],
            capacitor_current["magnitude"][-1],
            rel_tol=1e-6,
        )
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
    elif case_id == "rc-noise":
        assert dataset["analysis_type"] == "noise"
        assert metric(run, "onoise_spectrum_at_1khz") > 0
        noise_traces = [item for item in dataset["traces"] if "noise" in item["name"]]
        current_traces = [item for item in dataset["traces"] if item["name"].startswith("i(@")]
        assert noise_traces and all(item["unit"] == "V/sqrt(Hz)" for item in noise_traces)
        assert current_traces and all(item["unit"] == "A" for item in current_traces)
    elif case_id == "rc-pz":
        assert dataset["analysis_type"] == "pz"
        assert metric(run, "pole_count") >= 1
        assert any("pole" in item["name"].lower() for item in dataset["traces"])
    elif case_id == "sine-fft":
        assert dataset["analysis_type"] == "fft"
        assert 900 < metric(run, "dominant_frequency") < 1100
        assert metric(run, "dominant_magnitude") > 0.5
    elif case_id == "divider-parameter-sweep":
        assert dataset["analysis_type"] == "parameter_sweep"
        assert len(dataset["traces"]) == 5
        assert metric(run, "ensemble_output_min") < 4.6
        assert metric(run, "ensemble_output_max") > 5.5
    elif case_id == "divider-monte-carlo":
        assert dataset["analysis_type"] == "monte_carlo"
        assert len(dataset["traces"]) == 8
        assert metric(run, "ensemble_output_stddev") > 0
        assert math.isclose(metric(run, "ensemble_output_mean"), 5.0, rel_tol=0.05)
    elif case_id == "spec-fail-separation":
        assert run["ok"]
        assert run["execution_status"] == "success"
        assert run["specification_status"] == "failed"
        assert not run["verified"]
    elif case_id == "ldo-startup":
        assert 4.5 < metric(run, "vout_nom") < 5.2
        assert metric(run, "line_regulation_pct") < 1.0
    elif case_id == "buck-transient":
        assert 2.5 < metric(run, "vout_avg") < 4.0
        assert metric(run, "efficiency_pct") > 30


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
            target_type = TARGET_ANALYSIS.get(case_id)
            analysis = next(
                item for item in run["analyses"]
                if target_type is None or item["type"] == target_type
            )
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
