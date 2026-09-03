/**
 * test_dual_parser.js - Comprehensive Test Suite for Dual-Syntax Command Parser
 * 
 * Tests both Bracket Syntax ([TALK ...], [SPAWN ...]) and XML Tag Syntax (<talk>...</talk>, <spawn>...</spawn>)
 * for LLM orchestration and command extraction.
 */

// ==========================================
// DUAL-SYNTAX PARSER REFERENCE IMPLEMENTATION
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

  // Extract attributes from openTag
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

  // Look for closing tag </targetTag>
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
    // Unclosed XML tag fallback - extends to next command or EOF
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
      // 1. Bracket search: [TAG ...
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

      // 2. XML search: <tag ... or <TAG ...
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

    // Message can be body or message attribute
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

  // Bracket syntax fallback
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

  // Bracket syntax
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
  // Clean lingering closing tags
  result = result.replace(/\[\/(?:TALK|SPAWN|STOP|RESUME|CREATE ROLE|STOP AGENT|RESUME AGENT|DELETE AGENT)\]/gi, '');
  result = result.replace(/<\/(?:talk|spawn|stop|resume|create_role)>/gi, '');
  return result.trim();
}

// ==========================================
// TEST SUITE EXECUTION
// ==========================================

let passed = 0;
let failed = 0;

function assert(condition, message, details) {
  if (condition) {
    console.log(`  [PASS] ${message}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${message}`);
    if (details) console.error(`         Details: ${JSON.stringify(details)}`);
    failed++;
  }
}

console.log('================================================================');
console.log('AGENTFORGE DUAL-SYNTAX COMMAND PARSER COMPREHENSIVE TEST SUITE');
console.log('================================================================\n');

// -------------------------------------------------------------
// Scenario 1: XML Syntax with Nested Code Blocks (Markdown/TS)
// -------------------------------------------------------------
console.log('--- TEST 1: XML <talk> with nested TypeScript code block ---');
const text1 = `<talk target="agent-123">Hello \`\`\`ts\nconst x = [1, 2];\n\`\`\`</talk>`;

const cmds1 = extractDualCommands(text1, ['TALK']);
assert(cmds1.length === 1, 'Should extract 1 XML TALK command');
const parsed1 = parseTalkCommand(cmds1[0]);
assert(parsed1?.agentId === 'agent-123', 'Agent ID should be agent-123');
assert(parsed1?.message.includes('const x = [1, 2];'), 'Message should contain nested TS code');

// -------------------------------------------------------------
// Scenario 1B: XML <talk> with multiline, mixed quotes and brackets in body
// -------------------------------------------------------------
console.log('\n--- TEST 1B: XML <talk> with multiline, quotes, single quotes, brackets ---');
const text1b = `<talk target="agent-123" task="Fix bug">Line 1
Line 2 "quotes" 'single' [brackets]</talk>`;

const cmds1b = extractDualCommands(text1b, ['TALK']);
assert(cmds1b.length === 1, 'Should extract 1 XML TALK command with special chars');
const parsed1b = parseTalkCommand(cmds1b[0]);
assert(parsed1b?.agentId === 'agent-123', 'Agent ID should be agent-123');
assert(parsed1b?.task === 'Fix bug', 'Task should be Fix bug');
assert(parsed1b?.message.includes('Line 1\nLine 2 "quotes" \'single\' [brackets]'), 'Message should preserve exact multiline content with quotes and brackets');

// -------------------------------------------------------------
// Scenario 1C: XML Self-closing <spawn role="coder" name="tester" task="Run unit tests" />
// -------------------------------------------------------------
console.log('\n--- TEST 1C: XML Self-closing <spawn /> ---');
const text1c = `<spawn role="coder" name="tester" task="Run unit tests" />`;
const cmds1c = extractDualCommands(text1c, ['SPAWN']);
assert(cmds1c.length === 1, 'Should extract 1 self-closing SPAWN tag');
const parsed1c = parseSpawnCommand(cmds1c[0]);
assert(parsed1c?.role === 'coder', 'Spawn role should be coder');
assert(parsed1c?.name === 'tester', 'Spawn name should be tester');
assert(parsed1c?.task === 'Run unit tests', 'Spawn task should be Run unit tests');

