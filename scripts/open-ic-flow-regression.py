#!/usr/bin/env python3
"""Regression coverage for OpenVAF caching and the independent Xyce provider."""

from __future__ import annotations

import json
import hashlib
import os
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL_SCRIPTS = ROOT / "skills" / "circuit-design-ngspice" / "scripts"
sys.path.insert(0, str(SKILL_SCRIPTS))

from open_sim_providers import (  # noqa: E402
    OpenVafProvider,
    XyceProvider,
    compare_simulation_metrics,
    inject_ngspice_osdi,
    validate_xyce_deck,
)
from circuit_project import (  # noqa: E402
    execute_profiled_simulation,
    initialize_project,
    simulate_dual_profiles,
    simulate_post_layout,
)
from execution_profiles import assert_profile_path, resolve_simulation_profile  # noqa: E402
from verification_contracts import validate_simulation_run, validate_verification_run  # noqa: E402


FAKE_OPENVAF = r"""
import pathlib
import sys

if "--version" in sys.argv or "-V" in sys.argv:
    print("OpenVAF test 1.0")
    raise SystemExit(0)
output = pathlib.Path(sys.argv[sys.argv.index("-o") + 1])
source = pathlib.Path(sys.argv[1])
output.write_text("osdi:" + source.read_text(encoding="utf-8"), encoding="utf-8")
"""


