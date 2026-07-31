# IC project qualification

Use this procedure only on a native Linux host with legal access to the selected
PDK and tools. Windows and WSL2 may run fixture/regression checks, but they must
not produce `native_verified` evidence.

## Evidence contract

The first golden chain is the required IHP SG13G2 revision in
`.github/ic-qualification-lock.json`. A qualifying project must:

- use `project_kind=analog_ic` or `mixed_signal_ic`;
- contain at least two modules and one explicit `MODULE` instance;
- contain at least one catalog-backed PDK device with model, W, and L;
- have non-blocking ERC for the exact project revision and document hash;
- have a canonical netlist containing every placed PDK model;
- archive waveform-bearing ngspice and Xyce `actoviq.simulation.v3` runs;
- archive a passing dual-simulation comparison whose provider versions, run
  IDs, profiles, revision, document hash, and compared metrics bind to those
  exact ngspice/Xyce run files and the same-host tool record;
- archive a passing Xschem reference-netlist connectivity comparison produced
  from **schematic-export** → `xschem-validate` (`metadata.handoff=schematic-export`,
  no topology writeback; not peer Push/Pull);
- archive project/module, PDK, tool, connectivity, and evidence hashes.

The report contains metadata and hashes only. It never copies, packages, or
uploads PDK content. Commercial PDK qualification additionally requires the
operator's explicit `--commercial-boundary-attested` flag.

## Native run

1. Check out the locked PDK revision and scan it:

   ```text
   python skills/circuit-design-ngspice/scripts/circuit_project.py pdk-scan \
     --root /opt/pdks/IHP-Open-PDK --adapter ihp-sg13g2 \
     --revision 22f2a25f1734796de3debbbf29cf697cbbc54081 \
     > output/qualification/ihp-scan.json
   ```

2. Record the exact native tools. All four are mandatory:

   ```text
   python scripts/open-tool-qualification.py \
     --require ngspice,xyce,openvaf,xschem \
     --require-native-linux \
     --output output/qualification/native-tools.json
   ```

   The tool record must come from the same native kernel as the final report.
   A WSL/fixture record, a different kernel release, missing ngspice/Xyce smoke
   result, or a provider version that differs from an archived simulation run
   fails qualification.

3. In Actoviq, complete and save the hierarchical project, then run ERC,
   compile the canonical netlist, run independent ngspice and Xyce profiles,
   run `simulate-dual`, **export** the module schematic with
   `schematic-export --format xschem`, and run `xschem-validate` on that
   exported `.sch` (Import/Export handoff; do not use peer link/push). Keep the
   generated JSON evidence and waveform tables under the project build directory.

4. Before a self-hosted workflow spends time installing dependencies and
   running the release suite, verify that the native runner can see the locked
   PDK scan, hierarchical project, and every required evidence file:

   ```text
   python scripts/ic_qualification_preflight.py \
     --lock .github/ic-qualification-lock.json \
     --project-root /work/qualified-gain-stage \
     --pdk-scan output/qualification/ihp-scan.json \
     --erc /work/qualified-gain-stage/build/erc.json \
     --netlist /work/qualified-gain-stage/build/system/design.final.cir \
     --ngspice-run /work/qualified-gain-stage/build/system/simulation/runs/NG/RUN.json \
     --xyce-run /work/qualified-gain-stage/build/system/simulation/runs/XY/RUN.json \
     --dual-run /work/qualified-gain-stage/build/system/simulation/dual-comparison.json \
     --xschem-run /work/qualified-gain-stage/build/xschem-validation/core/RUN/run.json \
     --output output/qualification/preflight.json
   ```

5. Verify and archive the evidence:

   ```text
   python scripts/ic_project_qualification.py \
     --project-root /work/qualified-gain-stage \
     --pdk-scan output/qualification/ihp-scan.json \
     --lock .github/ic-qualification-lock.json \
     --tool-record output/qualification/native-tools.json \
     --erc /work/qualified-gain-stage/build/erc.json \
     --netlist /work/qualified-gain-stage/build/system/design.final.cir \
     --ngspice-run /work/qualified-gain-stage/build/system/simulation/runs/NG/RUN.json \
     --xyce-run /work/qualified-gain-stage/build/system/simulation/runs/XY/RUN.json \
     --dual-run /work/qualified-gain-stage/build/system/simulation/dual-comparison.json \
     --xschem-run /work/qualified-gain-stage/build/xschem-validation/core/RUN/run.json \
     --output output/qualification/ic-project-native.json
   ```

`qualification=native_verified` is emitted only when every gate passes on
native Linux. `--allow-fixture` exists only for deterministic contract tests and
can emit no stronger result than `fixture_verified`.

## Release gates

Run:

```text
npm run test:schematic-release
npm run test:schematic-release:gui
```

The manual `IC project native qualification` workflow repeats the local release
gate on a self-hosted `linux, ic-qualified` runner and verifies the archived
golden-chain evidence. A release must not claim native IC qualification without
its uploaded `ic-project-native.json`.
