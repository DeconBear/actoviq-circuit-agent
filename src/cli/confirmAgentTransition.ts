import type { WorkflowReadline } from './startInteractiveCli.js';
import { writeStdout } from '../utils/runtimeSupport.js';

export async function confirmAgentTransition(
  rl: WorkflowReadline,
  currentStage: string,
  nextStage: string,
  autoApprove = false,
): Promise<boolean> {
  if (autoApprove) {
    writeStdout(`\n[auto-approve] ${currentStage} -> ${nextStage}\n`);
    return true;
  }

  const answer = (
    await rl.question(`\n从 ${currentStage} 切换到 ${nextStage} 前请输入 y 确认: `)
  )
    .trim()
    .toLowerCase();

  return answer === 'y';
}
