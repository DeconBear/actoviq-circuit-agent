import { readArtifactSummary } from './jobArtifacts.js';

export async function buildRevisionRequirement(options: {
  baseJobId: string;
  baseJobRoot: string;
  revisionRequest: string;
}): Promise<string> {
  const manifest = await readArtifactSummary(options.baseJobRoot, 'manifest');
  const report = await readArtifactSummary(options.baseJobRoot, 'design-report');
  const netlist = await readArtifactSummary(options.baseJobRoot, 'netlist');

  return [
    '# Revision Requirement',
    '',
    'Create a revised version based on the existing circuit design. Do not overwrite the base job.',
    '',
    `Base job id: ${options.baseJobId}`,
    `Base job root: ${options.baseJobRoot}`,
    '',
    '## User Revision Request',
    '',
    options.revisionRequest.trim(),
    '',
    '## Base Artifacts',
    '',
    `- Manifest: ${manifest.path}`,
    `- Detailed design report: ${report.path}`,
    `- Final netlist: ${netlist.path}`,
    '',
    '## Base Artifact Preview',
    '',
    '### Manifest',
    manifest.preview ?? '(missing)',
    '',
    '### Detailed Design Report',
    report.preview ?? '(missing)',
    '',
    '### Netlist',
    netlist.preview ?? '(missing)',
    '',
    '## Revision Rules',
    '',
    '- Preserve topology, explanations, node names, and parameter choices that are still valid.',
    '- Explicitly describe which modules, parameters, validation targets, and schematic outputs changed.',
    '- Re-run netlist validation, simulation, and schematic rendering for the revised design.',
    '- Write the revised artifacts into the new revision job only.',
  ].join('\n');
}
