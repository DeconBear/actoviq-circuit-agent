#!/usr/bin/env python3
"""Deterministic, proprietary-data-free regression for the local PDK registry."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL_SCRIPTS = ROOT / "skills" / "circuit-design-ngspice" / "scripts"
sys.path.insert(0, str(SKILL_SCRIPTS))

from analog_ic import PROFILE_SCHEMA_V2, audit_project, validate_profile  # noqa: E402
from pdk_registry import (  # noqa: E402
    BINDING_SCHEMA,
    load_registry,
    register_installation,
    resolve_binding,
    scan_installation,
)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="actoviq-pdk-regression-") as temporary:
        root = Path(temporary)
        pdk = root / "IHP-Open-PDK" / "ihp-sg13g2"
        model = pdk / "libs.tech" / "ngspice" / "cornerHBT.lib"
        model.parent.mkdir(parents=True)
        model.write_text("* synthetic model metadata only\n", encoding="utf-8")
        (pdk / "libs.tech" / "xschem").mkdir(parents=True)
        (pdk / "libs.tech" / "klayout").mkdir(parents=True)
        registry = root / "registry.json"

        scanned = scan_installation(
            pdk.parent,
            "ihp-sg13g2",
            version="test",
            revision="deadbeef",
        )
        assert scanned["capabilities"]["model_library"]
        assert scanned["capabilities"]["xschem"]
        assert scanned["capabilities"]["klayout"]
        assert not Path(scanned["views"]["model_library"][0]).is_absolute()
        assert not registry.exists()

        saved = register_installation(scanned, license_accepted=True, path=registry)
        assert load_registry(registry)["installations"][0]["installation_id"] == saved["installation_id"]
        binding = {
            "schema": BINDING_SCHEMA,
            "pdk_ref": "ihp-sg13g2",
            "fingerprint": scanned["fingerprint"],
            "default_corner": "tt",
            "temperature_c": 27,
        }
        resolved = resolve_binding(binding, path=registry)
        assert Path(resolved["model_library"]) == model.resolve()

        previous = os.environ.get("ACTOVIQ_PDK_REGISTRY")
        os.environ["ACTOVIQ_PDK_REGISTRY"] = str(registry)
        try:
            profile = {
                "schema": PROFILE_SCHEMA_V2,
                "simulation_profile_id": "ngspice-local",
                "pdk_binding": binding,
                "sizing": {"require_explicit_w_l": True, "require_scale_suffix": True},
            }
            assert validate_profile(profile) == []
            project_root = root / "project"
            notebook = project_root / "modules" / "core" / "netlist-notebook.md"
            notebook.parent.mkdir(parents=True)
            source = (
                f'.lib "{model.as_posix()}" tt\n'
                "M1 out in 0 0 sg13_lv_nmos W=1u L=0.13u M=1 NF=1\n"
                ".op\n.end\n"
            )
            notebook.write_text(f"```spice\n{source}```\n", encoding="utf-8")
            project = {
                "project_id": "pdk-v2-audit",
                "project_kind": "analog_ic",
                "revision": 1,
                "analog_ic_profile": profile,
            }
            modules = {
                "core": {
                    "module_id": "core",
                    "spice": {"source": source},
                    "components": [{
                        "id": "m1",
                        "stable_id": "m1",
                        "type": "M",
                        "name": "M1",
                        "value": "sg13_lv_nmos W=1u L=0.13u M=1 NF=1",
                    }],
                },
            }
            assert audit_project(project_root, project, modules)["ok"]
        finally:
            if previous is None:
                os.environ.pop("ACTOVIQ_PDK_REGISTRY", None)
            else:
                os.environ["ACTOVIQ_PDK_REGISTRY"] = previous

        commercial = root / "commercial"
        (commercial / "models").mkdir(parents=True)
        (commercial / "models" / "models.scs").write_text("// synthetic placeholder\n", encoding="utf-8")
        mapping = root / "mapping.json"
        mapping.write_text(json.dumps({
            "schema": "actoviq.pdk-mapping-pack.v1",
            "id": "example-commercial",
            "name": "Example Commercial PDK",
            "vendor": "Example",
            "process": "N1",
            "license": "proprietary",
            "views": {"model_library": ["models/*.scs"], "klayout": ["klayout"]},
        }), encoding="utf-8")
        commercial_scan = scan_installation(commercial, "commercial", mapping_file=mapping)
        assert commercial_scan["source_kind"] == "commercial"
        assert commercial_scan["capabilities"]["model_library"]

    print(json.dumps({"ok": True, "suite": "pdk-registry-regression"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
