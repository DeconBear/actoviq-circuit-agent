import type { ApprovalPolicy } from '../workflow/circuitDesignWorkflow.js';

export type TuiCommandName =
  | 'help'
  | 'status'
  | 'jobs'
  | 'open'
  | 'resume'
  | 'new'
  | 'design'
  | 'modify'
  | 'allow'
  | 'quit'
  | 'unknown';

export interface TuiCommand {
  name: TuiCommandName;
  args: string;
  raw: string;
}

export interface TuiSessionState {
  sessionId: string;
  allowMode: ApprovalPolicy;
  activeJobId?: string;
  activeJobRoot?: string;
  conversationSessionId?: string;
  createdAt: string;
  lastUpdatedAt: string;
}

export interface TuiTranscriptEntry {
  role: 'user' | 'agent' | 'system' | 'tool';
  content: string;
  createdAt: string;
}
