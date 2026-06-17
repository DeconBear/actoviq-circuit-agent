const NETLIST_BLOCK = /```(?:spice|cir|netlist)\s*\r?\n([\s\S]*?)```/gi;

export function createNetlistNotebook(
  title: string,
  description: string,
  netlist: string,
): string {
  return [
    `# ${title}`,
    '',
    description || 'Describe the purpose and design decisions for this circuit here.',
    '',
    '## SPICE netlist',
    '',
    '```spice',
    netlist.trim(),
    '```',
    '',
    '## Notes',
    '',
    'Add implementation notes, assumptions, review comments, or Agent instructions here.',
    '',
  ].join('\n');
}

export function extractNetlistCode(markdown: string): string {
  const blocks = [...markdown.matchAll(NETLIST_BLOCK)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  if (blocks.length === 0) {
    throw new Error('Add at least one fenced `spice`, `cir`, or `netlist` code block.');
  }
  return `${blocks.join('\n\n')}\n`;
}
