import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { WORKSPACE_ROOT } from '../config/projectPaths.js';
import type { ApprovalPolicy, WorkflowRunSummary } from '../workflow/circuitDesignWorkflow.js';
import type { TuiSessionState, TuiTranscriptEntry } from './types.js';

const DEFAULT_SESSION_ID = 'default';

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export class TuiStateStore {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly statePath: string;
  readonly transcriptPath: string;
  private state: TuiSessionState;

  private constructor(sessionId: string, state: TuiSessionState) {
    this.sessionId = sessionId;
    this.sessionDir = path.resolve(WORKSPACE_ROOT, 'sessions', sessionId);
    this.statePath = path.resolve(this.sessionDir, 'session-state.json');
    this.transcriptPath = path.resolve(this.sessionDir, 'transcript.ndjson');
    this.state = state;
  }

  static async load(sessionId = DEFAULT_SESSION_ID): Promise<TuiStateStore> {
    const sessionDir = path.resolve(WORKSPACE_ROOT, 'sessions', sessionId);
    const statePath = path.resolve(sessionDir, 'session-state.json');
    const now = new Date().toISOString();
    await mkdir(sessionDir, { recursive: true });

    const existing = await readJsonIfExists<TuiSessionState>(statePath);
    const store = new TuiStateStore(
      sessionId,
      existing ?? {
        sessionId,
        allowMode: 'manual',
        createdAt: now,
        lastUpdatedAt: now,
      },
    );
    await store.save();
    return store;
  }

  snapshot(): TuiSessionState {
    return { ...this.state };
  }

  async setAllowMode(allowMode: ApprovalPolicy): Promise<void> {
    await this.patchState({
      allowMode,
      conversationSessionId: undefined,
    });
  }

  async setConversationSessionId(conversationSessionId: string): Promise<void> {
    await this.patchState({
      conversationSessionId,
    });
  }

  async setActiveJob(summary: WorkflowRunSummary): Promise<void> {
    await this.patchState({
      activeJobId: summary.jobId,
      activeJobRoot: summary.jobRoot,
    });
  }

  async clearActiveJob(): Promise<void> {
    await this.patchState({
      activeJobId: undefined,
      activeJobRoot: undefined,
    });
  }

  async appendTranscript(entry: Omit<TuiTranscriptEntry, 'createdAt'>): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true });
    await appendFile(
      this.transcriptPath,
      `${JSON.stringify({ ...entry, createdAt: new Date().toISOString() })}\n`,
      'utf8',
    );
  }

  async recentTranscript(limit = 10): Promise<TuiTranscriptEntry[]> {
    try {
      const text = await readFile(this.transcriptPath, 'utf8');
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-limit)
        .map((line) => JSON.parse(line) as TuiTranscriptEntry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async save(): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true });
    await writeFile(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
  }

  private async patchState(partial: Partial<TuiSessionState>): Promise<void> {
    this.state = {
      ...this.state,
      ...partial,
      lastUpdatedAt: new Date().toISOString(),
    };
    await this.save();
  }
}
