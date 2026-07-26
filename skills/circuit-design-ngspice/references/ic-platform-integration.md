# IC Platform Integration

Actoviq is the control plane and data system for analog and mixed-signal IC work.
It does not replace a SPICE kernel, mask-layout editor, synthesis engine, or
licensed EDA installation.

## Source-of-truth rules

| Domain | Editable source of truth | Actoviq role |
|---|---|---|
| Native schematic | `actoviq.module.v2` | Edit and project through `actoviq.schematic-document.v1` |
| Xschem external mode | `.sch/.sym` peer | Read-only display, explicit pull, netlist cross-check |
| Digital RTL | `hdl/manifest.json` and HDL sources | Monaco editing, Icarus/Yosys orchestration |
| Mask layout | External GDS/OASIS/layout project | Batch verify, preview results, bind hashes |
| Physical rules and PCells | Installed PDK | Reference in place; never generate, copy, or redistribute |

Xschem modes are `native`, `bridge`, and `external`. Push and pull are explicit;
there is no real-time dual write. Bridge merge only applies stable placement,
rotation, text, W/L/M/NF, and wire geometry. Topology changes require review.

## PDK setup

Open **Settings → IC tools and PDKs**, run diagnostics, then select:

- IHP SG13G2: golden open-source integration target.
- SKY130: teaching/research integration target.
- GF180MCU: experimental, pinned to an explicit revision/license hash.
- Commercial mapping pack: SMIC, TSMC, or another local licensed PDK.

The importer writes `actoviq.pdk-installation.v1` under `~/.actoviq/`. Projects
contain only `actoviq.pdk-binding.v1`; they never contain machine-local PDK
paths. Commercial imports require a user-authored mapping pack and explicit
license acceptance. Models, OA libraries, decks, PCells, callbacks, and SKILL
remain at their original location.

Example commercial mapping pack:

```json
{
  "schema": "actoviq.pdk-mapping-pack.v1",
  "id": "foundry-process-release",
  "name": "Foundry Process Release",
  "vendor": "Foundry",
  "process": "Process",
  "license": "proprietary",
  "views": {
    "spice_models": ["models/**/*.scs"],
    "cds_libraries": ["cds.lib"],
    "calibre_decks": ["calibre/**/*"],
    "liberty": ["digital/**/*.lib"],
    "lef": ["digital/**/*.lef"]
  }
}
```

Mapping packs contain paths and names only—never proprietary content.

## Command-line workflows

All commands use argument arrays and `shell=false`.

```bash
python scripts/circuit_project.py pdk-scan --root /pdk/ihp-sg13g2 --adapter ihp-sg13g2
python scripts/circuit_project.py pdk-register --root /pdk/ihp-sg13g2 --adapter ihp-sg13g2 --license-accepted

python scripts/circuit_project.py xschem-link --project-root PROJECT --module-id core --mode bridge --peer-file core.sch
python scripts/circuit_project.py xschem-validate --peer-file core.sch --run-root build/xschem/core

python scripts/circuit_project.py openvaf-compile --source models/device.va --cache-root ~/.cache/actoviq/openvaf
python scripts/circuit_project.py simulate --project-root PROJECT --osdi CACHE/device.osdi
python scripts/circuit_project.py simulate-xyce --deck deck.cir --run-root build/xyce/run-1

python scripts/circuit_project.py verify-klayout-drc --layout chip.gds --rule-deck pdk.drc --run-root build/drc/run-1
python scripts/circuit_project.py verify-klayout-lvs --layout chip.gds --schematic chip.cdl --rule-deck pdk.lvs --run-root build/lvs/run-1
python scripts/circuit_project.py extract-magic --layout chip.mag --tech-file pdk.magicrc --top-cell chip --run-root build/extract/run-1
python scripts/circuit_project.py verify-netgen-lvs --extracted extracted.spice --schematic chip.cdl --setup-file pdk_setup.tcl --extracted-cell chip --schematic-cell chip --run-root build/netgen/run-1

python scripts/circuit_project.py hdl-simulate --project-root PROJECT --run-root build/hdl/rtl
python scripts/circuit_project.py hdl-synthesize --project-root PROJECT --run-root build/hdl/synth
python scripts/circuit_project.py hdl-gate-regression --project-root PROJECT --synthesis-run build/hdl/synth/run.json --run-root build/hdl/gate
python scripts/circuit_project.py mixed-signal-check --contract mixed-signal.json --analog-run analog-run.json --digital-run digital-run.json --run-root build/interface/run-1
```

OpenROAD is experimental. It only runs a project-local `.tcl` after an explicit
`hdl-openroad` command; it does not auto-execute PDK Tcl.

## Support and qualification

| Integration | Implemented state | Qualification rule |
|---|---|---|
| ngspice | Native provider, simulation v3 | Existing regression suite |
| Xyce | Independent deck provider | Per-PDK deck/model qualification |
| OpenVAF | OSDI cache for ngspice | OSDI is never reused by Xyce |
| Xschem | Three modes + headless reference netlist | Connectivity comparison is authoritative |
| KLayout | Batch DRC/LVS and `.lyrdb` parsing | Open results are not foundry signoff |
| Magic + Netgen | Controlled extraction and LVS | Requires PDK tech/setup files |
| Icarus + Yosys | Verilog-2005 RTL, synthesis, gate replay | SystemVerilog only if the tool accepts it |
| OpenROAD | Explicit experimental provider | PDK LEF/Liberty/GDS and flow script required |
| Spectre / HSPICE / XA / AFS | Licensed analog providers | `unverified` until licensed qualification |
| Xcelium / VCS / Questa AMS | Licensed AMS providers | `ams_verified` only after a qualified native run |

Native PSF, TR0, FSDB, and vendor databases remain in the user's environment.
Actoviq imports measurements/CSV and openly readable outputs. Process exit,
measurement, specification, LVS, and AMS states remain separate.

## Migration and compatibility

- Old projects without `project_kind` remain `simulation`.
- `actoviq.analog-ic-profile.v1` stays readable and is only written as v2 after
  the user saves IC configuration.
- Existing ngspice, compile/netlistsvg, Virtuoso export, KiCad bridge, and JLCEDA
  exchange paths remain available.
- `schematic.overrides.json` stays compatibility/export placement, not edit truth.
- Windows/ngspice remains supported. Linux is primary for IC tools; SSH Linux is
  supported for licensed providers. WSL2 is not reported as qualified.

## Security boundaries

- No shell command concatenation.
- Executables, working directories, and environment keys are allowlisted.
- License values are redacted and never forwarded in SSH arguments.
- Unknown Tcl, SKILL, shell, callback, and Xschem properties stay opaque unless
  the user explicitly launches the owning external tool.
- Commercial PDK content is never uploaded, copied into projects, or redistributed.

Run `npm run test:ic-platform` for non-GUI qualification. GUI qualification also
requires `test:schematic-document`, `test:e2e:schematic-editor`, and
`test:e2e:electron`.
