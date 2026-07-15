import type { ChatMessage, ConversationSummary } from '../types';

export const CHAT_HISTORY_STORAGE_KEY = 'actoviq.desktop.chat-history.v1';
export const MAX_STORED_CONVERSATIONS = 50;

export interface PersistedChatHistory {
  version: 1;
  conversationId: string;
  conversations: ConversationSummary[];
  conversationMessages: Record<string, ChatMessage[]>;
  savedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeMessage(value: unknown): ChatMessage | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || typeof value.content !== 'string') return null;
  if (value.role !== 'user' && value.role !== 'assistant' && value.role !== 'system' && value.role !== 'tool') {
    return null;
  }
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
  };
}

function sanitizeConversation(value: unknown): ConversationSummary | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  return {
    id: value.id,
    title: typeof value.title === 'string' && value.title.trim() ? value.title.trim().slice(0, 80) : 'New conversation',
    lastMessage: typeof value.lastMessage === 'string' ? value.lastMessage : '',
    messageCount: typeof value.messageCount === 'number' ? value.messageCount : 0,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
    jobId: typeof value.jobId === 'string' ? value.jobId : undefined,
    titleLocked: Boolean(value.titleLocked),
  };
}

export function loadPersistedChatHistory(): PersistedChatHistory | null {
  try {
    const raw = localStorage.getItem(CHAT_HISTORY_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1) return null;

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
      version: 1,
      conversationId,
      conversations: conversations
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_STORED_CONVERSATIONS),
      conversationMessages,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function persistChatHistory(snapshot: {
  conversationId: string;
  conversations: ConversationSummary[];
  conversationMessages: Record<string, ChatMessage[]>;
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
    const payload: PersistedChatHistory = {
      version: 1,
      conversationId: keepIds.has(snapshot.conversationId) ? snapshot.conversationId : conversations[0]?.id ?? '',
      conversations,
      conversationMessages,
      savedAt: Date.now(),
    };
    localStorage.setItem(CHAT_HISTORY_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore quota / private-mode failures; in-memory history still works.
  }
}
