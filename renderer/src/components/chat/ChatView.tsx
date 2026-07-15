import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  ChevronDown,
  CircuitBoard,
  FileCode2,
  FileText,
  History,
  MessageSquarePlus,
  Pencil,
  Send,
  Square,
  TerminalSquare,
  Trash2,
  Waves,
  Wrench,
  X,
} from 'lucide-react';
import { useAppStore } from '../../store/appStore';
import { CHAT_MODEL_TIER_OPTIONS, type ChatModelTier } from '../../modelTiers';
import { createSafeMarkdownParser, escapeHtml } from '../../utils/markdown';
import './ChatView.css';

export interface ChatRunToolView {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error';
  label?: string;
}

export interface ChatRunView {
  status: 'idle' | 'starting' | 'streaming' | 'repairing' | 'completed' | 'cancelled' | 'error';
  text: string;
  thinking?: string;
  label?: string;
  provider?: string;
  model?: string;
  runId?: string;
  sessionId?: string;
  tools?: ChatRunToolView[];
  usage?: Record<string, unknown>;
}

interface Props {
  onSend: (text: string, modelTier: ChatModelTier) => void;
  onStop?: () => void;
  onClose?: () => void;
  /** Called after the active conversation changes (switch / new / delete / clear). */
  onConversationChange?: (conversationId: string) => void;
  isPending?: boolean;
  run?: ChatRunView | null;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatHistoryTime(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const chatMarkdown = createSafeMarkdownParser({
  codeBlockClassName: 'code-block',
  showLanguageLabel: true,
});

function renderMarkdown(content: string): string {
  try {
    return chatMarkdown.parse(content) as string;
  } catch {
    return escapeHtml(content);
  }
}

function BubbleContent({ msg }: { msg: { role: string; content: string } }) {
  const html = useMemo(() => (
    msg.role === 'user'
      ? escapeHtml(msg.content).replace(/\n/g, '<br/>')
      : renderMarkdown(msg.content)
  ), [msg.content, msg.role]);

  return (
    <div
      className={msg.role === 'user' ? 'chat-message__plain' : 'markdown-content chat-markdown'}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function formatUsage(usage?: Record<string, unknown>): string | null {
  if (!usage) return null;
  const input = usage.input_tokens ?? usage.inputTokens;
  const output = usage.output_tokens ?? usage.outputTokens;
  const total = usage.total_tokens ?? usage.totalTokens;
  if (typeof total === 'number') return `${total.toLocaleString()} tokens`;
  if (typeof input === 'number' || typeof output === 'number') {
    return `${Number(input ?? 0).toLocaleString()} in · ${Number(output ?? 0).toLocaleString()} out`;
  }
  return null;
}

function normalizeTier(value: unknown): ChatModelTier {
  return value === 'basic' || value === 'professional' ? value : 'medium';
}

export function ChatView({
  onSend,
  onStop,
  onClose,
  onConversationChange,
  isPending = false,
  run = null,
}: Props) {
  const [input, setInput] = useState('');
  const [modelTier, setModelTier] = useState<ChatModelTier>('medium');
  const [tierMenuOpen, setTierMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const tierMenuRef = useRef<HTMLDivElement>(null);
  const historyPanelRef = useRef<HTMLDivElement>(null);
  const messages = useAppStore((state) => state.messages);
  const outputText = useAppStore((state) => state.outputText);
  const isRunning = useAppStore((state) => state.isRunning);
  const conversationId = useAppStore((state) => state.conversationId);
  const conversations = useAppStore((state) => state.conversations);
  const netlistContent = useAppStore((state) => state.netlistContent);
  const svgContent = useAppStore((state) => state.svgContent);
  const reportContent = useAppStore((state) => state.reportContent);
  const simulationData = useAppStore((state) => state.simulationData);
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const activeWorkspace = useAppStore((state) => state.activeWorkspace);
  const currentConversation = conversations.find((entry) => entry.id === conversationId);
  const runIsActive = Boolean(run && ['starting', 'streaming', 'repairing'].includes(run.status));
  const selectedTier = CHAT_MODEL_TIER_OPTIONS.find((option) => option.id === modelTier)
    ?? CHAT_MODEL_TIER_OPTIONS[1]
    ?? { id: 'medium' as const, label: 'Medium model', shortLabel: 'Medium' };

  const filteredConversations = useMemo(() => {
    const query = historyQuery.trim().toLowerCase();
    const sorted = conversations.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    if (!query) return sorted;
    return sorted.filter((entry) => (
      entry.title.toLowerCase().includes(query)
      || entry.lastMessage.toLowerCase().includes(query)
    ));
  }, [conversations, historyQuery]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!window.electronAPI) return;
      try {
        const settings = await window.electronAPI.getSettings();
        if (!cancelled) setModelTier(normalizeTier(settings.preferredChatTier));
      } catch {
        // Keep the default medium tier when settings cannot be loaded.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, outputText, run?.text, run?.thinking, run?.tools]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(160, Math.max(42, textarea.scrollHeight))}px`;
  }, [input]);

  useEffect(() => {
    if (!tierMenuOpen && !historyOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (tierMenuOpen && !tierMenuRef.current?.contains(target)) setTierMenuOpen(false);
      if (historyOpen && !historyPanelRef.current?.contains(target)) {
        setHistoryOpen(false);
        setEditingId(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setTierMenuOpen(false);
        setHistoryOpen(false);
        setEditingId(null);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [tierMenuOpen, historyOpen]);

  const persistTier = useCallback(async (tier: ChatModelTier) => {
    if (!window.electronAPI) return;
    try {
      const settings = await window.electronAPI.getSettings();
      await window.electronAPI.saveSettings({ ...settings, preferredChatTier: tier });
    } catch {
      // Selection still applies for the current session even if persist fails.
    }
  }, []);

  const handleTierChange = useCallback((tier: ChatModelTier) => {
    setModelTier(tier);
    setTierMenuOpen(false);
    void persistTier(tier);
  }, [persistTier]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || isPending) return;
    onSend(trimmed, modelTier);
    setInput('');
  }, [input, isPending, modelTier, onSend]);

  const handleNewConversation = () => {
    const id = useAppStore.getState().newConversation();
    onConversationChange?.(id);
    setHistoryOpen(false);
    setInput('');
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const handleSelectHistory = (id: string) => {
    if (id === conversationId) {
      setHistoryOpen(false);
      return;
    }
    useAppStore.getState().setConversationId(id);
    onConversationChange?.(id);
    setHistoryOpen(false);
    setEditingId(null);
  };

  const beginRename = (id: string, title: string) => {
    setEditingId(id);
    setEditingTitle(title);
  };

  const commitRename = () => {
    if (!editingId) return;
    const next = editingTitle.trim();
    if (next) useAppStore.getState().renameConversation(editingId, next);
    setEditingId(null);
  };

  const handleDeleteConversation = (id: string) => {
    const target = conversations.find((entry) => entry.id === id);
    const label = target?.title || 'this conversation';
    if (!window.confirm(`Delete “${label}”? This cannot be undone.`)) return;
    useAppStore.getState().deleteConversation(id);
    onConversationChange?.(useAppStore.getState().conversationId);
    if (editingId === id) setEditingId(null);
  };

  const handleClearAll = () => {
    if (conversations.length === 0) return;
    if (!window.confirm(`Delete all ${conversations.length} conversations? This cannot be undone.`)) return;
    useAppStore.getState().clearAllConversations();
    onConversationChange?.('');
    setHistoryOpen(false);
    setEditingId(null);
  };

  const artifacts = [
    { key: 'design', label: 'Design', icon: CircuitBoard, visible: Boolean(svgContent || netlistContent) },
    { key: 'netlist', label: 'Netlist', icon: FileCode2, visible: Boolean(netlistContent) },
    { key: 'simulation', label: 'Simulation', icon: Waves, visible: Boolean(simulationData) },
    { key: 'report', label: 'Report', icon: FileText, visible: Boolean(reportContent) },
  ] as const;

  const usageLabel = formatUsage(run?.usage);
  const providerModel = [run?.provider, run?.model].filter(Boolean).join(' · ') || 'Actoviq Agent SDK';
  const contextLabel = activeProjectId || activeWorkspace?.name || 'workspace';

  return (
    <section className="chat-panel" aria-label="Actoviq circuit assistant">
      <header className="chat-panel__header">
        <div className="chat-panel__identity">
          <span className={`chat-panel__status chat-panel__status--${runIsActive ? 'active' : run?.status === 'error' ? 'error' : 'idle'}`} />
          <div className="chat-panel__title-group">
            <strong>{currentConversation?.title || messages[0]?.content.slice(0, 44) || 'New conversation'}</strong>
            <span title={run?.sessionId}>{providerModel}</span>
          </div>
        </div>
        <div className="chat-panel__actions">
          <div className="chat-history" ref={historyPanelRef}>
            <button
              type="button"
              className={`chat-icon-button${historyOpen ? ' is-active' : ''}`}
              onClick={() => setHistoryOpen((open) => !open)}
              title="Conversation history"
              aria-label="Conversation history"
              aria-expanded={historyOpen}
              data-testid="chat-history-toggle"
            >
              <History size={17} aria-hidden="true" />
            </button>
            {historyOpen && (
              <div className="chat-history__panel" role="dialog" aria-label="Conversation history" data-testid="chat-history-panel">
                <div className="chat-history__header">
                  <strong>History</strong>
                  <button type="button" className="chat-history__new" onClick={handleNewConversation} data-testid="chat-history-new">
                    <MessageSquarePlus size={14} aria-hidden="true" />
                    New
                  </button>
                </div>
                <input
                  className="chat-history__search"
                  value={historyQuery}
                  onChange={(event) => setHistoryQuery(event.target.value)}
                  placeholder="Search conversations"
                  aria-label="Search conversations"
                  data-testid="chat-history-search"
                />
                <div className="chat-history__list">
                  {filteredConversations.length === 0 ? (
                    <div className="chat-history__empty">
                      {conversations.length === 0 ? 'No conversations yet.' : 'No matches.'}
                    </div>
                  ) : filteredConversations.map((entry) => {
                    const isActive = entry.id === conversationId;
                    const isEditing = editingId === entry.id;
                    return (
                      <div
                        key={entry.id}
                        className={`chat-history__item${isActive ? ' is-active' : ''}`}
                        data-testid={`chat-history-item-${entry.id}`}
                      >
                        {isEditing ? (
                          <form
                            className="chat-history__rename"
                            onSubmit={(event) => {
                              event.preventDefault();
                              commitRename();
                            }}
                          >
                            <input
                              value={editingTitle}
                              onChange={(event) => setEditingTitle(event.target.value)}
                              autoFocus
                              onBlur={commitRename}
                              aria-label="Rename conversation"
                              data-testid="chat-history-rename-input"
                            />
                          </form>
                        ) : (
                          <button
                            type="button"
                            className="chat-history__select"
                            onClick={() => handleSelectHistory(entry.id)}
                          >
                            <span className="chat-history__title">{entry.title || 'New conversation'}</span>
                            <span className="chat-history__meta">
                              {entry.messageCount} msgs · {formatHistoryTime(entry.updatedAt)}
                            </span>
                          </button>
                        )}
                        <div className="chat-history__item-actions">
                          <button
                            type="button"
                            className="chat-history__icon-btn"
                            title="Rename"
                            aria-label={`Rename ${entry.title}`}
                            onClick={() => beginRename(entry.id, entry.title)}
                            data-testid={`chat-history-rename-${entry.id}`}
                          >
                            <Pencil size={13} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="chat-history__icon-btn chat-history__icon-btn--danger"
                            title="Delete"
                            aria-label={`Delete ${entry.title}`}
                            onClick={() => handleDeleteConversation(entry.id)}
                            data-testid={`chat-history-delete-${entry.id}`}
                          >
                            <Trash2 size={13} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {conversations.length > 0 && (
                  <div className="chat-history__footer">
                    <button type="button" onClick={handleClearAll} data-testid="chat-history-clear-all">
                      Clear all
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            className="chat-icon-button"
            onClick={handleNewConversation}
            title="New conversation"
            aria-label="New conversation"
            data-testid="chat-new-conversation"
          >
            <MessageSquarePlus size={17} aria-hidden="true" />
          </button>
          {onClose ? (
            <button
              type="button"
              className="chat-icon-button"
              onClick={onClose}
              title="Close chat"
              aria-label="Close chat"
              data-testid="chat-close"
            >
              <X size={17} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>

      <div className="chat-panel__messages" data-testid="chat-message-list">
        {messages.length === 0 && !outputText && !runIsActive && (
          <div className="chat-empty">
            <div className="chat-empty__icon"><CircuitBoard size={30} aria-hidden="true" /></div>
            <h2>Design with Actoviq</h2>
            <p>Describe a circuit, request a revision, or ask the built-in agent to compile, simulate, and explain the result.</p>
            <div className="chat-empty__examples">
              <button type="button" onClick={() => setInput('Design a 1 kHz RC low-pass filter and verify its cutoff frequency.')}>RC low-pass filter</button>
              <button type="button" onClick={() => setInput('Review the current circuit and fix blocking ERC issues.')}>Review current design</button>
            </div>
          </div>
        )}

        {messages.map((message) => (
          <article
            key={message.id}
            className={`chat-message chat-message--${message.role === 'user' ? 'user' : 'assistant'}${message.isError ? ' chat-message--error' : ''}`}
          >
            {message.role !== 'user' && (
              <div className="chat-message__avatar" aria-hidden="true"><Bot size={15} /></div>
            )}
            <div className="chat-message__body">
              <div className="chat-message__meta">
                <span>{message.role === 'user' ? 'You' : message.isError ? 'Actoviq · error' : 'Actoviq'}</span>
                <time>{formatTime(message.timestamp)}</time>
              </div>
              <BubbleContent msg={message} />
            </div>
          </article>
        ))}

        {runIsActive && run && (
          <article className="chat-message chat-message--assistant chat-message--stream" data-testid="chat-streaming-message">
            <div className="chat-message__avatar chat-message__avatar--pulse" aria-hidden="true"><Bot size={15} /></div>
            <div className="chat-message__body">
              <div className="chat-run-status">
                <span className="chat-run-status__spinner" />
                <span>{run.label || (run.status === 'repairing' ? 'Validating response' : 'Thinking')}</span>
              </div>
              {run.thinking && (
                <details className="chat-run-thinking">
                  <summary>Reasoning</summary>
                  <pre>{run.thinking}</pre>
                </details>
              )}
              {run.text && (
                <div
                  className="markdown-content chat-markdown chat-run-text"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(run.text) }}
                />
              )}
              {run.tools?.map((tool) => (
                <div className={`chat-tool-card chat-tool-card--${tool.status}`} key={tool.id}>
                  <Wrench size={14} aria-hidden="true" />
                  <span>{tool.name}</span>
                  <small>{tool.label || tool.status}</small>
                </div>
              ))}
            </div>
          </article>
        )}

        {artifacts.some((artifact) => artifact.visible) && (
          <div className="chat-artifacts" aria-label="Generated circuit artifacts">
            {artifacts.filter((artifact) => artifact.visible).map((artifact) => {
              const Icon = artifact.icon;
              return (
                <button
                  type="button"
                  key={artifact.key}
                  onClick={() => useAppStore.getState().setActiveTab(artifact.key)}
                >
                  <Icon size={14} aria-hidden="true" />
                  {artifact.label}
                </button>
              );
            })}
          </div>
        )}

        {outputText && (
          <details className="chat-execution-log">
            <summary><TerminalSquare size={14} aria-hidden="true" /> Execution log</summary>
            <pre>{outputText}</pre>
          </details>
        )}
        <div ref={bottomRef} />
      </div>

      <footer className="chat-composer-wrap">
        {(run?.label || usageLabel || isRunning) && (
          <div className="chat-composer-status">
            <span>{run?.label || (isRunning ? 'Circuit workflow is running' : '')}</span>
            {usageLabel && <span>{usageLabel}</span>}
          </div>
        )}
        <div className="chat-composer-shell">
          <div className="chat-composer-context" title={contextLabel}>
            <CircuitBoard size={12} aria-hidden="true" />
            <span>{contextLabel}</span>
          </div>
          <div className="chat-composer">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  handleSend();
                }
              }}
              placeholder={isPending ? 'Agent is responding…' : 'Ask Actoviq...'}
              aria-label="Message Actoviq Circuit Agent"
              data-testid="chat-composer"
              disabled={isPending && !runIsActive}
              rows={1}
            />
            <div className="chat-composer__toolbar">
              <div className="chat-composer__toolbar-spacer" />
              <div className="chat-model-picker" ref={tierMenuRef}>
                <button
                  type="button"
                  className="chat-model-picker__button"
                  onClick={() => setTierMenuOpen((open) => !open)}
                  aria-haspopup="listbox"
                  aria-expanded={tierMenuOpen}
                  data-testid="chat-model-tier"
                  title="Select model tier"
                >
                  <span>{selectedTier.shortLabel}</span>
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
                {tierMenuOpen && (
                  <ul className="chat-model-picker__menu" role="listbox" aria-label="Model tier">
                    {CHAT_MODEL_TIER_OPTIONS.map((option) => (
                      <li key={option.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={option.id === modelTier}
                          className={option.id === modelTier ? 'is-selected' : undefined}
                          onClick={() => handleTierChange(option.id)}
                          data-testid={`chat-model-tier-${option.id}`}
                        >
                          {option.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {runIsActive ? (
                <button
                  type="button"
                  className="chat-composer__action chat-composer__action--stop"
                  onClick={onStop}
                  title="Stop response"
                  aria-label="Stop response"
                  data-testid="chat-stop"
                >
                  <Square size={13} fill="currentColor" aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  className="chat-composer__action"
                  onClick={handleSend}
                  disabled={!input.trim() || isPending}
                  title="Send message"
                  aria-label="Send message"
                  data-testid="chat-send"
                >
                  <Send size={16} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        </div>
        <p className="chat-composer__hint">Enter to send · Shift+Enter for a new line</p>
      </footer>
    </section>
  );
}
