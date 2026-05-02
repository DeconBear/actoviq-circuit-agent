export type WorkflowErrorKind =
  | 'timeout'
  | 'rate_limit'
  | 'broken_pipe'
  | 'insufficient_balance'
  | 'credential'
  | 'file_tool'
  | 'transport'
  | 'unknown';

export interface WorkflowErrorClassification {
  kind: WorkflowErrorKind;
  retryable: boolean;
  message: string;
}

export class CircuitAgentError extends Error {
  constructor(
    readonly kind: WorkflowErrorKind,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CircuitAgentError';
  }
}

const NON_RETRYABLE_PATTERNS = [
  /HTTP\s*402/i,
  /insufficient\s+balance/i,
  /No Actoviq credential/i,
  /unauthorized/i,
  /forbidden/i,
  /invalid api key/i,
];

const ERROR_KIND_PATTERNS: Array<{
  kind: WorkflowErrorKind;
  retryable: boolean;
  patterns: RegExp[];
}> = [
  {
    kind: 'timeout',
    retryable: true,
    patterns: [/\bETIMEDOUT\b/i, /request timed out/i, /timed out/i, /timeout/i],
  },
  {
    kind: 'rate_limit',
    retryable: true,
    patterns: [/HTTP\s*429/i, /rate limit/i, /usage limit/i, /quota/i],
  },
  {
    kind: 'broken_pipe',
    retryable: true,
    patterns: [/\bEPIPE\b/i, /broken pipe/i],
  },
  {
    kind: 'insufficient_balance',
    retryable: false,
    patterns: [/HTTP\s*402/i, /insufficient\s+balance/i],
  },
  {
    kind: 'credential',
    retryable: false,
    patterns: [/credential/i, /api key/i, /unauthorized/i, /forbidden/i, /invalid api key/i],
  },
  {
    kind: 'file_tool',
    retryable: false,
    patterns: [
      /Missing required .* field/i,
      /file_path/i,
      /absolute output path/i,
      /ENOENT/i,
      /EACCES/i,
    ],
  },
  {
    kind: 'transport',
    retryable: true,
    patterns: [
      /\bECONNRESET\b/i,
      /\bECONNABORTED\b/i,
      /\bEAI_AGAIN\b/i,
      /\bENETUNREACH\b/i,
      /\bECONNREFUSED\b/i,
      /socket hang up/i,
      /connection reset/i,
      /temporary/i,
      /HTTP\s*408/i,
      /HTTP\s*409/i,
      /HTTP\s*425/i,
      /HTTP\s*5\d\d/i,
    ],
  },
];

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function classifyError(error: unknown): WorkflowErrorClassification {
  if (error instanceof CircuitAgentError) {
    return {
      kind: error.kind,
      retryable: error.retryable,
      message: error.message,
    };
  }

  const message = formatUnknownError(error);
  if (NON_RETRYABLE_PATTERNS.some((pattern) => pattern.test(message))) {
    const nonRetryableMatch = ERROR_KIND_PATTERNS.find((entry) =>
      entry.patterns.some((pattern) => pattern.test(message)),
    );
    return {
      kind: nonRetryableMatch?.kind ?? 'unknown',
      retryable: false,
      message,
    };
  }

  const match = ERROR_KIND_PATTERNS.find((entry) =>
    entry.patterns.some((pattern) => pattern.test(message)),
  );
  return {
    kind: match?.kind ?? 'unknown',
    retryable: match?.retryable ?? false,
    message,
  };
}
