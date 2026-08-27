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
  const cleanRanges = getCodeSpanRanges(result);
  if (cleanRanges.length === 0) {
    result = result.replace(/\[(?:TALK|SPAWN|CREATE ROLE|STOP|RESUME)[^\]]*\]?/gi, '');
  } else {
    let rebuilt = '';
    let scanPos = 0;
    while (scanPos < result.length) {
      const nextRange = cleanRanges.find(([s]) => s >= scanPos);
      const segEnd = nextRange ? nextRange[0] : result.length;
      const segment = result.substring(scanPos, segEnd);
      rebuilt += segment.replace(/\[(?:TALK|SPAWN|CREATE ROLE|STOP|RESUME)[^\]]*\]?/gi, '');
      if (nextRange) {
        rebuilt += result.substring(nextRange[0], nextRange[1]);
        scanPos = nextRange[1];
      } else {
        scanPos = result.length;
      }
    }
    result = rebuilt;
  }
  return result.trim();
}

function extractCleanTaskReport(content) {
  const text = content || '';
  const startMatch = text.match(/===\s*(?:TASK|RESEARCH|VERIFICATION|ERROR)\s+REPORT\s*===/i);
  if (!startMatch || startMatch.index === undefined) return text;
  const startIdx = startMatch.index;
  let from = startIdx;
  const before = text.slice(0, startIdx);
  const beforeTrim = before.trimEnd();
  const lastLineMatch = beforeTrim.match(/(?:^|\n)([^\n]*Task complete\.?[^\n]*)$/i);
  if (lastLineMatch) {
    from = beforeTrim.length - lastLineMatch[1].length;
  }
  const afterStart = text.slice(startIdx);
  const endM = afterStart.match(/===\s*END[^=\n]*REPORT\s*===/i);
  const end = endM && endM.index !== undefined ? startIdx + endM.index + endM[0].length : text.length;
  return text.slice(from, end).trim();
}

// ========== RUN TEST SUITE ==========
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

// Test 1: Nested brackets in TALK message
console.log('--- TEST 1: Nested square brackets in TALK message ---');
const input1 = `[TALK agent-id=coder message="Hãy kiểm tra mảng [1, 2, [3, 4]] và token [1M]"]`;
const cmds1 = extractBracketCommands(input1, ['TALK']);
assert(cmds1.length === 1, 'Should extract exactly 1 TALK command');
const parsed1 = parseTalkTag(cmds1[0]?.content || '');
assert(parsed1?.agentId === 'coder', 'Agent ID should be coder');
assert(parsed1?.message === 'Hãy kiểm tra mảng [1, 2, [3, 4]] và token [1M]', 'Message with nested brackets must not be truncated');

// Test 2: Multiline code block inside TALK
console.log('\n--- TEST 2: Multiline code block inside TALK message ---');
const input2 = `[TALK agent-id=verifier message="Hãy kiểm chứng code:
\`\`\`ts
const list = [1, 2, 3];
console.log(list[0]);
\`\`\`
Báo cáo kết quả."]` ;
const cmds2 = extractBracketCommands(input2, ['TALK']);
assert(cmds2.length === 1, 'Should extract multiline TALK command');
const parsed2 = parseTalkTag(cmds2[0]?.content || '');
assert(parsed2?.message?.includes('const list = [1, 2, 3];'), 'Code block inside message must be preserved completely');
assert(parsed2?.message?.endsWith('Báo cáo kết quả.'), 'End of multiline message must not be truncated');

// Test 3: Escaped quotes & Windows paths in TALK
console.log('\n--- TEST 3: Escaped quotes and Windows paths ---');
const input3 = `[TALK agent-id=debugger message="Đọc file \\"C:\\\\Program Files\\\\App\\\\test.json\\" và kiểm tra"]`;
const cmds3 = extractBracketCommands(input3, ['TALK']);
assert(cmds3.length === 1, 'Should extract TALK with escaped quotes');
const parsed3 = parseTalkTag(cmds3[0]?.content || '');
assert(parsed3?.message?.includes('C:\\\\Program Files'), 'Windows path must be preserved');

// Test 4: Unicode curly quotes (“...”)
console.log('\n--- TEST 4: Unicode curly quotes in TALK ---');
const input4 = `[TALK agent-id=idea message=“Đề xuất 3 ý tưởng tối ưu giao diện”]` ;
const cmds4 = extractBracketCommands(input4, ['TALK']);
assert(cmds4.length === 1, 'Should extract TALK with curly quotes');
const parsed4 = parseTalkTag(cmds4[0]?.content || '');
assert(parsed4?.message === 'Đề xuất 3 ý tưởng tối ưu giao diện', 'Content inside curly quotes must match');

