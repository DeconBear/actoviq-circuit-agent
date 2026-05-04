import { useCallback, useState } from 'react';
import { useAppStore } from '../../store/appStore';

interface Props {
  onSend: (text: string) => void;
}

export function ChatView({ onSend }: Props) {
  const [input, setInput] = useState('');
  const messages = useAppStore((s) => s.messages);
  const outputText = useAppStore((s) => s.outputText);
  const isRunning = useAppStore((s) => s.isRunning);

  const handleSend = () => {
    const trimmed = input.trim();
    if (trimmed) {
      onSend(trimmed);
      setInput('');
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.messages}>
        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              ...styles.bubble,
              ...(msg.role === 'user' ? styles.userBubble : styles.systemBubble),
              ...(msg.isError ? styles.errorBubble : {}),
            }}
          >
            <div style={styles.bubbleHeader}>
              {msg.role === 'user' ? 'You' : 'Agent'}
            </div>
            <div style={styles.bubbleContent}>{msg.content}</div>
          </div>
        ))}
        {outputText && (
          <div style={{ ...styles.bubble, ...styles.outputBubble }}>
            <pre style={styles.outputPre}>{outputText}</pre>
          </div>
        )}
        {messages.length === 0 && !outputText && (
          <div style={styles.emptyState}>
            <p>Type a circuit requirement below to start designing.</p>
          </div>
        )}
      </div>

      <div style={styles.inputBar}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={
            isRunning
              ? 'Workflow running...'
              : 'Describe your circuit (e.g. Design a 1 kHz RC low-pass filter)'
          }
          style={styles.input}
          disabled={isRunning}
        />
        <button
          onClick={handleSend}
          style={styles.sendBtn}
          disabled={isRunning || !input.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100%' },
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px 24px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  bubble: {
    padding: '8px 14px',
    borderRadius: 8,
    maxWidth: '80%',
    fontSize: 13,
    lineHeight: 1.5,
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: '#0f3460',
    color: '#e0e0e0',
  },
  systemBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#16213e',
    color: '#c0c0d0',
  },
  errorBubble: {
    backgroundColor: '#4a1a1a',
    borderLeft: '3px solid #e94560',
  },
  outputBubble: {
    alignSelf: 'stretch',
    maxWidth: '100%',
    backgroundColor: '#0d1117',
    border: '1px solid #16213e',
  },
  bubbleHeader: { fontSize: 11, color: '#e94560', marginBottom: 4, fontWeight: 600 },
  bubbleContent: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  outputPre: {
    fontSize: 12,
    fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
    whiteSpace: 'pre-wrap',
    color: '#8b949e',
    margin: 0,
  },
  emptyState: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#606070',
  },
  inputBar: {
    display: 'flex',
    padding: '10px 20px',
    borderTop: '1px solid #0f3460',
    backgroundColor: '#16213e',
    gap: 8,
  },
  input: {
    flex: 1,
    padding: '8px 14px',
    borderRadius: 6,
    border: '1px solid #0f3460',
    backgroundColor: '#1a1a2e',
    color: '#e0e0e0',
    fontSize: 14,
    outline: 'none',
  },
  sendBtn: {
    padding: '8px 20px',
    backgroundColor: '#e94560',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 600,
  },
};
