const REDACTED = '[REDACTED]';

/**
 * Ported from paco-troubleshoot-agent's packages/core/src/redaction.ts.
 * AWS cost/resource data never legitimately contains patient PII, but tags,
 * IAM policy documents, and free-text evidence summaries can still carry
 * secrets or incidental PII — kept as the same generic safety net used
 * throughout that codebase rather than a narrower cost-specific subset.
 */
const rules: readonly (readonly [RegExp, string])[] = [
  [
    /\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi,
    `authorization=${REDACTED}`,
  ],
  [
    /\b(?:api[-_]?key|password|passwd|secret|access[-_]?token|refresh[-_]?token|id[-_]?token)\s*[:=]\s*["']?[^\s,"';}]+/gi,
    `$1=${REDACTED}`,
  ],
  [/\bcookie\s*:\s*[^\r\n]+/gi, `cookie: ${REDACTED}`],
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED],
  [/([?&](?:token|key|secret|password|code)=)[^&#\s]+/gi, `$1${REDACTED}`],
];

export function redactText(input: string): string {
  return rules.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    input,
  );
}

export function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        /authorization|cookie|password|secret|token|api[-_]?key/i.test(key)
          ? REDACTED
          : redactUnknown(child),
      ]),
    );
  }
  return value;
}