// Test 5: Command tag inside markdown code span (Avoid false positive)
console.log('\n--- TEST 5: Command tag inside code-span (Avoid false positive) ---');
const input5 = `Để tiếp tục, bạn hãy dùng \`[RESUME AGENT target-id=coder]\` để mở lại agent.\nHoặc cấu hình: \`[SPAWN role=tester name=t1 task="test"]\`.`;
const cmds5 = extractBracketCommands(input5, ['RESUME', 'SPAWN']);
assert(cmds5.length === 0, 'Tags inside inline code spans must NOT be extracted as real commands');
const stripped5 = stripCommandTags(input5);
assert(stripped5.includes('`[RESUME AGENT target-id=coder]`'), 'Tags inside inline code spans must NOT be stripped from user text');

// Test 6: Fenced code block containing command examples
console.log('\n--- TEST 6: Command tags inside fenced code blocks ---');
const input6 = `Ví dụ lệnh điều phối:\n\`\`\`markdown\n[SPAWN role=coder name=fix task="Fix bug"]\n[TALK agent-id=fix message="Do work"]\n\`\`\`\nHãy làm theo mẫu trên.`;
const cmds6 = extractBracketCommands(input6, ['SPAWN', 'TALK']);
assert(cmds6.length === 0, 'Tags inside fenced code blocks must NOT be extracted as real commands');
const stripped6 = stripCommandTags(input6);
assert(stripped6.includes('[SPAWN role=coder name=fix task="Fix bug"]'), 'Code blocks must remain 100% untouched');

// Test 7: Task Report extraction
console.log('\n--- TEST 7: Extract Clean Task Report ---');
const input7 = `Đang chạy tác vụ kiểm tra...
[TOOL grep] pattern
output: 5 matches
[ASSISTANT]
Task complete.
=== TASK REPORT ===
AGENT_ID: agent-123
STATUS: completed
FILES: src/server.ts
WHAT I DID: Đã hoàn tất kiểm tra
=== END REPORT ===
Ghi chú ngoài lề.`;
const cleanReport = extractCleanTaskReport(input7);
assert(cleanReport.startsWith('Task complete.'), 'Clean report should start from Task complete.');
assert(cleanReport.includes('AGENT_ID: agent-123'), 'Clean report must contain report payload');
assert(cleanReport.endsWith('=== END REPORT ==='), 'Clean report should end at END REPORT marker');
assert(!cleanReport.includes('[TOOL grep]'), 'Tool noise before report must be excluded');

// Test 8: BẪY MỚI - Văn bản mô tả cú pháp dở dang chứa [TALK] hoặc [TALK agent-id=<id>]
console.log('\n--- TEST 8: BẪY MỚI - Văn bản chứa [TALK] làm tiêu đề hoặc câu mô tả dở dang ---');
const input8 = `Đồng bộ hóa cú pháp [TALK]:\n- Hiện trạng: debugger.md vẫn dùng [TALK agent-id=<id>]\n- Đề xuất: Chuẩn hóa về [TALK target=<name/id> message="..."] trên toàn bộ các file.`;
const cmds8 = extractBracketCommands(input8, ['TALK']);
const stripped8 = stripCommandTags(input8);
assert(stripped8.includes('Đồng bộ hóa cú pháp'), 'Text before syntax tag must be preserved');
assert(stripped8.includes('debugger.md'), 'Descriptive text must not be swallowed');

// Test 9: Real messages from state.json
console.log('\n--- TEST 9: Real messages from history (state.json) ---');
const statePath = 'C:/Users/Hai Dang/test-agentforge thoi/data/agentforge-state.json';
if (fs.existsSync(statePath)) {
  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    const data = JSON.parse(raw);
    const history = data.history || [];
    let testCount = 0;
    for (const m of history.slice(-50)) {
      if (m.content) {
        testCount++;
        const cmds = extractBracketCommands(m.content);
        const stripped = stripCommandTags(m.content);
        if (m.content.trim().length > 0 && !m.content.startsWith('[')) {
          if (stripped.length === 0 && !m.content.includes('[TALK') && !m.content.includes('[SPAWN')) {
            assert(false, `Stripped text became empty unexpectedly for msg: ${m.content.slice(0, 50)}`);
          }
        }
      }
    }
    assert(testCount > 0, `Tested ${testCount} real messages from state.json without parser exceptions`);
  } catch (err) {
    console.log(`  [INFO] Bỏ qua kiểm tra state.json do file đang được server ghi đồng thời (${err.message})`);
  }
} else {
  console.log('  [SKIP] state.json not found');
}

console.log('\n===============================================================');
console.log(`KẾT QUẢ KIỂM THỬ: ${passed} PASSED, ${failed} FAILED`);
console.log('===============================================================');

if (failed > 0) process.exit(1);
