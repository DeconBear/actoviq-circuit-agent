import type { ChatMessage, ChatMessageTool, ConversationSummary } from '../types';

export const CHAT_HISTORY_STORAGE_KEY = 'actoviq.desktop.chat-history.v2';
export const CHAT_HISTORY_STORAGE_KEY_V1 = 'actoviq.desktop.chat-history.v1';
export const MAX_STORED_CONVERSATIONS = 50;

export interface PersistedChatHistory {
  version: 2;
  conversationId: string;
  conversations: ConversationSummary[];
  conversationMessages: Record<string, ChatMessage[]>;
  /** Last active conversation id per circuit project. */
  activeConversationByProject: Record<string, string>;
  savedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeTool(value: unknown): ChatMessageTool | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') return null;
  if (value.status !== 'running' && value.status !== 'done' && value.status !== 'error') return null;
  return {
    id: value.id,
    name: value.name,
    status: value.status,
    label: typeof value.label === 'string' ? value.label : undefined,
    detail: typeof value.detail === 'string' ? value.detail : undefined,
  };
}

function sanitizeMessage(value: unknown): ChatMessage | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || typeof value.content !== 'string') return null;
  if (value.role !== 'user' && value.role !== 'assistant' && value.role !== 'system' && value.role !== 'tool') {
    return null;
  }
  const tools = Array.isArray(value.tools)
    ? value.tools.map(sanitizeTool).filter((entry): entry is ChatMessageTool => Boolean(entry))
    : undefined;
  return {
    id: value.id,
    role: value.role,
    content: value.content,
    timestamp: typeof value.timestamp === 'number' ? value.timestamp : Date.now(),
    isError: Boolean(value.isError),
    conversationId: typeof value.conversationId === 'string' ? value.conversationId : undefined,
    runId: typeof value.runId === 'string' ? value.runId : undefined,
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
    model: typeof value.model === 'string' ? value.model : undefined,
    usage: isRecord(value.usage) ? value.usage : undefined,
    tools: tools && tools.length > 0 ? tools : undefined,
    thinking: typeof value.thinking === 'string' ? value.thinking : undefined,
  };
}

function sanitizeConversation(value: unknown): ConversationSummary | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  const projectId = typeof value.projectId === 'string' && value.projectId.trim()
    ? value.projectId.trim()
    : value.projectId === null
      ? null
      : undefined;
  return {
    id: value.id,
    title: typeof value.title === 'string' && value.title.trim() ? value.title.trim().slice(0, 80) : 'New conversation',
    lastMessage: typeof value.lastMessage === 'string' ? value.lastMessage : '',
    messageCount: typeof value.messageCount === 'number' ? value.messageCount : 0,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
    jobId: typeof value.jobId === 'string' ? value.jobId : undefined,
    titleLocked: Boolean(value.titleLocked),
    projectId,
  };
}

function sanitizeActiveByProject(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const next: Record<string, string> = {};
  for (const [projectId, conversationId] of Object.entries(value)) {
    if (typeof conversationId === 'string' && conversationId) {
      next[projectId] = conversationId;
    }
  }
  return next;
}

function normalizeSnapshot(parsed: Record<string, unknown>): PersistedChatHistory | null {
  const conversations = Array.isArray(parsed.conversations)
    ? parsed.conversations.map(sanitizeConversation).filter((entry): entry is ConversationSummary => Boolean(entry))
    : [];
  const conversationMessages: Record<string, ChatMessage[]> = {};
  if (isRecord(parsed.conversationMessages)) {
    for (const [id, messages] of Object.entries(parsed.conversationMessages)) {
      if (!Array.isArray(messages)) continue;
      conversationMessages[id] = messages
        .map(sanitizeMessage)
        .filter((entry): entry is ChatMessage => Boolean(entry));
    }
  }

  const conversationId = typeof parsed.conversationId === 'string' && conversations.some((entry) => entry.id === parsed.conversationId)
    ? parsed.conversationId
    : conversations[0]?.id ?? '';

  return {
    version: 2,
    conversationId,
    conversations: conversations
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_STORED_CONVERSATIONS),
    conversationMessages,
    activeConversationByProject: sanitizeActiveByProject(parsed.activeConversationByProject),
    savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
  };
}

