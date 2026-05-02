import type { Interface } from 'node:readline/promises';

import { writeStdout } from '../utils/runtimeSupport.js';

export async function promptForRequirement(
  rl: Interface,
  prefilled?: string,
): Promise<string> {
  const preset = prefilled?.trim();
  if (preset) {
    return preset;
  }

  writeStdout(
    [
      '',
      '请输入电路设计需求。',
      '支持多行输入；输入 END 结束。',
      '如果需要保留段落空行，请连续输入两个空行结束。',
      '',
    ].join('\n'),
  );

  const lines: string[] = [];
  let blankLineStreak = 0;

  while (true) {
    const prompt = lines.length === 0 ? 'Requirement> ' : '... ';
    const line = await rl.question(prompt);
    const trimmed = line.trim();

    if (lines.length === 0 && !trimmed) {
      continue;
    }

    if (trimmed.toUpperCase() === 'END') {
      break;
    }

    if (!trimmed) {
      blankLineStreak += 1;
      if (blankLineStreak >= 2) {
        while (lines.at(-1) === '') {
          lines.pop();
        }
        break;
      }
      lines.push('');
      continue;
    }

    blankLineStreak = 0;
    lines.push(line);
  }

  return lines.join('\n').trimEnd();
}
