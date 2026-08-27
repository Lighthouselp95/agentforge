import fs from 'fs';
import path from 'path';

// ========== ROBUST PARSER IMPLEMENTATION ==========
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

/**
 * State-Machine Balanced Bracket Parser — Bền vững 100% trước ngoặc vuông lồng nhau,
 * quotes nhiều dòng, nháy cong Unicode, và tham số đặt ở bất kỳ thứ tự nào.
 */
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
    // Fallback nếu tag không đóng: ngắt trước lệnh kế tiếp hoặc hết text
    const nextTag = text.indexOf('\n[', startIndex + 1);
    const fallbackEnd = nextTag !== -1 ? nextTag : text.length;
    const fullMatch = text.substring(startIndex, fallbackEnd);
    const inner = fullMatch.replace(/^\[/, '').trim();
    const content = inner.substring(tag.length).trim();
    return { tag, content, fullMatch, endIndex: fallbackEnd };
  }
}

function parseTalkTag(tagContent) {
  if (!tagContent) return null;
  
  // Quét toàn bộ tham số (agent-id/target-id/target/to/id/message/msg/content/task)
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
    const t = v.trim();
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

// ========== TEST RUNNER ==========
console.log('===============================================================');
console.log('CHẠY KIỂM THỬ PARSER STATE MACHINE (test_parser.js)');
console.log('===============================================================\n');

let passed = 0;
let failed = 0;

function assert(condition, testName, details = '') {
  if (condition) {
    console.log(`[PASS] ${testName}`);
    passed++;
  } else {
    console.error(`[FAIL] ${testName}`);
    if (details) console.error(`       Chi tiết: ${details}`);
    failed++;
  }
}

// Case A: Lồng ngoặc vuông [ ... [ ... ] ... ]
const msgA = `[TALK agent-id=coder message="Hãy kiểm tra [TOOL grep] và mảng [1, 2, [3, 4]] kèm token [1M]"]`;
const cmdA = extractBracketCommand(msgA, 0);
const parsedA = parseTalkTag(cmdA?.content);
assert(parsedA?.agentId === 'coder', 'Case A: Parse đúng agentId=coder');
assert(parsedA?.message === 'Hãy kiểm tra [TOOL grep] và mảng [1, 2, [3, 4]] kèm token [1M]', 'Case A: Giữ trọn vẹn ngoặc vuông lồng nhau không bị cắt ở dấu ] đầu');

// Case B: Multiline Code Block với backtick ``` và dấu ngoặc vuông bên trong
const msgB = `[TALK agent-id=verifier message="Hãy kiểm tra đoạn code sau:
\`\`\`ts
const arr = [10, 20, 30];
if (arr[0] > 5) {
  console.log('[OK]');
}
\`\`\`
Sau đó nghiệm thu."]`;
const cmdB = extractBracketCommand(msgB, 0);
const parsedB = parseTalkTag(cmdB?.content);
assert(parsedB?.message?.includes("const arr = [10, 20, 30];"), 'Case B: Giữ trọn vẹn code block');
assert(parsedB?.message?.includes("console.log('[OK]');"), 'Case B: Không bị ngắt ở tag [OK] trong code');
assert(parsedB?.message?.endsWith("Sau đó nghiệm thu."), 'Case B: Không bị cắt đuôi tin nhắn nhiều dòng');

// Case C: Dấu nháy kép escaped \" và đường dẫn Windows
const msgC = `[TALK agent-id=debugger message="Mở file \\"C:\\\\Program Files\\\\App\\\\data.json\\" để kiểm tra"]`;
const cmdC = extractBracketCommand(msgC, 0);
const parsedC = parseTalkTag(cmdC?.content);
assert(parsedC?.message?.includes('C:\\\\Program Files'), 'Case C: Parse đúng đường dẫn Windows chứa nháy kép escaped');

// Case D: Nháy cong Unicode (“...”)
const msgD = `[TALK agent-id=idea message=“Đề xuất giải pháp tối ưu hệ thống”]` ;
const cmdD = extractBracketCommand(msgD, 0);
const parsedD = parseTalkTag(cmdD?.content);
assert(parsedD?.message === 'Đề xuất giải pháp tối ưu hệ thống', 'Case D: Parse đúng nháy cong Unicode');

// Case E: Nhiều tham số ngẫu nhiên (task=... trước message=...)
const msgE = `[TALK task="Task A" agent-id="tester" message="Chạy kiểm thử unit test"]`;
const cmdE = extractBracketCommand(msgE, 0);
const parsedE = parseTalkTag(cmdE?.content);
assert(parsedE?.agentId === 'tester', 'Case E: Parse đúng agentId khi task= đứng trước');
assert(parsedE?.task === 'Task A', 'Case E: Parse đúng task');
assert(parsedE?.message === 'Chạy kiểm thử unit test', 'Case E: Parse đúng message');

// Case F: Message không dùng quote nhưng có ngoặc vuông bên trong trên cùng dòng
const msgF = `[TALK agent-id=coder message=Kiểm tra file test.ts và mảng [1, 2, 3]]`;
const cmdF = extractBracketCommand(msgF, 0);
const parsedF = parseTalkTag(cmdF?.content);
assert(parsedF?.agentId === 'coder', 'Case F: Parse đúng agentId không quote');
assert(parsedF?.message === 'Kiểm tra file test.ts và mảng [1, 2, 3]', 'Case F: Parse trọn vẹn message không quote chứa ngoặc vuông');

console.log('\n===============================================================');
console.log(`KẾT QUẢ KIỂM THỬ: ${passed} PASS, ${failed} FAIL`);
console.log('===============================================================');
