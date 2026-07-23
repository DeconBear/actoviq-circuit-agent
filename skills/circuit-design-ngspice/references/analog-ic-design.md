# Analog IC design contract

`project_kind: analog_ic` is a SPICE-verified transistor-design workflow. It is
not a PCB sourcing workflow: LCSC binding and the KiCad/JLCEDA Bridge are only
available to `pcb_schematic` projects. Analog IC handoff uses the existing
Virtuoso SPICE/CDL/SKILL export package.

## Project profile

Before simulation, commit one `set_analog_ic_profile` transaction at the
current project revision:

```json
{
  "schema": "actoviq.command.v1",
  "command_id": "configure-analog-ic-001",
  "actor": "agent",
  "project_id": "ota",
  "base_revision": 0,
  "operations": [
    {
      "op": "set_analog_ic_profile",
      "profile": {
        "schema": "actoviq.analog-ic-profile.v1",
        "simulator": "ngspice",
        "pdk": {
          "name": "example-pdk",
          "model_library": "models/example.lib.spice",
          "corner": "tt",
          "temperature_c": 27
        },
        "sizing": {
          "require_explicit_w_l": true,
          "require_scale_suffix": true
        }
      }
    }
  ]
}
```

The model path may be project-relative or absolute. Do not copy or redistribute
a foundry PDK unless its license explicitly permits that. The module notebook
must reference the configured library with `.include` or `.lib`; when a corner
is configured, select the same corner in the `.lib` statement.

## Channel sizing

Every primitive `M` device, and every MOS-like `X` subcircuit, must have
explicit positive `W` and `L`. Use SPICE scale suffixes (`u`, `n`, and so on),
including through a simple `.param` reference. `M` (parallel multiplier) and
`NF` (finger count) are separate design variables and must be positive when
present.

Before tuning a channel dimension, state which quantity is held fixed: drain
current, overdrive, gate voltage, geometry ratio, or another explicit
constraint. A PDK short-channel result must not silently replace a
long-channel textbook assumption. Check operating region, headroom, `gm`,
`gds`, `gmb`, capacitance and speed evidence before accepting a sizing change.

Run the deterministic gate before ngspice:

```bash
python scripts/circuit_project.py analog-ic-audit --project-root <project>
python scripts/circuit_project.py compile --project-root <project>
python scripts/circuit_project.py simulate --project-root <project>
```

`simulate` also runs the audit and stops on missing PDK binding or invalid
geometry. A verified analog IC requires current-revision ERC, a passing sizing
audit, successful requested analyses, and passing `.actoviq spec` limits.

## Razavi-Bench license gate

Razavi-Bench benchmark materials have restricted terms, including an explicit
written-permission requirement before incorporation into a third-party
evaluation suite. A non-commercial acknowledgement is not a substitute.
Actoviq therefore does not read or expose task paths, figures, golden answers,
rubrics, judge prompts, netlists, PDFs, outputs/scores, or execute upstream
Python. The only enabled command is a read-only provenance preflight:

```bash
python scripts/razavi_bench.py --repo <canonical-upstream-checkout>
```

It records only the canonical Git remote, immutable revision, public LICENSE
hash, and the `blocked_pending_written_permission` policy state. Obtain written
permission from the benchmark authors before implementing the answer-agent or
scoring adapter. Until then, any permitted use must occur outside Actoviq under
the upstream terms; do not copy results or restricted materials into this
repository.

Upstream source and terms:

- <https://github.com/Arcadia-1/razavi-bench>
- <https://github.com/Arcadia-1/razavi-bench/blob/main/LICENSE>
- <https://github.com/Arcadia-1/razavi-bench/blob/main/agentic/README.md>

## Virtuoso handoff boundary

`export-eda --targets virtuoso` first requires a passing analog audit, then
creates import-ready SPICE/CDL with model directives, `model-bindings.spice`,
`analog-ic-profile.json`, source-SPICE sidecars, device mapping, hierarchy
files, `handoff-manifest.json` (revision/document/connectivity hashes), and a
SKILL bootstrap. Foundry models are referenced by resolved local path and are
never copied. This release has no unattended Virtuoso importer and therefore
does not produce a Virtuoso `native` status; it produces an import-ready or
generated-unverified package for manual validation in the user's licensed
Virtuoso/PDK environment. The package does not preserve ADE state, CDF
callbacks, PCells, layout, constraints, or foundry models. Treat SPICE/CDL and
the normalized manifests as the exchange contract; run an import/export
comparison for every supported Virtuoso and PDK version.
