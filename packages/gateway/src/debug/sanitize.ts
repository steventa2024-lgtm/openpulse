/**
 * Redact credentials from anything that is about to be shown or exported.
 *
 * Patterns cover the common shapes — provider API keys, bearer tokens, private keys, passwords in
 * URLs, and key/value pairs whose name says "secret" — plus any literal secret values the caller
 * knows about (the configured API keys and gateway token), which is the only reliable way to catch
 * a secret that does not match a pattern.
 */

const PATTERNS: {
  name: string;
  regex: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}[] = [
  {
    name: 'private-key',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => '[redacted private key]',
  },
  {
    name: 'anthropic',
    regex: /sk-ant-[A-Za-z0-9_-]{16,}/g,
    replace: () => '[redacted anthropic key]',
  },
  {
    name: 'openai',
    regex: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
    replace: () => '[redacted api key]',
  },
  {
    name: 'github',
    regex: /gh[pousr]_[A-Za-z0-9]{30,}/g,
    replace: () => '[redacted github token]',
  },
  {
    name: 'github-fine',
    regex: /github_pat_[A-Za-z0-9_]{40,}/g,
    replace: () => '[redacted github token]',
  },
  {
    name: 'slack',
    regex: /xox[abposr]-[A-Za-z0-9-]{10,}/g,
    replace: () => '[redacted slack token]',
  },
  { name: 'aws', regex: /AKIA[0-9A-Z]{16}/g, replace: () => '[redacted aws key]' },
  {
    name: 'telegram',
    regex: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
    replace: () => '[redacted bot token]',
  },
  {
    name: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replace: () => '[redacted jwt]',
  },
  {
    name: 'bearer',
    regex: /\b(bearer|token)\s+([A-Za-z0-9._~+/-]{16,}=*)/gi,
    replace: (_match, scheme) => `${scheme} [redacted]`,
  },
  {
    name: 'url-password',
    regex: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi,
    replace: (_match, before, _password, at) => `${before}[redacted]${at}`,
  },
  {
    name: 'assignment',
    regex:
      /\b([A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_?KEY)[A-Z0-9_]*)(\s*[=:]\s*)(["']?)([^\s"']{4,})\3/gi,
    replace: (_match, key, sep, quote) => `${key}${sep}${quote}[redacted]${quote}`,
  },
];

export function sanitizeText(text: string, knownSecrets: string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join('[redacted]');
  }
  for (const pattern of PATTERNS) {
    out = out.replace(pattern.regex, pattern.replace);
  }
  return out;
}

const SECRET_KEY = /secret|password|passwd|token|api[_-]?key|private[_-]?key|authorization|cookie/i;

/** Deep-copy a value with secret-looking fields and strings redacted. */
export function sanitizeValue(value: unknown, knownSecrets: string[] = [], depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') return sanitizeText(value, knownSecrets);
  if (Array.isArray(value))
    return value.map((item) => sanitizeValue(item, knownSecrets, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] =
        SECRET_KEY.test(key) && (typeof item === 'string' || typeof item === 'number')
          ? '[redacted]'
          : sanitizeValue(item, knownSecrets, depth + 1);
    }
    return out;
  }
  return value;
}