// -------------------------------------------------------------
// Scenario 2: Unclosed XML Tag (LLM streaming cut-off / truncation)
// -------------------------------------------------------------
console.log('\n--- TEST 2: Unclosed XML <talk target="agent-123" ...> tag ---');
const text2 = `<talk target="agent-123" task="Fix critical crash">
Please inspect the memory leak in worker thread and patch it.`;

const cmds2 = extractDualCommands(text2, ['TALK']);
assert(cmds2.length === 1, 'Should extract 1 unclosed XML command gracefully');
const parsed2 = parseTalkCommand(cmds2[0]);
assert(parsed2?.agentId === 'agent-123', 'Agent ID extracted from unclosed tag');
assert(parsed2?.task === 'Fix critical crash', 'Task attribute extracted');
assert(parsed2?.message.includes('Please inspect the memory leak'), 'Message body extracted without closing tag');

// -------------------------------------------------------------
// Scenario 3: Self-closing XML <talk /> and <spawn />
// -------------------------------------------------------------
console.log('\n--- TEST 3: Self-closing XML tags ---');
const text3 = `<talk target="agent-456" task="Run regression suite" message="Start tests immediately" />
<spawn role="researcher" name="web-searcher" task="Search docs online" />`;

const cmds3 = extractDualCommands(text3, ['TALK', 'SPAWN']);
assert(cmds3.length === 2, 'Should extract 2 self-closing XML commands');
const parsedTalk3 = parseTalkCommand(cmds3[0]);
assert(parsedTalk3?.agentId === 'agent-456', 'Talk target parsed');
assert(parsedTalk3?.message === 'Start tests immediately', 'Talk message attribute parsed');
assert(parsedTalk3?.task === 'Run regression suite', 'Talk task attribute parsed');

const parsedSpawn3 = parseSpawnCommand(cmds3[1]);
assert(parsedSpawn3?.role === 'researcher', 'Spawn role parsed');
assert(parsedSpawn3?.name === 'web-searcher', 'Spawn name parsed');
assert(parsedSpawn3?.task === 'Search docs online', 'Spawn task parsed');

// -------------------------------------------------------------
// Scenario 4: Bracket Syntax [TALK ...] with Multiline and Code Block
// -------------------------------------------------------------
console.log('\n--- TEST 4: Classic Bracket [TALK target=... message=...] with code block ---');
const text4 = `[TALK target=backend-refactor task="Refactor HTTP adapter" message="Here is the fix:
\`\`\`json
{
  "port": 8080,
  "timeout": 30000
}
\`\`\`
Please verify!"]`;

const cmds4 = extractDualCommands(text4, ['TALK']);
assert(cmds4.length === 1, 'Should extract 1 bracket TALK command');
const parsed4 = parseTalkCommand(cmds4[0]);
assert(parsed4?.agentId === 'backend-refactor', 'Agent ID parsed from bracket syntax');
assert(parsed4?.task === 'Refactor HTTP adapter', 'Task parsed from bracket syntax');
assert(parsed4?.message.includes('"port": 8080'), 'Message contains JSON code block');

// -------------------------------------------------------------
// Scenario 5: Mixed Dual-Syntax in Same Turn (XML + Bracket + Narrative)
// -------------------------------------------------------------
console.log('\n--- TEST 5: Mixed Dual-Syntax (Bracket + XML + Narrative text) ---');
const text5 = `I will assign the tasks to our workers right away.

<talk target="coder-1" task="Implement auth module">
Please implement JWT authentication with refresh tokens.
</talk>

[TALK target=verifier-1 task="Audit security" message="Review the auth module when ready."]

<spawn role="tester" name="e2e-tester" task="Run end-to-end authentication tests">
Set up Cypress or Playwright tests for login flow.
</spawn>

All assignments dispatched successfully.`;

const cmds5 = extractDualCommands(text5, ['TALK', 'SPAWN']);
assert(cmds5.length === 3, 'Should extract 3 commands (2 TALK, 1 SPAWN) across both syntaxes');
assert(cmds5[0].syntax === 'xml', 'Command 0 is XML syntax');
assert(cmds5[1].syntax === 'bracket', 'Command 1 is bracket syntax');
assert(cmds5[2].syntax === 'xml', 'Command 2 is XML syntax');

