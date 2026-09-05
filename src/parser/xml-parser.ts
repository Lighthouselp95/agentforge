export interface BracketCommand {
  tag: string;           // Tên thẻ: 'TALK', 'SPAWN', 'CREATE ROLE', etc.
  content?: string;      // Nội dung bên trong cặp ngoặc ngoài cùng (bracket syntax)
  attributes?: string;   // Chuỗi thuộc tính (XML syntax)
  body?: string;         // Nội dung bên trong cặp thẻ <tag>...</tag> (XML syntax)
  fullMatch: string;     // Chuỗi đầy đủ bao gồm cả cặp ngoặc [TAG ...] hoặc <tag>...</tag>
  startIndex: number;
  endIndex: number;
  syntax?: 'bracket' | 'xml';
}

export function extractXmlCommand(text: string, startIndex: number, targetTag: string): BracketCommand | null {
  const normTag = targetTag.toLowerCase().replace(/[\s_-]+/g, '[-_\\s]?');
  const openPattern = new RegExp(`^<(${normTag})(?:\\s+(?:[^>"']|"[^"]*"|'[^']*')*)?(?:>|\\/>)`, 'i');
  const match = text.substring(startIndex).match(openPattern);
  if (!match) return null;

  const openTag = match[0];
  const isSelfClosing = openTag.endsWith('/>') || openTag.endsWith('/ >');
  const tagUpper = targetTag.toUpperCase().replace(/[-_]+/g, ' ');

  const rawTagMatch = openTag.match(/^<([a-zA-Z0-9_-]+)/);
  const matchedTagName = rawTagMatch ? rawTagMatch[1] : targetTag;
  const attrText = openTag.slice(matchedTagName.length + 1, isSelfClosing ? (openTag.endsWith('/ >') ? -3 : -2) : -1).trim();

  const tagLower = tagUpper.toLowerCase();
  const hasRoutingAttr = /\b(?:target|target-id|target_id|agent-id|agent_id|agent|role|name|to|id)\s*=/i.test(attrText);

  const lineStart = text.lastIndexOf('\n', startIndex) + 1;
  const linePrefix = text.substring(lineStart, startIndex).trim();
  const isInlineInProse = linePrefix.length > 0 && !/^(?:<\/[a-z0-9_-]+>|\[\/[A-Z\s]+\])$/i.test(linePrefix);
  if (isInlineInProse && isSelfClosing) {
    return null;
  }

  if (isSelfClosing) {
    if (!hasRoutingAttr && (tagLower === 'talk' || tagLower === 'spawn')) return null;
    return {
      tag: tagUpper,
      attributes: attrText,
      body: '',
      fullMatch: openTag,
      startIndex,
      endIndex: startIndex + openTag.length,
      syntax: 'xml'
    };
  }

  const closeTagPattern = new RegExp(`</${normTag}>`, 'i');
  const afterOpen = text.substring(startIndex + openTag.length);
  const closeMatch = afterOpen.match(closeTagPattern);

  if (closeMatch && closeMatch.index !== undefined) {
    const body = afterOpen.substring(0, closeMatch.index);
    const totalLength = openTag.length + closeMatch.index + closeMatch[0].length;
    return {
      tag: tagUpper,
      attributes: attrText,
      body: body.trim(),
      fullMatch: text.substring(startIndex, startIndex + totalLength),
      startIndex,
      endIndex: startIndex + totalLength,
      syntax: 'xml'
    };
  } else {
    // Unclosed XML tag fallback - extends to next valid command tag or EOF
    // Thẻ <spawn> bắt buộc self-closing hoặc có thẻ đóng </spawn>, không fallback nuốt text
    if (tagLower === 'spawn') {
      return null;
    }
    const nextTagIdx = afterOpen.search(/(?:<\s*(?:talk|spawn|stop|resume|create_role|create-role|stop_agent|resume_agent|delete_agent)\b|\[(?:TALK|SPAWN|STOP|RESUME|CREATE ROLE|STOP AGENT|RESUME AGENT|DELETE AGENT)\b)/i);
    const bodyLength = nextTagIdx !== -1 ? nextTagIdx : afterOpen.length;
    const body = afterOpen.substring(0, bodyLength);
    const totalLength = openTag.length + bodyLength;
    return {
      tag: tagUpper,
      attributes: attrText,
      body: body.trim(),
      fullMatch: text.substring(startIndex, startIndex + totalLength),
      startIndex,
      endIndex: startIndex + totalLength,
      syntax: 'xml'
    };
  }
}
