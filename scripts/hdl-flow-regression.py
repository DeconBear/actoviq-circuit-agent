#!/usr/bin/env python3
"""Regression for Verilog simulation, synthesis, gate replay, and mixed boundaries."""

from __future__ import annotations

import json
import re
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL_SCRIPTS = ROOT / "skills" / "circuit-design-ngspice" / "scripts"
sys.path.insert(0, str(SKILL_SCRIPTS))

from hdl_flow import (  # noqa: E402
    IcarusProvider,
    OpenRoadProvider,
    YosysProvider,
    load_hdl_manifest,
    run_gate_regression,
    verify_mixed_signal_contract,
)


FAKE_IVERILOG = r"""
import pathlib
import sys

output = pathlib.Path(sys.argv[sys.argv.index("-o") + 1])
output.write_text("compiled", encoding="utf-8")
"""


FAKE_VVP = r"""
import pathlib

pathlib.Path("wave.vcd").write_text(
    "$date test $end\n$version fake $end\n$enddefinitions $end\n",
    encoding="utf-8",
)
print("PASS")
"""


FAKE_YOSYS = r"""
import json
import pathlib
import re
import sys

script = pathlib.Path(sys.argv[sys.argv.index("-s") + 1]).read_text(encoding="utf-8")
verilog = re.search(r'write_verilog -noattr "([^"]+)"', script)
netjson = re.search(r'write_json "([^"]+)"', script)
pathlib.Path(verilog.group(1)).write_text(
    "module counter(input clk, output reg q); always @(posedge clk) q <= ~q; endmodule\n",
    encoding="utf-8",
)
pathlib.Path(netjson.group(1)).write_text(json.dumps({"modules": {"counter": {}}}), encoding="utf-8")
print("Number of cells: 1")
"""


FAKE_OPENROAD = r"""
import pathlib

pathlib.Path("macro.def").write_text("VERSION 5.8 ;\nEND DESIGN\n", encoding="utf-8")
pathlib.Path("macro.gds").write_bytes(b"synthetic-gds")
print("OpenROAD flow complete")
"""


