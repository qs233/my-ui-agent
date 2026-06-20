const WHITESPACE_RE = /\s+/g;

export function normalizeText(value: string): string {
  return value.replace(WHITESPACE_RE, " ").trim();
}

export function truncateText(value: string, maxLength = 80): string {
  const normalized = normalizeText(value);
  if (normalized.length <= maxLength) return normalized;
  if (maxLength <= 1) return normalized.slice(0, maxLength);
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function appendText(current: string, next: string, maxLength = 80): string {
  const merged = normalizeText(`${current} ${next}`);
  return truncateText(merged, maxLength);
}
