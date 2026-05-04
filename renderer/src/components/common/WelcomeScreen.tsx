import { useState } from 'react';

interface Props {
  onStart: (requirement: string) => void;
  onClose: () => void;
}

export function WelcomeScreen({ onStart, onClose }: Props) {
  const [text, setText] = useState('');

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (trimmed) {
      onStart(trimmed);
    }
  };

  return (
    <div style={styles.overlay}>
      <div style={styles.card}>
        <h2 style={styles.title}>Actoviq Circuit Agent</h2>
        <p style={styles.subtitle}>
          Describe your circuit requirements in natural language. The agent will design, simulate, and render a SPICE schematic.
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.ctrlKey) handleSubmit();
          }}
          placeholder={
            'Design a 1 kHz RC low-pass filter and output the netlist, simulation report, and SVG schematic.'
          }
          style={styles.textarea}
          rows={4}
          autoFocus
        />
        <div style={styles.actions}>
          <button onClick={handleSubmit} style={styles.primaryBtn} disabled={!text.trim()}>
            Start Design (Ctrl+Enter)
          </button>
          <button onClick={onClose} style={styles.secondaryBtn}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  card: {
    backgroundColor: '#16213e',
    border: '1px solid #0f3460',
    borderRadius: 12,
    padding: '32px 40px',
    maxWidth: 600,
    width: '90%',
  },
  title: { color: '#e94560', marginBottom: 8, fontSize: 22 },
  subtitle: { color: '#a0a0b0', marginBottom: 20, fontSize: 14, lineHeight: 1.6 },
  textarea: {
    width: '100%',
    backgroundColor: '#1a1a2e',
    border: '1px solid #0f3460',
    borderRadius: 6,
    color: '#e0e0e0',
    padding: 12,
    fontSize: 14,
    resize: 'vertical',
    fontFamily: 'inherit',
  },
  actions: { display: 'flex', gap: 12, marginTop: 16, justifyContent: 'flex-end' },
  primaryBtn: {
    padding: '8px 20px',
    backgroundColor: '#e94560',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 600,
  },
  secondaryBtn: {
    padding: '8px 20px',
    backgroundColor: 'transparent',
    color: '#a0a0b0',
    border: '1px solid #0f3460',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 14,
  },
};