def write_project(root: Path) -> dict:
    hdl = root / "hdl"
    hdl.mkdir()
    (hdl / "counter.v").write_text(
        "module counter(input clk, output reg q); initial q=0; always @(posedge clk) q <= ~q; endmodule\n",
        encoding="utf-8",
    )
    (hdl / "counter_tb.v").write_text(
        "module counter_tb; reg clk=0; wire q; counter dut(clk,q); always #1 clk=~clk; initial #10 $finish; endmodule\n",
        encoding="utf-8",
    )
    (hdl / "cells.v").write_text("module DFF(input D,C,output Q); endmodule\n", encoding="utf-8")
    (hdl / "cells.lib").write_text("library(test) {}\n", encoding="utf-8")
    (hdl / "timing.sdc").write_text("create_clock -period 10 clk\n", encoding="utf-8")
    manifest = {
        "schema": "actoviq.hdl-manifest.v1",
        "language": "verilog-2005",
        "active_source_set": "rtl",
        "source_sets": [{
            "id": "rtl",
            "top": "counter",
            "sources": ["hdl/counter.v"],
            "testbench": "hdl/counter_tb.v",
            "testbench_top": "counter_tb",
            "gate_libraries": ["hdl/cells.v"],
            "include_paths": ["hdl"],
            "defines": {"SIMULATION": 1},
            "constraints": "hdl/timing.sdc",
        }],
    }
    (hdl / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="actoviq-hdl-flow-") as temporary:
        root = Path(temporary)
        write_project(root)
        manifest = load_hdl_manifest(root)
        fake_iverilog = root / "fake_iverilog.py"
        fake_vvp = root / "fake_vvp.py"
        fake_yosys = root / "fake_yosys.py"
        fake_openroad = root / "fake_openroad.py"
        fake_iverilog.write_text(FAKE_IVERILOG, encoding="utf-8")
        fake_vvp.write_text(FAKE_VVP, encoding="utf-8")
        fake_yosys.write_text(FAKE_YOSYS, encoding="utf-8")
        fake_openroad.write_text(FAKE_OPENROAD, encoding="utf-8")

        icarus = IcarusProvider(str(fake_iverilog), str(fake_vvp))
        simulation = icarus.simulate(root, manifest, root / "runs" / "rtl-sim")
        assert simulation["status"] == "passed"
        assert simulation["metadata"]["domain_verified"]
        assert any(artifact["kind"] == "waveform" for artifact in simulation["artifacts"])

        yosys = YosysProvider(str(fake_yosys))
        generic = yosys.synthesize(root, manifest, root / "runs" / "generic-synth")
        assert generic["status"] == "passed"
        assert not generic["metadata"]["technology_mapped"]
        assert generic["metadata"]["constraints_hash"]

        mapped_manifest = json.loads(json.dumps(manifest))
        mapped_manifest["source_sets"][0]["liberty"] = "hdl/cells.lib"
        mapped = yosys.synthesize(root, mapped_manifest, root / "runs" / "mapped-synth")
        assert mapped["status"] == "passed"
        assert mapped["metadata"]["technology_mapped"]
        assert mapped["metadata"]["liberty_hash"]

        gate = run_gate_regression(
            root,
            manifest,
            generic,
            root / "runs" / "gate-regression",
            icarus,
        )
        assert gate["status"] == "passed"
        assert gate["kind"] == "hdl_gate_regression"

        flow_script = root / "hdl" / "openroad.tcl"
        flow_script.write_text("# explicit synthetic OpenROAD flow\n", encoding="utf-8")
        openroad = OpenRoadProvider(str(fake_openroad)).run_script(
            root,
            flow_script,
            root / "runs" / "openroad",
        )
        assert openroad["status"] == "passed"
        assert openroad["metadata"]["qualification"] == "experimental"
        assert any(artifact["kind"] == "openroad_gds" for artifact in openroad["artifacts"])

        contract_path = root / "mixed-signal.json"
        contract = {
            "schema": "actoviq.mixed-signal-contract.v1",
            "boundaries": [{
                "id": "adc-ready",
                "analog_net": "ready_a",
                "digital_signal": "ready",
                "direction": "analog_to_digital",
                "supply_domain": {"vss": 0.0, "vdd": 1.8},
                "threshold": {"low_max": 0.5, "high_min": 1.3},
                "sampling": {"mode": "edge", "edge": "rising"},
                "conversion_model": "connectrules/adc_ready.vams",
                "vectors": [
                    {"time_s": 0.0, "analog_voltage": 0.1, "digital_value": 0},
                    {"time_s": 1e-9, "analog_voltage": 1.7, "digital_value": 1},
                ],
            }],
        }
        contract_path.write_text(json.dumps(contract, indent=2), encoding="utf-8")
        interface = verify_mixed_signal_contract(
            contract_path,
            root / "runs" / "interface",
            {"status": "passed"},
            simulation,
        )
        assert interface["status"] == "passed"
        assert interface["metadata"]["domain_verified"]
        assert interface["metadata"]["interface_verified"]
        assert not interface["metadata"]["ams_verified"]

        bad_contract = json.loads(json.dumps(contract))
        bad_contract["boundaries"][0]["vectors"][1]["analog_voltage"] = 0.8
        contract_path.write_text(json.dumps(bad_contract, indent=2), encoding="utf-8")
        failed = verify_mixed_signal_contract(
            contract_path,
            root / "runs" / "bad-interface",
            {"status": "passed"},
            simulation,
        )
        assert failed["status"] == "failed"
        assert not failed["metadata"]["interface_verified"]

    print(json.dumps({"ok": True, "suite": "hdl-flow-regression"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
