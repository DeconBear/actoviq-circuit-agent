import { skill, type ActoviqSkillDefinition } from 'actoviq-agent-sdk';

import { createSchematicVisionImageTool } from '../tools/renderTools.js';

export function createVisionLayoutReviewSkill(): ActoviqSkillDefinition {
  return skill({
    name: 'review-schematic-layout-vision',
    description: 'Vision-only review of a rendered circuit diagram for placement and routing improvements.',
    whenToUse: 'Use only with a vision-capable model after deterministic layout still scores below 90, or when the user explicitly requests visual schematic review.',
    argumentHint: 'SVG path, layout-quality report path, module id, source revision, and connectivity hash.',
    prompt: [
      'You are executing /review-schematic-layout-vision.',
      '',
      'CAPABILITY GATE:',
      '- Continue only if you can inspect image content.',
      '- If you are a text-only model, do NOT call view_schematic_for_layout. Stop and report that a vision-capable model is required.',
      '',
      'Call view_schematic_for_layout exactly once with the generated schematic SVG from the stage packet.',
      'Use the embedded actoviq.layout-quality.v1 report in the stage packet and inspect the returned circuit image.',
      'Look for component overlap, wires through symbols, crossings, crowded corridors, avoidable bends, long feedback routes, label collisions, and weak left-to-right signal flow.',
      'Treat the image as layout evidence only. The module data and connectivity hash remain authoritative.',
      '',
      'Return at most four actoviq.layout-patch.v1 candidates. Allowed operations are:',
      '- move_component: grid deltas only, each axis between -6 and 6.',
      '- rotate_component: 0, 90, 180, or 270.',
      '- move_port: grid deltas only, each axis between -6 and 6.',
      '- set_block_pin_side: BLOCK components only.',
      '- set_layout_lane: rank/lane hints only.',
      'Never add/remove components, change pins or nets, alter SPICE/value/model data, or draw SVG/wires directly.',
      'Every candidate must repeat the supplied source revision and connectivity hash.',
      '',
      'Stage packet:',
      '$ARGUMENTS',
    ].join('\n'),
    tools: [createSchematicVisionImageTool()],
    inheritDefaultTools: false,
    allowedTools: ['view_schematic_for_layout'],
    disableModelInvocation: true,
    source: 'custom',
    loadedFrom: 'custom',
    metadata: {
      required_modality: 'vision',
      forbidden_for: 'text-only-models',
      invocation: 'host-explicit-only',
      output_schema: 'actoviq.layout-patch.v1',
    },
  });
}
