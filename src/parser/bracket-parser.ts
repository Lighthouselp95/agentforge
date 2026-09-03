export interface BracketRange {
  tag: string;
  startIndex: number;
  closeIndex: number;
  endIndex: number;
  raw: string;
  content: string;
}

export function findBalancedBracketRange(text: string, startIndex: number): BracketRange | null {
  if (!text || startIndex < 0 || startIndex >= text.length || text[startIndex] !== '[') return null;

  const remaining = text.substring(startIndex + 1);
  const multiMatch = remaining.match(/^(CREATE\s+ROLE|STOP\s+AGENT|RESUME\s+AGENT|DELETE\s+AGENT)\b/i);
  let tag = '';
  let tagLen = 0;
  if (multiMatch) {
    tag = multiMatch[1].toUpperCase();
    tagLen = multiMatch[1].length;
  } else {
    const singleMatch = remaining.match(/^([A-Za-z_]+)\b/);
    if (!singleMatch) return null;
    tag = singleMatch[1].toUpperCase();
    tagLen = singleMatch[1].length;
  }

  let depth = 0;
  let inQuote: string | null = null;
  let inCodeBlock = false;
  let closeIndex = -1;
  const len = text.length;

  for (let j = startIndex; j < len; j++) {
    const char = text[j];
    const prev = j > startIndex ? text[j - 1] : '';

    if (prev === '\\') continue;

    if (text.startsWith('```', j)) {
      inCodeBlock = !inCodeBlock;
      j += 2;
      continue;
    }
    if (inCodeBlock) continue;

    if (char === '"' || char === "'" || char === '`' || char === '“' || char === '”') {
      const matchQuote = char === '“' ? '”' : char;
      if (!inQuote) {
        inQuote = matchQuote;
        continue;
      } else if (inQuote === char || (inQuote === '”' && char === '”')) {
        inQuote = null;
        continue;
      }
    }
    if (inQuote) continue;

    if (char === '[') {
      depth++;
    } else if (char === ']') {
      depth--;
      if (depth === 0) {
        closeIndex = j;
        break;
      }
    }
  }

  if (closeIndex !== -1) {
    const raw = text.substring(startIndex, closeIndex + 1);
    const inner = raw.substring(1, raw.length - 1).trim();
    const content = inner.substring(tagLen).trim();

    const tagUpper = tag.toUpperCase();
    if (tagUpper === 'TALK') {
      if (!/\b(?:target|agent|agent-id|agent_id|target-id|target_id|to|id)\s*=/i.test(content)) {
        return null;
      }
    } else if (tagUpper === 'SPAWN') {
      if (!/\b(?:role|name)\s*=/i.test(content)) {
        return null;
      }
    }

    return {
      tag,
      startIndex,
      closeIndex,
      endIndex: closeIndex + 1,
      raw,
      content
    };
  }

  return null;
}

export function extractBracketCommand(text: string, startIndex: number): { tag: string; content: string; fullMatch: string; startIndex: number; endIndex: number } | null {
  const match = findBalancedBracketRange(text, startIndex);
  if (!match) return null;
  return {
    tag: match.tag,
    content: match.content,
    fullMatch: match.raw,
    startIndex: match.startIndex,
    endIndex: match.endIndex
  };
}
