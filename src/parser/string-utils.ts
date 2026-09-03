export const INVALID_TARGET_PLACEHOLDERS = new Set([
  'target-id', '<target-id>', 'agent-id', '<agent-id>', 'id', '<id>',
  'coder-id', '<coder-id>', 'verifier-id', '<verifier-id>',
  'target', '<target>', 'worker', '<worker>', 'recipient', '<recipient>',
  'your-id', '<your-id>', 'name/id', '<name/id>', 'verifier-name/id', '<verifier-name/id>',
  'undefined', 'null', 'none', 'unknown',
  '${targetagent.id}', '\\${targetagent.id}', '${agent.id}', '\\${agent.id}',
  '${targetid}', '\\${targetid}', '${id}', '\\${id}', '${name}', '\\${name}',
  'targetagent.id', 'agent.id', 'targetid'
]);

export function cleanTargetIdentifier(val: string): string {
  if (!val) return '';
  let cleaned = val.trim();
  cleaned = cleaned.replace(/^[<"'\s]+|[>"'\s]+$/g, '').trim();
  const prefixRegex = /^(?:target|target-id|agent-id|id|to)\s*=\s*(.*)$/i;
  const match = cleaned.match(prefixRegex);
  if (match) {
    cleaned = match[1].trim();
  }
  cleaned = cleaned.replace(/^[<"'\s]+|[>"'\s]+$/g, '').trim();
  if (INVALID_TARGET_PLACEHOLDERS.has(cleaned.toLowerCase()) || /^<.*>$/.test(cleaned) || /^\$?\{.*\}$/.test(cleaned)) {
    return '';
  }
  return cleaned;
}

export function stripQuotes(v: string): string {
  if (!v) return '';
  let t = v.trim();
  if (t.length >= 2 &&
      ((t.startsWith('"') && t.endsWith('"')) ||
       (t.startsWith("'") && t.endsWith("'")) ||
       (t.startsWith('“') && t.endsWith('”')) ||
       (t.startsWith('‘') && t.endsWith('’')))) {
    return t.substring(1, t.length - 1).trim();
  }
  if (t.startsWith('"') || t.startsWith("'") || t.startsWith('“') || t.startsWith('‘')) {
    const startChar = t[0];
    const closingQuote = startChar === '“' ? '”' : (startChar === '‘' ? '’' : startChar);
    const lastQuote = t.lastIndexOf(closingQuote);
    if (lastQuote > 0) return t.substring(1, lastQuote).trim();
    return t.substring(1).trim();
  }
  if (t.endsWith(']')) {
    t = t.substring(0, t.length - 1).trim();
  }
  return t;
}

export function unescapeXml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
