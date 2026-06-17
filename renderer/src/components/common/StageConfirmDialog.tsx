interface Props {
  currentStage: string;
  nextStage: string;
  onApprove: () => void;
  onReject: () => void;
}

export function StageConfirmDialog({ currentStage, nextStage, onApprove, onReject }: Props) {
  return (
    <div style={styles.overlay}>
      <div style={styles.card}>
        <h3 style={styles.title}>Stage Transition</h3>
        <p style={styles.message}>
          Proceed from <strong>{currentStage}</strong> to <strong>{nextStage}</strong>?
        </p>
        <p style={styles.hint}>
          Review the stage output in Chat before approving.
        </p>
        <div style={styles.actions}>
          <button onClick={onReject} style={styles.rejectBtn}>
            Skip
          </button>
          <button onClick={onApprove} style={styles.approveBtn}>
            Approve
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
    backgroundColor: 'rgba(32,42,56,0.24)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 50,
  },
  card: {
    backgroundColor: '#ffffff',
    border: '1px solid #b8cdf4',
    borderRadius: 10,
    padding: '24px 32px',
    maxWidth: 420,
    width: '90%',
    textAlign: 'center',
  },
  title: { color: '#2563eb', fontSize: 16, marginBottom: 12 },
  message: { color: '#303741', fontSize: 14, marginBottom: 8, lineHeight: 1.5 },
  hint: { color: '#69727d', fontSize: 12, marginBottom: 20 },
  actions: { display: 'flex', gap: 12, justifyContent: 'center' },
  approveBtn: {
    padding: '10px 28px',
    backgroundColor: '#267346',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 700,
  },
  rejectBtn: {
    padding: '10px 28px',
    backgroundColor: 'transparent',
    color: '#a32d38',
    border: '1px solid #d58b95',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 14,
  },
};
