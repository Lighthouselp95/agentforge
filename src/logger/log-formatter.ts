export function safeStringify(v: any): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function extractLogSourceTag(line: string): string {
  const tagMatch = line.match(/^\[([a-zA-Z0-9_-]+)\]/);
  return tagMatch ? tagMatch[1].toLowerCase() : 'system';
}
