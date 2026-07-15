import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

interface SecretFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Called the first time the user reveals an empty field that already has a saved secret. */
  onRevealSaved?: () => Promise<string | null>;
  hasSavedSecret?: boolean;
  testId?: string;
}

export function SecretField({
  label,
  value,
  onChange,
  placeholder,
  onRevealSaved,
  hasSavedSecret = false,
  testId,
}: SecretFieldProps) {
  const [visible, setVisible] = useState(false);
  const [revealing, setRevealing] = useState(false);

  async function toggleVisibility(): Promise<void> {
    if (visible) {
      setVisible(false);
      return;
    }
    if (!value && hasSavedSecret && onRevealSaved) {
      setRevealing(true);
      try {
        const revealed = await onRevealSaved();
        if (revealed) onChange(revealed);
      } finally {
        setRevealing(false);
      }
    }
    setVisible(true);
  }

  return (
    <div className="av-secret-field">
      <span className="av-form-label">{label}</span>
      <div className="av-secret-field__control">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          data-testid={testId}
          className="av-settings-input"
        />
        <button
          type="button"
          className="av-secret-field__toggle"
          onClick={() => { void toggleVisibility(); }}
          disabled={revealing}
          aria-label={visible ? 'Hide API key' : 'Show API key'}
          title={visible ? 'Hide' : 'Show'}
          data-testid={testId ? `${testId}-toggle` : undefined}
        >
          {visible ? <EyeOff size={16} strokeWidth={2} /> : <Eye size={16} strokeWidth={2} />}
        </button>
      </div>
    </div>
  );
}
