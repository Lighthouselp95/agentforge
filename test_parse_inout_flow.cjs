/**
 * test_parse_inout_flow.cjs - AgentForge Parse IN/OUT Flow Simulation Test
 * 
 * Mô phỏng luồng parse đầu vào (IN) và đầu ra (OUT) của AgentForge.
 * Dùng reference implementation của Dual-Syntax Parser (không chạy server thật).
 * 
 * Mục tiêu: phát hiện các trường hợp parse VỠ hoặc bị HIỂU NHẦM
 * (nested spawn/talk, codeblock, ký tự đặc biệt <>, HTML tags, markdown).
 */

// ==========================================
// REFERENCE PARSER IMPLEMENTATION (mirror src/server.ts)
// ==========================================
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

function stripQuotes(v) {
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
    return { tag, content, fullMatch, startIndex, endIndex: endIdx + 1, syntax: 'bracket' };
  } else {
    const nextTag = text.indexOf('\n[', startIndex + 1);
    const fallbackEnd = nextTag !== -1 ? nextTag : text.length;
    const fullMatch = text.substring(startIndex, fallbackEnd);
    const inner = fullMatch.replace(/^\[/, '').trim();
    const content = inner.substring(tag.length).trim();
    return { tag, content, fullMatch, startIndex, endIndex: fallbackEnd, syntax: 'bracket' };
  }
}

