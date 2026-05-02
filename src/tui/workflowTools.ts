import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Interface } from 'node:readline/promises';

import { tool, type AgentToolDefinition } from 'actoviq-agent-sdk';
import { z } from 'zod';

import { writeStdout } from '../utils/runtimeSupport.js';
import {
  type ApprovalPolicy,
  runCircuitDesignWorkflow,
  type WorkflowRunSummary,
} from '../workflow/circuitDesignWorkflow.js';
import {
  type ArtifactName,
  listRecentJobs,
  readArtifactSummary,
  resolveJobReference,
} from './artifactReader.js';
import { TuiStateStore } from './TuiState.js';

const approvalPolicySchema = z.enum(['manual', 'execution', 'all']);
const artifactNameSchema = z.enum(['manifest', 'summary', 'design-report', 'netlist', 'review', 'svg']);

interface TuiWorkflowToolOptions {
  stateStore: TuiStateStore;
  rl: Interface;
}

function effectiveApprovalPolicy(
  stateStore: TuiStateStore,
  _requested?: ApprovalPolicy,
): ApprovalPolicy {
  return stateStore.snapshot().allowMode;
}

async function updateActiveJob(stateStore: TuiStateStore, summary: WorkflowRunSummary): Promise<WorkflowRunSummary> {
  await stateStore.setActiveJob(summary);
  return summary;
}

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
    '请基于已有电路设计创建一个修订版，不要覆盖原始 job。',
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
    '- 保留原设计中仍然有效的拓扑解释和节点命名。',
    '- 明确写出本次修改改变了哪些模块、参数、验证目标和图纸输出。',
    '- 重新执行网表验证、仿真和三条渲染路径。',
  ].join('\n');
}

export function createTuiWorkflowTools(options: TuiWorkflowToolOptions): AgentToolDefinition[] {
  return [
    tool(
      {
        name: 'start_design_workflow',
        description: 'Start a new circuit-design workflow from a natural-language requirement.',
        inputSchema: z.object({
          requirement: z.string().min(1),
          jobNameHint: z.string().optional(),
          approvalPolicy: approvalPolicySchema.optional(),
        }),
      },
      async (input) => {
        const approvalPolicy = effectiveApprovalPolicy(options.stateStore, input.approvalPolicy);
        writeStdout(
          `\n[tui-tool] start_design_workflow approval=${approvalPolicy} requirement=${input.requirement.slice(0, 120)}\n`,
        );
        const summary = await runCircuitDesignWorkflow({
          rl: options.rl,
          requirement: input.requirement,
          jobName: input.jobNameHint,
          approvalPolicy,
        });
        return updateActiveJob(options.stateStore, summary);
      },
    ),
    tool(
      {
        name: 'start_revision_workflow',
        description: 'Start a revision workflow based on the active or specified previous job.',
        inputSchema: z.object({
          baseJobId: z.string().optional(),
          revisionRequest: z.string().min(1),
          approvalPolicy: approvalPolicySchema.optional(),
        }),
      },
      async (input) => {
        const state = options.stateStore.snapshot();
        const baseJobId = input.baseJobId ?? state.activeJobId;
        if (!baseJobId) {
          throw new Error('No active job is available for revision. Use /design first or pass baseJobId.');
        }

        const baseJob =
          state.activeJobId === baseJobId && state.activeJobRoot
            ? { jobId: baseJobId, jobRoot: state.activeJobRoot }
            : await resolveJobReference(baseJobId);
        const revisionParentDir = path.resolve(baseJob.jobRoot, 'revisions');
        await mkdir(revisionParentDir, { recursive: true });
        const requirement = await buildRevisionRequirement({
          baseJobId: baseJob.jobId,
          baseJobRoot: baseJob.jobRoot,
          revisionRequest: input.revisionRequest,
        });
        const approvalPolicy = effectiveApprovalPolicy(options.stateStore, input.approvalPolicy);
        writeStdout(
          `\n[tui-tool] start_revision_workflow base=${baseJob.jobId} approval=${approvalPolicy} request=${input.revisionRequest.slice(0, 120)}\n`,
        );
        const summary = await runCircuitDesignWorkflow({
          rl: options.rl,
          requirement,
          jobName: `revision-${baseJob.jobId}`,
          approvalPolicy,
          jobParentDir: revisionParentDir,
        });
        return updateActiveJob(options.stateStore, summary);
      },
    ),
    tool(
      {
        name: 'inspect_artifact',
        description: 'Read a short summary of an artifact from the active or specified job.',
        inputSchema: z.object({
          jobId: z.string().optional(),
          artifact: artifactNameSchema,
        }),
      },
      async (input) => {
        const state = options.stateStore.snapshot();
        const jobRoot =
          input.jobId || !state.activeJobRoot
            ? (await resolveJobReference(input.jobId ?? state.activeJobId ?? '')).jobRoot
            : state.activeJobRoot;
        return readArtifactSummary(jobRoot, input.artifact as ArtifactName);
      },
    ),
    tool(
      {
        name: 'list_recent_jobs',
        description: 'List recent workflow jobs and revisions in this workspace.',
        inputSchema: z.object({
          limit: z.number().int().min(1).max(50).optional(),
        }),
      },
      async (input) => listRecentJobs(input.limit ?? 12),
    ),
    tool(
      {
        name: 'set_approval_policy',
        description: 'Set the TUI workflow approval policy.',
        inputSchema: z.object({
          mode: approvalPolicySchema,
        }),
      },
      async (input) => {
        await options.stateStore.setAllowMode(input.mode);
        return { allowMode: input.mode };
      },
    ),
  ];
}
