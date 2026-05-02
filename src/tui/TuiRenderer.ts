import path from 'node:path';

import { WORKSPACE_ROOT } from '../config/projectPaths.js';
import { colorBoldRed, colorRed, writeStdout } from '../utils/runtimeSupport.js';
import type { TuiSessionState } from './types.js';

export class TuiRenderer {
  printWelcome(state: TuiSessionState): void {
    writeStdout(
      [
        '',
        'actoviq-circuit-agent TUI',
        `workspace: ${WORKSPACE_ROOT}`,
        `allow: ${state.allowMode}`,
        `active job: ${state.activeJobId ?? '(none)'}`,
        '',
        '输入自然语言与 Agent 对话；输入 /help 查看命令。',
        '',
      ].join('\n'),
    );
  }

  printStatus(state: TuiSessionState): void {
    writeStdout(
      [
        '',
        '[status]',
        `session: ${state.sessionId}`,
        `allow: ${state.allowMode}`,
        `active job: ${state.activeJobId ?? '(none)'}`,
        `active root: ${state.activeJobRoot ? path.normalize(state.activeJobRoot) : '(none)'}`,
        `conversation session: ${state.conversationSessionId ?? '(lazy)'}`,
        '',
      ].join('\n'),
    );
  }

  printHelp(): void {
    writeStdout(
      [
        '',
        '[commands]',
        '/help                  显示命令帮助',
        '/status                显示当前 session、job、权限和阶段状态',
        '/jobs                  列出最近 jobs',
        '/open <artifact>       打印当前 job 的 artifact 摘要，artifact 可为 manifest/summary/design-report/netlist/review/svg',
        '/resume <job-id|path>  继续未完成 job',
        '/new                   清空 active job，开始新任务上下文',
        '/design <text>         显式启动设计 workflow',
        '/modify <text>         基于当前 active job 启动 revision',
        '/allow                 查看当前权限',
        '/allow all             auto allow 全部阶段',
        '/allow execution       只 auto allow 执行过程，规划文档仍需确认',
        '/allow manual          全部阶段都要求确认',
        '/quit                  退出',
        '',
      ].join('\n'),
    );
  }

  printError(message: string): void {
    writeStdout(colorBoldRed(`[error] ${message}\n`));
  }

  printWarning(message: string): void {
    writeStdout(colorRed(`[warn] ${message}\n`));
  }

  printInfo(message: string): void {
    writeStdout(`${message}\n`);
  }
}