function extractXmlCommand(text, startIndex, targetTag) {
  const openPattern = new RegExp(`^<${targetTag}(?:\\s+[^>]*)?(?:>|\\/>)`, 'i');
  const match = text.substring(startIndex).match(openPattern);
  if (!match) return null;

  const openTag = match[0];
  const isSelfClosing = openTag.endsWith('/>');
  const tagUpper = targetTag.toUpperCase();

  const attrText = openTag.slice(targetTag.length + 1, isSelfClosing ? -2 : -1).trim();

  if (isSelfClosing) {
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

  const closeTagPattern = new RegExp(`</${targetTag}>`, 'i');
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
    const nextTagIdx = afterOpen.search(/<[a-zA-Z]|\[[A-Z]/);
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

function extractDualCommands(text, targetTags = ['TALK', 'SPAWN', 'CREATE ROLE', 'STOP', 'RESUME', 'STOP AGENT', 'RESUME AGENT', 'DELETE AGENT']) {
  const commands = [];
  if (!text) return commands;
  const codeRanges = getCodeSpanRanges(text);

  let pos = 0;
  while (pos < text.length) {
    let earliestMatch = null;
    let earliestIdx = -1;

    for (const tag of targetTags) {
      let searchBracket = pos;
      while (true) {
        const idx = text.indexOf(`[${tag}`, searchBracket);
        if (idx === -1) break;
        const nextChar = text[idx + 1 + tag.length];
        const boundaryOk = !nextChar || /\s|:|\]|=/.test(nextChar);
        if (boundaryOk && !isInCodeSpan(idx, codeRanges)) {
          if (earliestIdx === -1 || idx < earliestIdx) {
            earliestIdx = idx;
            earliestMatch = { type: 'bracket', tag };
          }
          break;
        }
        searchBracket = idx + 1;
      }

      let searchXml = pos;
      const tagLower = tag.toLowerCase();
      while (true) {
        const idxLower = text.toLowerCase().indexOf(`<${tagLower}`, searchXml);
        if (idxLower === -1) break;
        const nextChar = text[idxLower + 1 + tagLower.length];
        const boundaryOk = !nextChar || /\s|>|\//.test(nextChar);
        if (boundaryOk && !isInCodeSpan(idxLower, codeRanges)) {
          if (earliestIdx === -1 || idxLower < earliestIdx) {
            earliestIdx = idxLower;
            earliestMatch = { type: 'xml', tag: tagLower };
          }
          break;
        }
        searchXml = idxLower + 1;
      }
    }

    if (earliestIdx === -1 || !earliestMatch) break;

    if (earliestMatch.type === 'bracket') {
      const cmd = extractBracketCommand(text, earliestIdx);
      if (cmd) {
        commands.push(cmd);
        pos = cmd.endIndex;
      } else {
        pos = earliestIdx + 1;
      }
    } else if (earliestMatch.type === 'xml') {
      const cmd = extractXmlCommand(text, earliestIdx, earliestMatch.tag);
      if (cmd) {
        commands.push(cmd);
        pos = cmd.endIndex;
      } else {
        pos = earliestIdx + 1;
      }
    }
  }

  return commands;
}

function parseTalkCommand(cmd) {
  if (!cmd) return null;

  // IN (Agent -> Parser): Parse XML talk
  if (cmd.syntax === 'xml') {
    const attrText = cmd.attributes || '';
    const targetMatch = attrText.match(/(?:agent-id|agent_id|target-id|target_id|target|agent|to|id)\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|[‘]([^’]+)[’]|([^\s>]+))/i);
    const rawId = targetMatch ? (targetMatch[1] || targetMatch[2] || targetMatch[3] || targetMatch[4] || targetMatch[5]) : '';
    const agentId = cleanTargetIdentifier(rawId);
    if (!agentId) return null;

    let task = undefined;
    const taskMatch = attrText.match(/\btask\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|[‘]([^’]+)[’]|([^\s>]+))/i);
    if (taskMatch) {
      task = stripQuotes(taskMatch[1] || taskMatch[2] || taskMatch[3] || taskMatch[4] || taskMatch[5] || '');
    }

    let message = cmd.body || '';
    if (!message) {
      const msgAttrMatch = attrText.match(/\b(?:message|msg|content)\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|[‘]([^’]+)[’]|([^\s>]+))/i);
      if (msgAttrMatch) {
        message = stripQuotes(msgAttrMatch[1] || msgAttrMatch[2] || msgAttrMatch[3] || msgAttrMatch[4] || msgAttrMatch[5] || '');
      }
    }

    const finalMessage = message.trim() || (task ? `New task: ${task}` : '');
    if (agentId && finalMessage) {
      return { agentId, message: finalMessage, ...(task ? { task: task.trim() } : {}) };
    }
    return null;
  }

  // Bracket fallback
  const tagContent = cmd.content || '';
  const targetMatch = tagContent.match(/(?:agent-id|agent_id|target-id|target_id|target|agent|to|id)\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|([^\s\]]+))/i);
  const rawId = targetMatch ? (targetMatch[1] || targetMatch[2] || targetMatch[3] || targetMatch[4]) : '';
  const agentId = cleanTargetIdentifier(rawId);
  if (!agentId) return null;

  let task = undefined;
  const taskMarkerMatch = tagContent.match(/\btask\s*=\s*/i);
  if (taskMarkerMatch && taskMarkerMatch.index !== undefined) {
    const taskStart = taskMarkerMatch.index + taskMarkerMatch[0].length;
    const afterTask = tagContent.substring(taskStart);
    const nextAttrMatch = afterTask.match(/\b(?:message|msg|content)\s*=/i);
    const rawTask = nextAttrMatch && nextAttrMatch.index !== undefined
      ? afterTask.substring(0, nextAttrMatch.index).trim()
      : afterTask.trim();
    if (rawTask) task = stripQuotes(rawTask);
  }

  const msgMarkerMatch = tagContent.match(/\b(message|msg|content)\s*=\s*/i);
  let message = undefined;
  if (msgMarkerMatch && msgMarkerMatch.index !== undefined) {
    const msgStart = msgMarkerMatch.index + msgMarkerMatch[0].length;
    const afterMsg = tagContent.substring(msgStart);
    const taskAfterMatch = afterMsg.match(/\btask\s*=/i);
    const rawMsg = taskAfterMatch && taskAfterMatch.index !== undefined
      ? afterMsg.substring(0, taskAfterMatch.index).trim()
      : afterMsg.trim();
    message = stripQuotes(rawMsg);
  }

  const finalMessage = (message && message.trim()) || (task && task.trim() ? `New task: ${task.trim()}` : '');
  if (agentId && finalMessage) {
    return { agentId, message: finalMessage, ...(task && task.trim() ? { task: task.trim() } : {}) };
  }
  return null;
}