export function loadPersistedChatHistory(): PersistedChatHistory | null {
  try {
    const rawV2 = localStorage.getItem(CHAT_HISTORY_STORAGE_KEY);
    const rawV1 = localStorage.getItem(CHAT_HISTORY_STORAGE_KEY_V1);
    const raw = rawV2 || rawV1;
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || (parsed.version !== 1 && parsed.version !== 2)) return null;
    const snapshot = normalizeSnapshot(parsed);
    if (snapshot && parsed.version === 1) {
      // Rewrite as v2 on next persist; keep legacy conversations as unscoped.
      snapshot.conversations = snapshot.conversations.map((entry) => ({
        ...entry,
        projectId: entry.projectId ?? null,
      }));
    }
    return snapshot;
  } catch {
    return null;
  }
}

export function persistChatHistory(snapshot: {
  conversationId: string;
  conversations: ConversationSummary[];
  conversationMessages: Record<string, ChatMessage[]>;
  activeConversationByProject?: Record<string, string>;
}): void {
  try {
    const conversations = snapshot.conversations
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_STORED_CONVERSATIONS);
    const keepIds = new Set(conversations.map((entry) => entry.id));
    const conversationMessages: Record<string, ChatMessage[]> = {};
    for (const id of keepIds) {
      conversationMessages[id] = snapshot.conversationMessages[id] ?? [];
    }
    const activeConversationByProject: Record<string, string> = {};
    for (const [projectId, conversationId] of Object.entries(snapshot.activeConversationByProject ?? {})) {
      if (keepIds.has(conversationId)) {
        activeConversationByProject[projectId] = conversationId;
      }
    }
    const payload: PersistedChatHistory = {
      version: 2,
      conversationId: keepIds.has(snapshot.conversationId) ? snapshot.conversationId : conversations[0]?.id ?? '',
      conversations,
      conversationMessages,
      activeConversationByProject,
      savedAt: Date.now(),
    };
    localStorage.setItem(CHAT_HISTORY_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore quota / private-mode failures; in-memory history still works.
  }
}

export function conversationHasContent(
  entry: ConversationSummary,
  conversationMessages?: Record<string, ChatMessage[]>,
): boolean {
  if ((entry.messageCount ?? 0) > 0) return true;
  return (conversationMessages?.[entry.id]?.length ?? 0) > 0;
}

/**
 * Conversations visible for a circuit project.
 * Includes project-scoped chats, plus unscoped legacy chats that still have content
 * so history is not hidden after the v1→v2 migration.
 */
export function conversationsForProject(
  conversations: ConversationSummary[],
  projectId: string | null | undefined,
  conversationMessages?: Record<string, ChatMessage[]>,
): ConversationSummary[] {
  if (projectId) {
    const scoped = conversations.filter((entry) => entry.projectId === projectId);
    const legacy = conversations.filter(
      (entry) => entry.projectId == null && conversationHasContent(entry, conversationMessages),
    );
    const byId = new Map<string, ConversationSummary>();
    for (const entry of [...scoped, ...legacy]) {
      byId.set(entry.id, entry);
    }
    return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return conversations
    .filter((entry) => entry.projectId == null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Reassign unscoped legacy conversations onto a project (one-time claim). */
export function claimLegacyConversationsForProject(
  conversations: ConversationSummary[],
  projectId: string,
  conversationMessages?: Record<string, ChatMessage[]>,
): ConversationSummary[] {
  const hasScopedContent = conversations.some(
    (entry) => entry.projectId === projectId && conversationHasContent(entry, conversationMessages),
  );
  if (hasScopedContent) return conversations;
  return conversations.map((entry) => (
    entry.projectId == null && conversationHasContent(entry, conversationMessages)
      ? { ...entry, projectId }
      : entry
  ));
}
