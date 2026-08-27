import fs from 'fs';
import path from 'path';

// ========== ROBUST PARSER IMPLEMENTATION (SRC/SERVER.TS) ==========
function getCodeSpanRanges(text) {
  const ranges = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('```', i)) {
      const end = text.indexOf('```', i + 3);
      if (end !== -1) { ranges.push([i, end + 3]); i = end + 3; continue; }
      ranges.push([i, text.length]); break;
    }
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) { ranges.push([i, end + 1]); i = end + 1; continue; }
    }
    i++;
  }
  return ranges;
}

function isInCodeSpan(idx, ranges) {
  for (const [s, e] of ranges) if (idx >= s && idx < e) return true;
  return false;
}

function cleanTargetIdentifier(val) {
  if (!val) return '';
  let cleaned = val.trim();
  if ((cleaned.startsWith('<') && cleaned.endsWith('>')) ||
      (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'")) ||
      (cleaned.startsWith('“') && cleaned.endsWith('”'))) {
    cleaned = cleaned.substring(1, cleaned.length - 1).trim();
  }
  return cleaned;
}

function extractBracketCommand(text, startIndex) {
  if (!text || startIndex < 0 || startIndex >= text.length || text[startIndex] !== '[') return null;
  const tagMatch = text.substring(startIndex + 1).match(/^([A-Za-z_]+(?:\s+[A-Z_]+)*)/);
  if (!tagMatch) return null;
  const tag = tagMatch[1];

  let endIdx = -1;
  let depth = 0;
  let inQuote = null;

  for (let i = startIndex; i < text.length; i++) {
    const char = text[i];
    const prevChar = i > startIndex ? text[i - 1] : '';

    if (inQuote) {
      if (char === inQuote && prevChar !== '\\') {
        inQuote = null;
      }
    } else {
      if (char === '"' || char === "'" || char === '`' || char === '“' || char === '”') {
        inQuote = char === '“' ? '”' : char;
      } else if (char === '[') {
        depth++;
      } else if (char === ']') {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }
  }

  if (endIdx !== -1 && endIdx >= startIndex) {
    const fullMatch = text.substring(startIndex, endIdx + 1);
    const inner = fullMatch.startsWith('[') && fullMatch.endsWith(']')
      ? fullMatch.substring(1, fullMatch.length - 1).trim()
      : fullMatch.replace(/^\[/, '').trim();
    const content = inner.substring(tag.length).trim();
    return { tag, content, fullMatch, endIndex: endIdx + 1 };
  } else {
    const nextTag = text.indexOf('\n[', startIndex + 1);
    const fallbackEnd = nextTag !== -1 ? nextTag : text.length;
    const fullMatch = text.substring(startIndex, fallbackEnd);
    const inner = fullMatch.replace(/^\[/, '').trim();
    const content = inner.substring(tag.length).trim();
    return { tag, content, fullMatch, endIndex: fallbackEnd };
  }
}

function extractBracketCommands(text, targetTags = ['TALK', 'SPAWN', 'CREATE ROLE', 'STOP', 'RESUME', 'STOP AGENT', 'RESUME AGENT', 'DELETE AGENT']) {
  const commands = [];
  if (!text) return commands;
  const codeRanges = getCodeSpanRanges(text);

  let pos = 0;
  while (pos < text.length) {
    let earliestTag = null;
    let earliestIdx = -1;

    for (const tag of targetTags) {
      let searchFrom = pos;
      while (true) {
        const idx = text.indexOf(`[${tag}`, searchFrom);
        if (idx === -1) break;
        const nextChar = text[idx + 1 + tag.length];
        const boundaryOk = !nextChar || /\s|:|\]|=/.test(nextChar);
        if (boundaryOk && !isInCodeSpan(idx, codeRanges)) {
          if (earliestIdx === -1 || idx < earliestIdx) {
            earliestIdx = idx;
            earliestTag = tag;
          }
          break;
        }
        searchFrom = idx + 1;
      }
    }

    if (earliestIdx === -1 || !earliestTag) break;

    const cmd = extractBracketCommand(text, earliestIdx);
    if (cmd) {
      commands.push({
        tag: earliestTag,
        content: cmd.content,
        fullMatch: cmd.fullMatch,
        startIndex: earliestIdx,
        endIndex: cmd.endIndex
      });
      pos = cmd.endIndex;
    } else {
      pos = earliestIdx + 1 + earliestTag.length;
    }
  }

  return commands;
}

function parseTalkTag(tagContent) {
  if (!tagContent) return null;
  
  const paramRe = /\b(agent-id|agent_id|target-id|target_id|target|agent|to|id|message|msg|content|task)\s*=\s*/gi;
  const found = [];
  let pm;
  while ((pm = paramRe.exec(tagContent)) !== null) {
    const before = tagContent.substring(0, pm.index);
    const inDouble = ((before.match(/"/g) || []).length % 2) === 1;
    const inSingle = ((before.match(/'/g) || []).length % 2) === 1;
    if (inDouble || inSingle) continue;
    found.push({ key: (pm[1] ?? '').toLowerCase(), keyStart: pm.index, valueStart: pm.index + pm[0].length });
  }

  const stripQuotes = (v) => {
    let t = v.trim();
    if (t.length >= 2 &&
        ((t.startsWith('"') && t.endsWith('"')) ||
         (t.startsWith("'") && t.endsWith("'")) ||
         (t.startsWith('“') && t.endsWith('”')))) {
      return t.substring(1, t.length - 1).trim();
    }
    if (t.startsWith('"') || t.startsWith("'") || t.startsWith('“')) {
      const closingQuote = t[0] === '“' ? '”' : t[0];
      const lastQuote = t.lastIndexOf(closingQuote);
      if (lastQuote > 0) return t.substring(1, lastQuote).trim();
      return t.substring(1).trim();
    }
    // Nếu message không quote mà bị dính dấu ] đóng tag ở cuối chuỗi
    if (t.endsWith(']')) {
      t = t.substring(0, t.length - 1).trim();
    }
    return t;
  };

  const valueOf = (keys) => {
    const p = found.find(f => keys.includes(f.key));
    if (!p) return undefined;
    const idx = found.indexOf(p);
    const end = idx + 1 < found.length ? found[idx + 1].keyStart : tagContent.length;
    return stripQuotes(tagContent.substring(p.valueStart, end));
  };

  const rawId = valueOf(['agent-id', 'agent_id', 'target-id', 'target_id', 'target', 'agent', 'to', 'id']);
  const agentId = cleanTargetIdentifier(rawId || '');
  const message = valueOf(['message', 'msg', 'content']);
  const task = valueOf(['task']);

  const finalMessage = (message && message.trim()) || (task && task.trim());
  if (agentId && finalMessage) {
    const trimmedTask = task && task.trim() ? task.trim() : undefined;
    return { agentId, message: finalMessage, ...(trimmedTask ? { task: trimmedTask } : {}) };
  }
  return null;
}

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) {
    console.log(`  [PASS] ${message}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${message}`);
    failed++;
  }
}

console.log('--- TEST 11: Lệnh TALK KHÔNG QUOTE có chứa ký tự [TALK dở dang bên trong ---');
const input11 = `[TALK target=arch-dbg message=ĐIỀU TRA GẤP BẪY PARSER:
Người dùng phát hiện lỗi:
Khi Orchestrator gửi tin nhắn có dạng:
\`[TALK
Sau đó báo cáo lại.]`;

const cmds11 = extractBracketCommands(input11, ['TALK']);
console.log('cmds11 length:', cmds11.length);
if (cmds11[0]) {
  console.log('cmd content:', JSON.stringify(cmds11[0].content));
  const parsed11 = parseTalkTag(cmds11[0].content);
  console.log('parsed11 message:', JSON.stringify(parsed11?.message));
}
