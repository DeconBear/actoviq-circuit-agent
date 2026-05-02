import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import process from 'node:process';

import { writeStdout } from '../utils/runtimeSupport.js';
import {
  runCircuitDesignWorkflow,
  type ApprovalPolicy,
  type WorkflowRunSummary,
} from '../workflow/circuitDesignWorkflow.js';
import {
  type ArtifactName,
  listRecentJobs,
  readArtifactSummary,
  resolveJobReference,
} from './artifactReader.js';
import { parseTuiCommand } from './commandParser.js';
import { TuiConversationAgent } from './conversationAgent.js';
import { TuiRenderer } from './TuiRenderer.js';
import { TuiStateStore } from './TuiState.js';
import { buildRevisionRequirement } from './workflowTools.js';

async function askLine(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string | null> {
  try {
    return await rl.question(prompt);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') {
      return null;
    }
    throw error;
  }
}

function parseAllowMode(value: string): ApprovalPolicy | null {
  const mode = value.trim().toLowerCase();
  if (mode === 'manual' || mode === 'execution' || mode === 'all') {
    return mode;
  }
  return null;
}

async function setActiveJobFromSummary(stateStore: TuiStateStore, summary: WorkflowRunSummary): Promise<void> {
  await stateStore.setActiveJob(summary);
}

export async function startTuiApp(): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });
  const stateStore = await TuiStateStore.load();
  const renderer = new TuiRenderer();
  const conversation = new TuiConversationAgent(stateStore, rl);

  renderer.printWelcome(stateStore.snapshot());

  try {
    while (true) {
      const answer = await askLine(rl, '> ');
      if (answer === null) {
        break;
      }
      const input = answer.trim();
      if (!input) {
        continue;
      }

      const command = parseTuiCommand(input);
      if (!command) {
        await conversation.send(input);
        continue;
      }

      if (command.name === 'quit') {
        renderer.printInfo('再见。');
        break;
      }

      if (command.name === 'help') {
        renderer.printHelp();
        continue;
      }

      if (command.name === 'status') {
        renderer.printStatus(stateStore.snapshot());
        continue;
      }

      if (command.name === 'allow') {
        if (!command.args) {
          renderer.printInfo(`[allow] ${stateStore.snapshot().allowMode}`);
          continue;
        }
        const mode = parseAllowMode(command.args);
        if (!mode) {
          renderer.printError('权限模式必须是 manual、execution 或 all。');
          continue;
        }
        await stateStore.setAllowMode(mode);
        conversation.resetSession();
        renderer.printInfo(`[allow] 已设置为 ${mode}`);
        renderer.printInfo('[allow] 已重置对话 session，下一轮 Agent 会使用新的权限语义。');
        continue;
      }

      if (command.name === 'jobs') {
        const jobs = await listRecentJobs();
        if (jobs.length === 0) {
          renderer.printInfo('[jobs] 当前 workspace 还没有 job。');
          continue;
        }
        writeStdout('\n[jobs]\n');
        for (const job of jobs) {
          writeStdout(`- ${job.jobId}  ${job.jobRoot}\n`);
        }
        writeStdout('\n');
        continue;
      }

      if (command.name === 'open') {
        const state = stateStore.snapshot();
        if (!state.activeJobRoot) {
          renderer.printError('当前没有 active job。请先运行 /design、/resume 或让 Agent 启动一个设计。');
          continue;
        }
        const artifact = (command.args || 'summary') as ArtifactName;
        if (!['manifest', 'summary', 'design-report', 'netlist', 'review', 'svg'].includes(artifact)) {
          renderer.printError('artifact 必须是 manifest/summary/design-report/netlist/review/svg。');
          continue;
        }
        const summary = await readArtifactSummary(state.activeJobRoot, artifact);
        writeStdout(`\n[artifact] ${summary.path}\n`);
        writeStdout(`[exists] ${summary.exists}\n`);
        if (summary.preview) {
          writeStdout(`[preview] ${summary.preview}\n`);
        }
        writeStdout('\n');
        continue;
      }

      if (command.name === 'resume') {
        if (!command.args) {
          renderer.printError('用法: /resume <job-id|path>');
          continue;
        }
        const summary = await runCircuitDesignWorkflow({
          rl,
          requirement: '',
          resumeJob: command.args,
          approvalPolicy: stateStore.snapshot().allowMode,
        });
        await setActiveJobFromSummary(stateStore, summary);
        continue;
      }

      if (command.name === 'new') {
        await stateStore.clearActiveJob();
        renderer.printInfo('[new] 已清空 active job。后续自然语言会作为新的对话上下文处理。');
        continue;
      }

      if (command.name === 'design') {
        if (!command.args) {
          renderer.printError('用法: /design <自然语言电路需求>');
          continue;
        }
        const summary = await runCircuitDesignWorkflow({
          rl,
          requirement: command.args,
          approvalPolicy: stateStore.snapshot().allowMode,
        });
        await setActiveJobFromSummary(stateStore, summary);
        continue;
      }

      if (command.name === 'modify') {
        if (!command.args) {
          renderer.printError('用法: /modify <基于当前 active job 的修改要求>');
          continue;
        }
        const state = stateStore.snapshot();
        if (!state.activeJobId || !state.activeJobRoot) {
          renderer.printError('当前没有 active job，无法修订。请先完成一个设计，或使用 /resume <job-id>。');
          continue;
        }
        const baseJob = await resolveJobReference(state.activeJobRoot);
        const revisionParentDir = path.resolve(baseJob.jobRoot, 'revisions');
        await mkdir(revisionParentDir, { recursive: true });
        const requirement = await buildRevisionRequirement({
          baseJobId: baseJob.jobId,
          baseJobRoot: baseJob.jobRoot,
          revisionRequest: command.args,
        });
        const summary = await runCircuitDesignWorkflow({
          rl,
          requirement,
          jobName: `revision-${baseJob.jobId}`,
          jobParentDir: revisionParentDir,
          approvalPolicy: state.allowMode,
        });
        await setActiveJobFromSummary(stateStore, summary);
        continue;
      }

      renderer.printError(`未知命令: ${command.raw}。输入 /help 查看可用命令。`);
    }
  } finally {
    await conversation.close();
    rl.close();
  }
}