function parseSpawnCommand(cmd) {
  if (!cmd) return null;

  // IN: Parse XML spawn
  if (cmd.syntax === 'xml') {
    const attrText = cmd.attributes || '';
    const roleMatch = attrText.match(/\brole\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|([^\s>]+))/i);
    const nameMatch = attrText.match(/\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|([^\s>]+))/i);
    const taskMatch = attrText.match(/\btask\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|([^\s>]+))/i);

    const role = cleanTargetIdentifier(roleMatch ? (roleMatch[1] || roleMatch[2] || roleMatch[3] || roleMatch[4]) : '');
    const name = cleanTargetIdentifier(nameMatch ? (nameMatch[1] || nameMatch[2] || nameMatch[3] || nameMatch[4]) : '');
    const task = stripQuotes(taskMatch ? (taskMatch[1] || taskMatch[2] || taskMatch[3] || taskMatch[4]) : '') || cmd.body.trim();

    if (role && name && task) {
      return { role, name, task };
    }
    return null;
  }

  // Bracket
  const content = cmd.content || '';
  const roleMatch = content.match(/\brole\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|([^\s\]]+))/i);
  const nameMatch = content.match(/\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|([^\s\]]+))/i);
  const taskMatch = content.match(/\btask\s*=\s*/i);

  const role = cleanTargetIdentifier(roleMatch ? (roleMatch[1] || roleMatch[2] || roleMatch[3] || roleMatch[4]) : '');
  const name = cleanTargetIdentifier(nameMatch ? (nameMatch[1] || nameMatch[2] || nameMatch[3] || nameMatch[4]) : '');
  let task = '';
  if (taskMatch && taskMatch.index !== undefined) {
    task = stripQuotes(content.substring(taskMatch.index + taskMatch[0].length));
  }

  if (role && name && task) {
    return { role, name, task };
  }
  return null;
}

function stripDualCommandTags(text) {
  if (!text) return '';
  const commands = extractDualCommands(text);
  if (commands.length === 0) return text.trim();
  let result = '';
  let lastIndex = 0;
  for (const cmd of commands) {
    result += text.substring(lastIndex, cmd.startIndex);
    lastIndex = cmd.endIndex;
  }
  result += text.substring(lastIndex);
  result = result.replace(/\[\/(?:TALK|SPAWN|STOP|RESUME|CREATE ROLE|STOP AGENT|RESUME AGENT|DELETE AGENT)\]/gi, '');
  result = result.replace(/<\/(?:talk|spawn|stop|resume|create_role)>/gi, '');
  return result.trim();
}

// OUT: Format orchestration response back (simulation)
function buildOutboundMessage(commands) {
  // Mô phỏng luồng ra: từ các lệnh parse được, tái tạo message điều phối
  return commands.map(cmd => {
    if (cmd.tag === 'TALK') {
      const p = parseTalkCommand(cmd);
      return p ? `[DELIVERED to ${p.agentId}: ${p.message}]` : `[TALK UNRESOLVED]`;
    }
    if (cmd.tag === 'SPAWN') {
      const p = parseSpawnCommand(cmd);
      return p ? `[SPAWNED ${p.role} ${p.name}]` : `[SPAWN UNRESOLVED]`;
    }
    return `[${cmd.tag} processed]`;
  });
}

// ==========================================
// TEST HARNESS
// ==========================================
let passed = 0;
let failed = 0;
const issues = [];

function assert(condition, message, detail) {
  if (condition) {
    console.log(`  [PASS] ${message}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${message}`);
    if (detail) console.error(`         Detail: ${JSON.stringify(detail)}`);
    issues.push({ message, detail });
    failed++;
  }
}

console.log('================================================================');
console.log('AGENTFORGE PARSE IN/OUT FLOW SIMULATION TEST');
console.log('================================================================\n');

