/** Chat model tier UI constants for settings + desktop chat composer. */

export type ChatModelTier = 'basic' | 'medium' | 'professional';

export const CHAT_MODEL_TIER_OPTIONS: Array<{
  id: ChatModelTier;
  label: string;
  shortLabel: string;
}> = [
  { id: 'basic', label: 'Basic model', shortLabel: 'Basic' },
  { id: 'medium', label: 'Medium model', shortLabel: 'Medium' },
  { id: 'professional', label: 'Professional model', shortLabel: 'Professional' },
];
