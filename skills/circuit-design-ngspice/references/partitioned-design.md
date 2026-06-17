# Partitioned Circuit Design

Use this procedure for designs with more than 20 components, multiple signal
domains, or more than one feedback loop.

## Boundary Rules

1. Partition by electrical responsibility, not arbitrary component count.
2. Give every module explicit `input_nets` and `output_nets`.
3. Treat supply, ground, bias reference, and clock nets as `shared_nets`.
4. Prefix every private node with the module's `local_net_prefix`.
5. Keep component names globally unique across all modules.
6. A non-top-level interface net has exactly one producer and at least one consumer.
7. Keep each module at 16 components or fewer when practical.
8. Verify modules locally, then verify the composed flat design.

## Required Loop

1. Write `planning/module-plan.json`.
2. Write each `design/modules/<nn>_<name>.cir`.
3. Validate boundaries:

   ```bash
   python scripts/validate_module_interfaces.py \
     --job-root <job-root> \
     --require-partitioned
   ```

4. Compose the flat netlist:

   ```bash
   python scripts/compose_modules.py --job-root <job-root>
   ```

5. Run primitive, parameter, simulation, and rendering checks on
   `design/design.final.cir`.
6. If the composed design fails, identify the owning module from
   `design/module-manifest.json`; change that module and recompose.

## Hierarchical Reasoning

Maintain three budgets:

- **Interface budget**: voltage range, source/load impedance, bandwidth, bias.
- **Module budget**: gain, noise, current, headroom, delay, tolerance.
- **System budget**: end-to-end target and margin allocation.

A module passes only when its output remains valid for the next module's
declared input contract.