// -------------------------------------------------------------
// CASE 1: XML spawn/talk lồng nhau (nested) trong cùng text
// -------------------------------------------------------------
console.log('--- CASE 1: XML spawn/talk lồng nhau ---');
const case1 = `<spawn role="coder" name="bot-1">Setup project</spawn> then <talk target="bot-1" task="Init">Run npm install.</talk>`;
const c1 = extractDualCommands(case1, ['TALK', 'SPAWN']);
assert(c1.length === 2, 'CASE1: Trích xuất 2 lệnh (spawn + talk) từ lồng nhau');
const p1Talk = parseTalkCommand(c1.find(c => c.tag === 'TALK') || null);
assert(p1Talk?.agentId === 'bot-1', 'CASE1: Talk trỏ đúng target bot-1');
const p1Spawn = parseSpawnCommand(c1.find(c => c.tag === 'SPAWN') || null);
assert(p1Spawn?.role === 'coder' && p1Spawn?.name === 'bot-1', 'CASE1: Spawn parse đúng role/name');
console.log(`       OUT: ${JSON.stringify(buildOutboundMessage(c1))}`);

// -------------------------------------------------------------
// CASE 2: Command trong codeblock (không được parse)
// -------------------------------------------------------------
console.log('\n--- CASE 2: Command bên trong fenced codeblock ---');
const case2 = "Sử dụng cách sau:\n```xml\n<spawn role=\"coder\" name=\"x\" task=\"y\" />\n```\nkhông phải lệnh thật.";
const c2 = extractDualCommands(case2, ['TALK', 'SPAWN']);
assert(c2.length === 0, 'CASE2: Không trích xuất lệnh trong codeblock (ĐÚNG)');

// -------------------------------------------------------------
// CASE 3: Ký tự đặc biệt '<' '>' trong text thường (narrative)
// -------------------------------------------------------------
console.log('\n--- CASE 3: Ký tự < > trong câu thường không phải tag ---');
const case3 = "So sánh a < b và c > d. Kết quả 5 < 10.";
const c3 = extractDualCommands(case3, ['TALK', 'SPAWN']);
assert(c3.length === 0, 'CASE3: Ký tự so sánh < > không bị parse nhầm thành tag');
assert(stripDualCommandTags(case3) === case3.trim(), 'CASE3: Văn bản narrative được bảo toàn nguyên vẹn');

// -------------------------------------------------------------
// CASE 4: HTML tags trong văn bản
// -------------------------------------------------------------
console.log('\n--- CASE 4: HTML tags <div>, <p>, <br> ---');
const case4 = "<div class=\"chat\"><p>Xin chào</p><br/>Đây là HTML</div>";
const c4 = extractDualCommands(case4, ['TALK', 'SPAWN']);
assert(c4.length === 0, 'CASE4: HTML tag không bị hiểu nhầm thành lệnh điều phối');

// -------------------------------------------------------------
// CASE 5: Trộn markdown headers + bảng + codeblock + lệnh thật
// -------------------------------------------------------------
console.log('\n--- CASE 5: Markdown tổng hợp (headers, bảng, codeblock, lệnh thật) ---');
const case5 = `# H1 Header
## H2 Header

| Agent | Role |
|-------|------|
| bot-a | coder |

\`\`\`js
const a = [1,2,3]; // [SPAWN] giả trong codeblock
\`\`\`

<talk target="bot-a" task="Test">Chạy unit test nhé!</talk>`;
const c5 = extractDualCommands(case5, ['TALK', 'SPAWN']);
assert(c5.length === 1, 'CASE5: Chỉ 1 lệnh thật được parse, [SPAWN] giả trong codeblock bị bỏ qua');
const p5 = parseTalkCommand(c5[0]);
assert(p5?.agentId === 'bot-a', 'CASE5: Talk vào đúng bot-a');
assert(p5?.message.includes('Chạy unit test'), 'CASE5: Message giữ nguyên nội dung tiếng Việt');