const stripped5 = stripDualCommandTags(text5);
assert(stripped5.includes('I will assign the tasks to our workers right away.'), 'Pre-narrative preserved');
assert(stripped5.includes('All assignments dispatched successfully.'), 'Post-narrative preserved');
assert(!stripped5.includes('<talk'), 'XML talk tags stripped');
assert(!stripped5.includes('[TALK'), 'Bracket talk tags stripped');
assert(!stripped5.includes('<spawn'), 'XML spawn tags stripped');

// -------------------------------------------------------------
// Scenario 6: Code Block Protection (Commands inside markdown fenced blocks)
// -------------------------------------------------------------
console.log('\n--- TEST 6: Code block protection (Ignore commands inside markdown code blocks) ---');
const text6 = `Here is an example of how to format a command:
\`\`\`markdown
<talk target="agent-fake">This is an example code snippet, not a real command</talk>
[TALK target=agent-fake2 message="Another example in code block"]
\`\`\`
Now here is the REAL command:
<talk target="agent-real">Execute task #123</talk>`;

const cmds6 = extractDualCommands(text6, ['TALK']);
assert(cmds6.length === 1, 'Only real command outside code block should be extracted');
const parsed6 = parseTalkCommand(cmds6[0]);
assert(parsed6?.agentId === 'agent-real', 'Extracted agent ID must be agent-real');
assert(parsed6?.message === 'Execute task #123', 'Extracted message matches real command');

// -------------------------------------------------------------
// Scenario 7: Quotes and Smart Quotes Tolerance
// -------------------------------------------------------------
console.log('\n--- TEST 7: Single quotes, double quotes, smart quotes tolerance ---');
const text7 = `<talk target=“agent-unicode” task=‘Unicode Task’ message=“Xin chào thế giới! [Test nested brackets]” />`;
const cmds7 = extractDualCommands(text7, ['TALK']);
assert(cmds7.length === 1, 'Parsed unicode smart quoted command');
const parsed7 = parseTalkCommand(cmds7[0]);
assert(parsed7?.agentId === 'agent-unicode', 'Target parsed from unicode smart quotes');
assert(parsed7?.task === 'Unicode Task', 'Task parsed from single quotes');
assert(parsed7?.message.includes('Xin chào thế giới!'), 'Message content preserved with special characters');

// -------------------------------------------------------------
// Scenario 8: Bracket/XML Tag in user input preserved
// -------------------------------------------------------------
console.log('\n--- TEST 8: StripCommandTags idempotency & empty handling ---');
assert(stripDualCommandTags('') === '', 'Empty string returns empty');
assert(stripDualCommandTags('No commands here') === 'No commands here', 'Plain text unchanged');

// -------------------------------------------------------------
// Scenario 9: Fallback for Invalid Tags, Corrupted Tags, Missing Target
// -------------------------------------------------------------
console.log('\n--- TEST 9: Graceful fallback for invalid/corrupted tags ---');
const invalid1 = `<talk>Missing target attribute</talk>`;
const cmdInv1 = extractDualCommands(invalid1, ['TALK']);
assert(cmdInv1.length === 1, 'Extracted tag even with missing target');
const parsedInv1 = parseTalkCommand(cmdInv1[0]);
assert(parsedInv1 === null, 'Parse talk command returns null when target is missing');

const invalid2 = `<spawn role="coder">Missing name and task</spawn>`;
const cmdInv2 = extractDualCommands(invalid2, ['SPAWN']);
assert(cmdInv2.length === 1, 'Extracted spawn tag');
const parsedInv2 = parseSpawnCommand(cmdInv2[0]);
assert(parsedInv2 === null, 'Parse spawn command returns null when required attrs are missing');

const invalid3 = `<talk target="agent-test"`;
const cmdInv3 = extractDualCommands(invalid3, ['TALK']);
assert(cmdInv3.length === 0, 'Malformed tag without closing angle bracket not extracted');

// -------------------------------------------------------------
// Final Summary
// -------------------------------------------------------------
console.log('\n================================================================');
console.log(`TOTAL RESULTS: ${passed} PASSED, ${failed} FAILED`);
console.log('================================================================');

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