FAKE_XYCE = r"""
import pathlib
import sys

if "-v" in sys.argv or "--version" in sys.argv:
    print("Xyce test 7.8")
    raise SystemExit(0)
log = pathlib.Path(sys.argv[sys.argv.index("-l") + 1])
log.write_text("gain = 10.0\n", encoding="utf-8")
pathlib.Path("wave.prn").write_text(
    "TIME V(out)\n0 0\n1e-9 1\n",
    encoding="utf-8",
)
print("settling = 1e-9")
"""


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="actoviq-open-ic-flow-") as temporary:
        root = Path(temporary)
        fake_openvaf = root / "fake_openvaf.py"
        fake_openvaf.write_text(FAKE_OPENVAF, encoding="utf-8")
        model = root / "device.va"
        model.write_text("module device(a,b); endmodule\n", encoding="utf-8")
        provider = OpenVafProvider(str(fake_openvaf))
        first = provider.compile(model, root / "cache", ["--lint"])
        assert not first["cache_hit"]
        assert Path(first["output"]).is_file()
        second = provider.compile(model, root / "cache", ["--lint"])
        assert second["cache_hit"]
        assert second["cache_key"] == first["cache_key"]
        model.write_text("module device(a,b); analog begin end endmodule\n", encoding="utf-8")
        changed = provider.compile(model, root / "cache", ["--lint"])
        assert changed["cache_key"] != first["cache_key"]

        injected = inject_ngspice_osdi(
            "Title\n.control\nrun\n.endc\n.end\n",
            [Path(first["output"])],
        )
        assert "pre_osdi" in injected
        assert not validate_xyce_deck("Title\nR1 1 0 1k\n.end\n")
        assert any("OSDI" in item for item in validate_xyce_deck("pre_osdi device.osdi\n"))

        fake_xyce = root / "fake_xyce.py"
        fake_xyce.write_text(FAKE_XYCE, encoding="utf-8")
        deck = root / "deck.cir"
        deck.write_text("Title\nR1 1 0 1k\n.op\n.end\n", encoding="utf-8")
        xyce = XyceProvider(str(fake_xyce))
        result = xyce.run_deck(deck, root / "xyce-run")
        assert result["ok"]
        assert result["provider"]["id"] == "xyce"
        assert {metric["name"] for metric in result["metrics"]} == {"gain", "settling"}
        assert result["analyses"][0]["tables"]["wave.prn"]["V(out)"] == [0.0, 1.0]

        registry = root / "execution-profiles.json"
        registry.write_text(json.dumps({
            "schema": "actoviq.execution-profile-registry.v1",
            "profiles": [{
                "schema": "actoviq.execution-profile.v1",
                "id": "xyce-local",
                "providerId": "xyce",
                "target": "local_windows" if os.name == "nt" else "local_linux",
                "executable": str(fake_xyce),
                "allowedRoots": [str(root)],
                "environmentKeys": [],
                "qualification": "unverified",
            }, {
                "schema": "actoviq.execution-profile.v1",
                "id": "xyce-local-second",
                "providerId": "xyce",
                "target": "local_windows" if os.name == "nt" else "local_linux",
                "executable": str(fake_xyce),
                "allowedRoots": [str(root)],
                "environmentKeys": [],
                "qualification": "unverified",
            }],
        }), encoding="utf-8")
        previous_registry = os.environ.get("ACTOVIQ_EXECUTION_PROFILE_REGISTRY")
        os.environ["ACTOVIQ_EXECUTION_PROFILE_REGISTRY"] = str(registry)
        try:
            project = {
                "analog_ic_profile": {
                    "simulation_profile_id": "xyce-local",
                },
            }
            resolved = resolve_simulation_profile(project)
            assert resolved["providerId"] == "xyce"
            try:
                assert_profile_path(resolved, root.parent / "outside.cir")
                raise AssertionError("profile paths outside allowedRoots must be rejected")
            except ValueError:
                pass
            system_root = root / "project" / "build" / "system"
            system_root.mkdir(parents=True)
            profiled_deck = system_root / "system.cir"
            profiled_deck.write_text("Title\nR1 1 0 1k\n.op\n.end\n", encoding="utf-8")
            profiled = execute_profiled_simulation(
                project,
                profiled_deck,
                3,
                "document-hash",
                "project",
                "",
            )
            assert profiled["ok"]
            assert profiled["simulation_profile_id"] == "xyce-local"
            assert profiled["provider"]["id"] == "xyce"
            assert (system_root / "simulation" / "result.json").is_file()
            dual_project = initialize_project(root / "projects", "dual", None, True)
            dual = simulate_dual_profiles(
                dual_project,
                "xyce-local",
                "xyce-local-second",
                0.001,
                1e-9,
            )
            assert dual["status"] == "passed"
            assert dual["metadata"]["comparison"]["comparisons"]
            assert (
                dual_project / "build" / "system" / "simulation" / "dual-comparison.json"
            ).is_file()
            dual_project_file = dual_project / "project.circuit.json"
            dual_project_value = json.loads(dual_project_file.read_text(encoding="utf-8"))
            dual_project_value["project_kind"] = "analog_ic"
            dual_project_value["analog_ic_profile"] = {
                "schema": "actoviq.analog-ic-profile.v2",
                "simulation_profile_id": "xyce-local",
                "pdk_binding": {"schema": "actoviq.pdk-binding.v1", "pdk_ref": "synthetic"},
            }
            dual_project_file.write_text(json.dumps(dual_project_value), encoding="utf-8")
            layout = dual_project / "layout.gds"
            layout.write_bytes(b"synthetic-layout")
            schematic = dual_project / "schematic.cdl"
            schematic.write_text(".subckt test in out\n.ends\n", encoding="utf-8")
            post_deck = dual_project / "post.cir"
            post_deck.write_text("Title\nR1 out 0 1k\n.op\n.end\n", encoding="utf-8")
            lvs_run = dual_project / "lvs-run.json"
            lvs_run.write_text(json.dumps({
                "schema": "actoviq.verification-run.v1",
                "run_id": "lvs-clean",
                "kind": "lvs",
                "provider_id": "klayout",
                "executed": True,
                "status": "passed",
                "diagnostics": [],
                "artifacts": [],
                "metadata": {
                    "lvs_clean": True,
                    "layout_hash": hashlib.sha256(layout.read_bytes()).hexdigest(),
                    "schematic_hash": hashlib.sha256(schematic.read_bytes()).hexdigest(),
                },
            }), encoding="utf-8")
            post = simulate_post_layout(
                dual_project,
                post_deck,
                layout,
                schematic,
                lvs_run,
            )
            assert post["ok"]
            assert post["verification"]["lvs_clean"]
            assert post["post_layout"]["layout_hash"]
        finally:
            if previous_registry is None:
                os.environ.pop("ACTOVIQ_EXECUTION_PROFILE_REGISTRY", None)
            else:
                os.environ["ACTOVIQ_EXECUTION_PROFILE_REGISTRY"] = previous_registry

        comparison = compare_simulation_metrics(
            {"metrics": [{"name": "gain", "value": 10.0}]},
            {"metrics": [{"name": "gain", "value": 10.005}]},
            relative_tolerance=0.001,
            absolute_tolerance=1e-6,
        )
        assert comparison["ok"]
        assert not compare_simulation_metrics(
            {"metrics": [{"name": "gain", "value": 10.0}]},
            {"metrics": [{"name": "gain", "value": 11.0}]},
            relative_tolerance=0.001,
            absolute_tolerance=1e-6,
        )["ok"]

        try:
            validate_simulation_run({"schema": "actoviq.simulation.v3"})
            raise AssertionError("incomplete simulation results must be rejected")
        except ValueError:
            pass
        try:
            validate_verification_run({
                "schema": "actoviq.verification-run.v1",
                "run_id": "invalid",
                "kind": "drc",
                "provider_id": "klayout",
                "executed": "yes",
                "status": "passed",
                "diagnostics": [],
                "artifacts": [],
            })
            raise AssertionError("non-boolean execution state must be rejected")
        except ValueError:
            pass

    print(json.dumps({"ok": True, "suite": "open-ic-flow-regression"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
