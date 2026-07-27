#!/usr/bin/env python3
"""Synthetic physical-verification regression with no foundry content."""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL_SCRIPTS = ROOT / "skills" / "circuit-design-ngspice" / "scripts"
sys.path.insert(0, str(SKILL_SCRIPTS))

from physical_verification import KLayoutProvider, MagicProvider, NetgenProvider  # noqa: E402


FAKE_KLAYOUT = r"""
import pathlib
import sys

if "-v" in sys.argv or "--version" in sys.argv:
    print("KLayout test 0.30")
    raise SystemExit(0)
values = {}
for index, value in enumerate(sys.argv):
    if value == "-rd":
        key, content = sys.argv[index + 1].split("=", 1)
        values[key] = content
deck = pathlib.Path(sys.argv[sys.argv.index("-r") + 1])
deck_text = deck.read_text(encoding="utf-8")
if "missing-report" in deck_text:
    raise SystemExit(0)
report = pathlib.Path(values["report"])
if "invalid-report" in deck_text:
    report.write_text("<report-database>", encoding="utf-8")
    raise SystemExit(0)
violate = "violate" in deck_text
item = "<item><category>min_width</category><value>1,2</value></item>" if violate else ""
report.write_text("<report-database><items>" + item + "</items></report-database>", encoding="utf-8")
if "extracted" in values:
    pathlib.Path(values["extracted"]).write_text("* extracted\n.end\n", encoding="utf-8")
"""


FAKE_MAGIC = r"""
import pathlib
import re
import sys

if "--version" in sys.argv or "-version" in sys.argv:
    print("Magic test 8.3")
    raise SystemExit(0)
commands = sys.stdin.read()
match = re.search(r"ext2spice -o \{([^}]+)\}", commands)
if not match:
    raise SystemExit(2)
pathlib.Path(match.group(1)).write_text("* pex\nRpar out 0 1\n.end\n", encoding="utf-8")
"""


FAKE_NETGEN = r"""
import json
import pathlib
import sys

if "-version" in sys.argv or "--version" in sys.argv:
    print("Netgen test 1.5")
    raise SystemExit(0)
pathlib.Path(sys.argv[-1]).write_text(json.dumps({"equivalent": True}), encoding="utf-8")
print("Netlists match uniquely.")
"""


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="actoviq-physical-verification-") as temporary:
        root = Path(temporary)
        layout = root / "inverter.gds"
        layout.write_bytes(b"synthetic-gds")
        schematic = root / "inverter.cdl"
        schematic.write_text(".subckt inverter a y vdd vss\n.ends\n", encoding="utf-8")
        clean_drc = root / "clean.drc"
        clean_drc.write_text("# synthetic clean rule\n", encoding="utf-8")
        bad_drc = root / "bad.drc"
        bad_drc.write_text("# violate\n", encoding="utf-8")
        missing_report_drc = root / "missing-report.drc"
        missing_report_drc.write_text("# missing-report\n", encoding="utf-8")
        invalid_report_drc = root / "invalid-report.drc"
        invalid_report_drc.write_text("# invalid-report\n", encoding="utf-8")
        lvs_deck = root / "compare.lvs"
        lvs_deck.write_text("# synthetic lvs rule\n", encoding="utf-8")
        magic_tech = root / "magicrc"
        magic_tech.write_text("# synthetic tech\n", encoding="utf-8")
        netgen_setup = root / "setup.tcl"
        netgen_setup.write_text("# synthetic mapping, never sourced by Actoviq\n", encoding="utf-8")

        fake_klayout = root / "fake_klayout.py"
        fake_klayout.write_text(FAKE_KLAYOUT, encoding="utf-8")
        klayout = KLayoutProvider(str(fake_klayout))
        drc = klayout.run_drc(layout, clean_drc, root / "run-drc-clean")
        assert drc["status"] == "passed"
        assert drc["metadata"]["violation_count"] == 0
        bad = klayout.run_drc(layout, bad_drc, root / "run-drc-bad")
        assert bad["status"] == "failed"
        assert bad["metadata"]["violation_count"] == 1
        missing = klayout.run_drc(layout, missing_report_drc, root / "run-drc-missing")
        assert missing["status"] == "failed"
        assert not missing["metadata"]["report_present"]
        assert any("was not created" in message for message in missing["diagnostics"])
        invalid = klayout.run_drc(layout, invalid_report_drc, root / "run-drc-invalid")
        assert invalid["status"] == "failed"
        assert not invalid["metadata"]["report_valid"]
        assert any("parse error" in message for message in invalid["diagnostics"])
        lvs = klayout.run_lvs(layout, schematic, lvs_deck, root / "run-klayout-lvs")
        assert lvs["status"] == "passed"
        assert lvs["metadata"]["lvs_clean"]

        fake_magic = root / "fake_magic.py"
        fake_magic.write_text(FAKE_MAGIC, encoding="utf-8")
        magic_layout = root / "inverter.mag"
        magic_layout.write_text("magic\n", encoding="utf-8")
        extraction = MagicProvider(str(fake_magic)).extract(
            magic_layout,
            magic_tech,
            root / "run-magic",
            "inverter",
        )
        assert extraction["status"] == "passed"
        extracted = root / "run-magic" / "extracted.spice"
        assert extracted.is_file()
        pex = MagicProvider(str(fake_magic)).extract_pex(
            magic_layout,
            magic_tech,
            root / "run-magic-pex",
            "inverter",
        )
        assert pex["status"] == "passed"
        assert pex["metadata"]["pex_hash"]
        assert (root / "run-magic-pex" / "pex.spice").is_file()

        fake_netgen = root / "fake_netgen.py"
        fake_netgen.write_text(FAKE_NETGEN, encoding="utf-8")
        netgen = NetgenProvider(str(fake_netgen)).run_lvs(
            extracted,
            schematic,
            netgen_setup,
            root / "run-netgen",
            "inverter",
            "inverter",
        )
        assert netgen["status"] == "passed"
        assert netgen["metadata"]["lvs_clean"]
        assert netgen["metadata"]["schematic_hash"]
        assert netgen["metadata"]["extracted_hash"]

    print(json.dumps({"ok": True, "suite": "physical-verification-regression"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
