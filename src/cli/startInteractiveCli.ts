import { createInterface } from 'node:readline/promises';
import process from 'node:process';

import { promptForRequirement } from './promptForRequirement.js';
import { runCircuitDesignWorkflow, type ApprovalPolicy } from '../workflow/circuitDesignWorkflow.js';

export interface StartInteractiveCliOptions {
  requirement?: string;
  autoApprove?: boolean;
  approvalPolicy?: ApprovalPolicy;
  jobName?: string;
  resumeJob?: string;
}

export interface WorkflowReadline {
  question(query: string): Promise<string>;
}

export async function startInteractiveCli(options: StartInteractiveCliOptions): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });

  try {
    const requirement = options.resumeJob
      ? options.requirement?.trim() ?? ''
      : await promptForRequirement(rl, options.requirement);
    await runCircuitDesignWorkflow({
      rl,
      requirement,
      autoApprove: options.autoApprove ?? false,
      approvalPolicy: options.approvalPolicy,
      jobName: options.jobName,
      resumeJob: options.resumeJob,
    });
  } finally {
    rl.close();
  }
}
