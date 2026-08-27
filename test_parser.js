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
    // Nếu message không dùng quote mà bị dính dấu ] đóng tag ở cuối chuỗi
    if (t.endsWith(']')) {
      t = t.substring(0, t.length - 1).trim();
    }
    return t;
  };

  // 1. Trích xuất target/agent-id trước
  const targetMatch = tagContent.match(/(?:agent-id|agent_id|target-id|target_id|target|agent|to|id)\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|([^\s\]]+))/i);
  const rawId = targetMatch ? (targetMatch[1] || targetMatch[2] || targetMatch[3] || targetMatch[4]) : '';
  const agentId = cleanTargetIdentifier(rawId);
  if (!agentId) return null;

  // 2. Trích xuất task nếu có (ưu tiên nếu task= đứng trước message=)
  let task = undefined;
  const taskParamMatch = tagContent.match(/\btask\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|([^\s\]\n]+))/i);
  if (taskParamMatch) {
    const rawTask = taskParamMatch[1] || taskParamMatch[2] || taskParamMatch[3] || taskParamMatch[4] || '';
    if (rawTask) task = stripQuotes(rawTask);
  }

  // 3. Trích xuất message: lấy toàn bộ nội dung từ sau 'message=' (hoặc 'msg=' hoặc 'content=')
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
console.log('CHẠY KIỂM THỬ BỘ TEST CASE PARSER MỚI (test_parser.js)');
console.log('===============================================================\n');

// Test Case 10: TÁI HIỆN LỖI THỰC TẾ: Message không dùng quote chứa cụm từ task= bên trong
console.log('--- TEST 10: Lệnh TALK KHÔNG QUOTE chứa cụm từ task= trong nội dung ---');
const input10 = `[TALK target=deployer message=Hỗ trợ tham số task= và tự cập nhật task vào database. Báo TASK REPORT khi xong.]`;
const cmds10 = extractBracketCommands(input10, ['TALK']);
assert(cmds10.length === 1, 'Should extract 1 TALK command');
const parsed10 = parseTalkTag(cmds10[0]?.content || '');
assert(parsed10?.agentId === 'deployer', 'Agent ID should be deployer');
assert(parsed10?.message === 'Hỗ trợ tham số task= và tự cập nhật task vào database. Báo TASK REPORT khi xong.', 'Message containing task= phrase must not be cut');

// Test Case 11: Lệnh TALK chứa dấu hai chấm, xuống dòng và [TALK mở dở dang trong nội dung
console.log('\n--- TEST 11: Lệnh TALK chứa dấu hai chấm, xuống dòng và [TALK mở dở dang ---');
const input11 = `[TALK target=arch-dbg message="ĐIỀU TRA GẤP BẪY PARSER TALK BỊ CẮT CỤT TẠI VỊ TRÍ DẤU HAI CHẤM VÀ XUỐNG DÒNG tại C:\\Users\\Hai Dang\\agentforge:

Người dùng vừa bắt quả tang một lỗi parse thực tế cực kỳ điển hình:
Khi Orchestrator gửi tin nhắn TALK có dạng:
\`[TALK

Sau đó báo cáo lại."]`;
const cmds11 = extractBracketCommands(input11, ['TALK']);
assert(cmds11.length === 1, 'Should extract 1 TALK command');
const parsed11 = parseTalkTag(cmds11[0]?.content || '');
assert(parsed11?.agentId === 'arch-dbg', 'Agent ID should be arch-dbg');
assert(parsed11?.message?.includes('Người dùng vừa bắt quả tang một lỗi parse'), 'Message must contain text after colon and newline');
assert(parsed11?.message?.endsWith('Sau đó báo cáo lại.'), 'Message must not be truncated at `[TALK');

// Test Case 12: Lệnh TALK nhiều dòng không quote chứa dấu đóng ] ở giữa dòng
console.log('\n--- TEST 12: Lệnh TALK nhiều dòng không quote có dấu đóng ] ở cuối dòng 3 ---');
const input12 = `[TALK target=verifyfix message=Kiểm chứng thực nghiệm fix binary tại test-agentforge thoi/agentforge-web.exe.new (94,812,672 bytes) và GitHub Release v0.2.3. Báo TASK REPORT kết luận 100% PASS toàn diện.]`;
const cmds12 = extractBracketCommands(input12, ['TALK']);
assert(cmds12.length === 1, 'Should extract 1 TALK command');
const parsed12 = parseTalkTag(cmds12[0]?.content || '');
assert(parsed12?.agentId === 'verifyfix', 'Agent ID should be verifyfix');
assert(parsed12?.message?.includes('Báo TASK REPORT kết luận 100% PASS toàn diện.'), 'Message with closing bracket inside text must be preserved');

console.log('\n===============================================================');
console.log(`KẾT QUẢ KIỂM THỬ: ${passed} PASSED, ${failed} FAILED`);
console.log('===============================================================');
