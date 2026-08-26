const PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+\S+/gi,
  /(?:ANTHROPIC|OPENAI|OPENROUTER|XAI)_API_KEY=\S+/g,
  /token=\S+/gi,
  /ghp_\w+/g,
  /gho_\w+/g,
  /url:\s*\S+/gi,
  /cf-ray:\s*\S+/gi,
  /request id:\s*\S+/gi,
  /thread[_ ]id:?\s*\S+/gi,
] as const;

export function redact(value: string): string {
  return PATTERNS.reduce((redacted, pattern) => redacted.replace(pattern, "[redacted]"), value);
}