// -------------------------------------------------------------
// CASE 6: HTML entity & tiếng Việt có dấu trong message
// -------------------------------------------------------------
console.log('\n--- CASE 6: Unicode tiếng Việt + ký tự đặc biệt trong message ---');
const case6 = `<talk target="bot-viet">Ơ kìa! Chữ ẵ, ỡ, ừ có dấu &amp; ký tự &lt;b&gt; html &lt;/b&gt;</talk>`;
const c6 = extractDualCommands(case6, ['TALK']);
const p6 = parseTalkCommand(c6[0] || null);
assert(p6?.message.includes('Ơ kìa!'), 'CASE6: Chữ Ơ đầu dòng được bảo toàn');
assert(p6?.message.includes('ẵ, ỡ, ừ'), 'CASE6: Ký tự tiếng Việt có dấu giữ nguyên vẹn');

// -------------------------------------------------------------
// CASE 7: Bracket [SPAWN ...] cùng XML <talk> hỗn hợp
// -------------------------------------------------------------
console.log('\n--- CASE 7: Hỗn hợp [SPAWN] bracket + <talk> XML ---');
const case7 = `[SPAWN role=verifier name=audit task="Kiểm tra bảo mật"]
<talk target="audit" task="Review">Hãy review toàn bộ code.</talk>`;
const c7 = extractDualCommands(case7, ['TALK', 'SPAWN']);
assert(c7.length === 2, 'CASE7: Cả 2 cú pháp đều được trích xuất');
const p7s = parseSpawnCommand(c7.find(c => c.tag === 'SPAWN') || null);
assert(p7s?.name === 'audit' && p7s?.role === 'verifier', 'CASE7: Bracket [SPAWN] parse đúng');

// -------------------------------------------------------------
// CASE 8: Unclosed/unbalanced - parse vỡ?
// -------------------------------------------------------------
console.log('\n--- CASE 8: XML không đóng (streaming cut) ---');
const case8 = `<talk target="bot-1" task="Partial">Tin nhắn chưa đóng thẻ xong`;
const c8 = extractDualCommands(case8, ['TALK']);
assert(c8.length === 1, 'CASE8: XML chưa đóng vẫn được trích xuất (graceful)');
const p8 = parseTalkCommand(c8[0]);
assert(p8?.agentId === 'bot-1', 'CASE8: Target vẫn parse được khi thiếu thẻ đóng');
assert(p8?.message.includes('chưa đóng thẻ'), 'CASE8: Message body không bị nuốt');

// -------------------------------------------------------------
// CASE 9: chỉ có text tự sự, không lệnh => output giữ nguyên
// -------------------------------------------------------------
console.log('\n--- CASE 9: Văn bản thuần túy (UI strip) ---');
const case9 = "Bạn ơi, hãy giúp tôi kiểm tra nhé. Cảm ơn bạn!";
assert(stripDualCommandTags(case9) === case9, 'CASE9: Văn bản không có lệnh giữ nguyên 100%');

// -------------------------------------------------------------
// CASE 10: Nhầm lẫn tiềm ẩn — tag không có thuộc tính đủ
// -------------------------------------------------------------
console.log('\n--- CASE 10: Tag thiếu thuộc tính bắt buộc ---');
const case10 = `<talk>thiếu target</talk> <spawn role="x">thiếu name/task</spawn>`;
const c10 = extractDualCommands(case10, ['TALK', 'SPAWN']);
assert(c10.length === 2, 'CASE10: Cả 2 tag được trích xuất dạng cấu trúc');
const p10t = parseTalkCommand(c10[0]);
const p10s = parseSpawnCommand(c10[1]);
assert(p10t === null, 'CASE10: Talk thiếu target -> null (không thực thi nhầm)');
assert(p10s === null, 'CASE10: Spawn thiếu attrs -> null (không thực thi nhầm)');

// -------------------------------------------------------------
// KẾT LUẬN
// -------------------------------------------------------------
console.log('\n================================================================');
console.log(`KẾT QUẢ TỔNG: ${passed} PASSED, ${failed} FAILED`);
console.log('================================================================\n');

if (issues.length > 0) {
  console.error('CÁC VẤN ĐỀ (ISSUES) PHÁT HIỆN:');
  issues.forEach(i => console.error(`  - ${i.message}`));
  process.exit(1);
} else {
  console.log('=> KHÔNG phát hiện trường hợp parse vỡ hoặc bị hiểu nhầm.');
  process.exit(0);
}
