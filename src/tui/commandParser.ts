import type { TuiCommand, TuiCommandName } from './types.js';

const COMMANDS = new Set<TuiCommandName>([
  'help',
  'status',
  'jobs',
  'open',
  'resume',
  'new',
  'design',
  'modify',
  'allow',
  'quit',
]);

export function parseTuiCommand(input: string): TuiCommand | null {
  const raw = input.trim();
  if (!raw.startsWith('/')) {
    return null;
  }

  const withoutSlash = raw.slice(1).trim();
  const firstSpace = withoutSlash.search(/\s/);
  const command = (firstSpace === -1 ? withoutSlash : withoutSlash.slice(0, firstSpace)).toLowerCase();
  const args = firstSpace === -1 ? '' : withoutSlash.slice(firstSpace + 1).trim();
  const name = COMMANDS.has(command as TuiCommandName) ? (command as TuiCommandName) : 'unknown';
  return { name, args, raw };
}
