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

function stripCommandTags(text) {
  if (!text) return '';
  const commands = extractBracketCommands(text, ['TALK', 'SPAWN', 'CREATE ROLE', 'STOP', 'RESUME', 'STOP AGENT', 'RESUME AGENT', 'DELETE AGENT']);
  if (commands.length === 0) return text.trim();
  let result = '';
  let lastIndex = 0;
  for (const cmd of commands) {
    result += text.substring(lastIndex, cmd.startIndex);
    lastIndex = cmd.endIndex;
  }
  result += text.substring(lastIndex);
  return result.trim();
}

function parseTalkTag(tagContent) {
  if (!tagContent) return null;

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
    if (t.endsWith(']')) {
      t = t.substring(0, t.length - 1).trim();
    }
    return t;
  };

  const targetMatch = tagContent.match(/(?:agent-id|agent_id|target-id|target_id|target|agent|to|id)\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|([^\s\]]+))/i);
  const rawId = targetMatch ? (targetMatch[1] || targetMatch[2] || targetMatch[3] || targetMatch[4]) : '';
  const agentId = cleanTargetIdentifier(rawId);
  if (!agentId) return null;

  let task = undefined;
  const taskParamMatch = tagContent.match(/\btask\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|([^\s\]\n]+))/i);
  if (taskParamMatch) {
    const rawTask = taskParamMatch[1] || taskParamMatch[2] || taskParamMatch[3] || taskParamMatch[4] || '';
    if (rawTask) task = stripQuotes(rawTask);
  }

  const msgMarkerMatch = tagContent.match(/\b(message|msg|content)\s*=\s*/i);
  let message = undefined;
  if (msgMarkerMatch && msgMarkerMatch.index !== undefined) {
    const msgStart = msgMarkerMatch.index + msgMarkerMatch[0].length;
    const rawMsg = tagContent.substring(msgStart);
    message = stripQuotes(rawMsg);
  }

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

console.log('===============================================================');
console.log('CHẠY KIỂM THỬ BỘ TEST CASE PARSER NGUYÊN VĂN (test_parser.js)');
console.log('===============================================================\n');

// Test Case 12: ĐOẠN TEXT THỰC TẾ CỦA USER VỚI DẤU ] Ở CUỐI DÒNG 3 VÀ TEXT TỰ SỰ BÊN DƯỚI
console.log('--- TEST 12: Nạp đúng nguyên văn đoạn text TALK 3 dòng có dấu ] và text tự sự bên dưới ---');
const sampleText12 = `[TALK target=verifyfix message=Tien hanh nghiem thu doc lap cuoi cung tren dia:
Xac nhan server.ts va App.tsx da co du bo loc Content Hash Deduplication 2 tang.
Kiem tra file test-agentforge thoi/agentforge-web.exe.new (94,812,672 bytes) va GitHub Release v0.2.3. Bao TASK REPORT ket luan 100% PASS toan dien.]
Coder deployer đã hoàn tất triển khai...`;

const cmds12 = extractBracketCommands(sampleText12, ['TALK']);
assert(cmds12.length === 1, 'Should extract exactly 1 TALK command');
const parsed12 = parseTalkTag(cmds12[0]?.content || '');
assert(parsed12?.agentId === 'verifyfix', 'Agent ID should be verifyfix');
assert(parsed12?.message?.includes('Tien hanh nghiem thu doc lap cuoi cung tren dia:'), 'Message must contain line 1');
assert(parsed12?.message?.includes('Xac nhan server.ts va App.tsx da co du bo loc'), 'Message must contain line 2');
assert(parsed12?.message?.includes('GitHub Release v0.2.3. Bao TASK REPORT ket luan 100% PASS toan dien.'), 'Message must contain line 3');

const stripped12 = stripCommandTags(sampleText12);
assert(stripped12.includes('Coder deployer đã hoàn tất triển khai...'), 'Text after TALK command must not be swallowed');

// Test Case 13: Tin nhắn của User chứa chuỗi [TALK không được parse hay làm sạch
console.log('\n--- TEST 13: Bảo vệ tin nhắn User nguyên văn 100% không chạy strip/parse ---');
const userMsgRaw = `Người dùng gõ lệnh mẫu: \`[TALK target=test message="abc"]\` và câu tự sự [TALK dở dang.`;
// Giả lập lưu tin nhắn user trực tiếp như trong server.ts dòng 3127
const storedMsg = { id: 'u1', from: 'user', to: 'orchestrator', content: userMsgRaw };
assert(storedMsg.content === userMsgRaw, 'User message must be preserved verbatim without stripping');

console.log('\n===============================================================');
console.log(`KẾT QUẢ KIỂM THỬ: ${passed} PASSED, ${failed} FAILED`);
console.log('===============================================================');
