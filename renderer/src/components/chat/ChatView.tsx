import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  CircuitBoard,
  FileCode2,
  FileText,
  MessageSquarePlus,
  Send,
  Square,
  TerminalSquare,
  Waves,
  Wrench,
  X,
} from 'lucide-react';
import { useAppStore } from '../../store/appStore';
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
  onSend: (text: string) => void;
  onStop?: () => void;
  onClose?: () => void;
  isPending?: boolean;
  run?: ChatRunView | null;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

export function ChatView({ onSend, onStop, onClose, isPending = false, run = null }: Props) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messages = useAppStore((state) => state.messages);
  const outputText = useAppStore((state) => state.outputText);
  const isRunning = useAppStore((state) => state.isRunning);
  const conversationId = useAppStore((state) => state.conversationId);
  const conversations = useAppStore((state) => state.conversations);
  const netlistContent = useAppStore((state) => state.netlistContent);
  const svgContent = useAppStore((state) => state.svgContent);
  const reportContent = useAppStore((state) => state.reportContent);
  const simulationData = useAppStore((state) => state.simulationData);
  const currentConversation = conversations.find((entry) => entry.id === conversationId);
  const runIsActive = Boolean(run && ['starting', 'streaming', 'repairing'].includes(run.status));

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, outputText, run?.text, run?.thinking, run?.tools]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(160, Math.max(42, textarea.scrollHeight))}px`;
  }, [input]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || isPending) return;
    onSend(trimmed);
    setInput('');
  }, [input, isPending, onSend]);

  const handleNewConversation = () => {
    useAppStore.getState().newConversation();
    setInput('');
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const artifacts = [
    { key: 'design', label: 'Design', icon: CircuitBoard, visible: Boolean(svgContent || netlistContent) },
    { key: 'netlist', label: 'Netlist', icon: FileCode2, visible: Boolean(netlistContent) },
    { key: 'simulation', label: 'Simulation', icon: Waves, visible: Boolean(simulationData) },
    { key: 'report', label: 'Report', icon: FileText, visible: Boolean(reportContent) },
  ] as const;

  const usageLabel = formatUsage(run?.usage);
  const providerModel = [run?.provider, run?.model].filter(Boolean).join(' · ') || 'Actoviq Agent SDK';

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
            placeholder={isPending ? 'Agent is responding…' : 'Describe a circuit or ask about the current design'}
            aria-label="Message Actoviq Circuit Agent"
            data-testid="chat-composer"
            disabled={isPending && !runIsActive}
            rows={1}
          />
          {runIsActive ? (
            <button
              type="button"
              className="chat-composer__action chat-composer__action--stop"
              onClick={onStop}
              title="Stop response"
              aria-label="Stop response"
              data-testid="chat-stop"
            >
              <Square size={14} fill="currentColor" aria-hidden="true" />
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
              <Send size={17} aria-hidden="true" />
            </button>
          )}
        </div>
        <p className="chat-composer__hint">Enter to send · Shift+Enter for a new line</p>
      </footer>
    </section>
  );
}
