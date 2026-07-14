# Vision Layout Review

Use this path only after deterministic layout/routing candidates remain below
the required quality threshold, or when a user explicitly requests visual
schematic review.

## Model capability gate

- Only a model that can inspect image content may invoke
  `view_schematic_for_layout` or the `review-schematic-layout-vision` skill.
- A text-only model must not call the image tool. It must use the structured
  `actoviq.layout-quality.v1` report instead.
- The default/text workflow tool catalog does not contain the image tool.
- The host must invoke the vision skill explicitly and set
  `vision_capable: true` or include `vision`/`image` in `model_capabilities`.
  Missing capability metadata is rejected as text-only; prompt text alone is
  never treated as an authorization boundary.

## Closed-loop flow

1. Generate deterministic layout/routing candidates and their quality reports.
2. If the best candidate scores below 90, render its generated SVG.
3. Give the vision skill the SVG path, quality-report path, module ID, source
   revision, and connectivity hash.
4. The skill calls `view_schematic_for_layout` once and visually checks symbol
   overlap, wire crossings, wires through symbols, congested corridors,
   avoidable bends, label collisions, feedback paths, and signal flow.
5. It may return at most four `actoviq.layout-patch.v1` candidates using only
   `move_component`, `rotate_component`, `move_port`, `set_block_pin_side`, or
   `set_layout_lane`.
6. Apply each candidate to an isolated layout copy, reroute deterministically,
   and reject it unless its source revision and connectivity hash still match.
7. Score candidates lexicographically and retain only an improvement. The image
   itself is never a source-data write path.

The vision model must not add or remove components, change pins or nets, alter
SPICE/value/model data, or directly draw SVG or wires. Final source changes, if
requested, still use the normal revisioned project transaction.

## Tool result

The tool returns a text metadata block and one image block:

```json
{
  "schema": "actoviq.vision-layout-image.v1",
  "media_type": "image/png",
  "width": 1200,
  "height": 800,
  "sha256": "..."
}
```

The image block contains the PNG bytes as base64. It is deliberately separate
from `actoviq.layout-quality.v1`: visual observations propose layout patches,
while deterministic geometry and connectivity checks decide acceptance.
