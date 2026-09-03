import { cleanTargetIdentifier, stripQuotes, INVALID_TARGET_PLACEHOLDERS } from './string-utils.js';
import { extractBracketCommand, findBalancedBracketRange } from './bracket-parser.js';
import { extractXmlCommand, type BracketCommand } from './xml-parser.js';

export * from './string-utils.js';
export * from './bracket-parser.js';
export * from './xml-parser.js';

export function getCodeFenceRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('```', i)) {
      const end = text.indexOf('```', i + 3);
      if (end !== -1) { ranges.push([i, end + 3] as [number, number]); i = end + 3; continue; }
      ranges.push([i, text.length] as [number, number]); break;
    }
    if (text[i] === '`') {
      const nextNewline = text.indexOf('\n', i + 1);
      const end = text.indexOf('`', i + 1);
      if (end !== -1 && (nextNewline === -1 || end < nextNewline)) {
        ranges.push([i, end + 1] as [number, number]);
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return ranges;
}

export function getCodeSpanRanges(text: string): Array<[number, number]> {
  const ranges = getCodeFenceRanges(text);
  const reportStartRe = /(?:===\s*(?:TASK|RESEARCH|VERIFICATION|ERROR)\s+REPORT\s*===|<\s*(?:report|task_report|task-report|error_report|error-report)\b[^>]*>)/gi;
  const reportEndRe = /(?:===\s*END[^=\n]*REPORT\s*===|<\/\s*(?:report|task_report|task-report|error_report|error-report)\s*>)/gi;
  let rm: RegExpExecArray | null;
  while ((rm = reportStartRe.exec(text)) !== null) {
    const startIdx = rm.index;
    reportEndRe.lastIndex = startIdx + rm[0].length;
    const em = reportEndRe.exec(text);
    if (em) {
      ranges.push([startIdx, em.index + em[0].length] as [number, number]);
    }
  }
  let scan = 0;
  while (scan < text.length) {
    const talkIdx = text.indexOf('[TALK', scan);
    const spawnIdx = text.indexOf('[SPAWN', scan);
    const nextTag = Math.min(
      talkIdx === -1 ? Infinity : talkIdx,
      spawnIdx === -1 ? Infinity : spawnIdx
    );
    if (nextTag === Infinity) break;
    const cmd = findBalancedBracketRange(text, nextTag);
    if (!cmd) { scan = nextTag + 1; continue; }
    const attrMatch = cmd.content.match(/\b(?:message|msg|content)\s*=\s*(?:"|'|“)([\s\S]*?)(?:"|'|”)/);
    if (attrMatch && attrMatch[1] !== undefined) {
      const valueStart = cmd.startIndex + cmd.raw.indexOf(attrMatch[1]);
      ranges.push([valueStart, valueStart + attrMatch[1].length] as [number, number]);
    }
    scan = cmd.endIndex;
  }
  const bqRe = /^[ \t]*>[ \t]?\S.*$/gm;
  let bm: RegExpExecArray | null;
  while ((bm = bqRe.exec(text)) !== null) {
    ranges.push([bm.index, bm.index + bm[0].length] as [number, number]);
  }
  const docListRe = /^[ \t]*(?:[-*+]|\d+\.)[ \t]+.*$/gm;
  let dlm: RegExpExecArray | null;
  while ((dlm = docListRe.exec(text)) !== null) {
    if (/<(?:talk|spawn|stop|resume|create_role|create-role|delete_agent)\b|\[(?:TALK|SPAWN|STOP|RESUME|CREATE ROLE)\b/i.test(dlm[0])) {
      ranges.push([dlm.index, dlm.index + dlm[0].length] as [number, number]);
    }
  }
  return ranges;
}

export function isInCodeSpan(idx: number, ranges: Array<[number, number]>): boolean {
  for (const [s, e] of ranges) if (idx >= s && idx < e) return true;
  return false;
}

export function extractDualCommands(text: string, targetTags: string[] = ['TALK', 'SPAWN', 'CREATE ROLE', 'STOP', 'RESUME', 'STOP AGENT', 'RESUME AGENT', 'DELETE AGENT']): BracketCommand[] {
  const commands: BracketCommand[] = [];
  if (!text) return commands;
  const codeRanges = getCodeSpanRanges(text);

  let pos = 0;
  while (pos < text.length) {
    let earliestMatch: { type: 'bracket' | 'xml'; tag: string; searchTag: string } | null = null;
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
            earliestMatch = { type: 'bracket', tag, searchTag: tag };
          }
          break;
        }
        searchBracket = idx + 1;
      }

      let searchXml = pos;
      const tagLower = tag.toLowerCase().replace(/\s+/g, '_');
      const tagLowerDash = tag.toLowerCase().replace(/\s+/g, '-');
      const xmlVariants = [tagLower];
      if (tagLowerDash !== tagLower) xmlVariants.push(tagLowerDash);

      for (const variant of xmlVariants) {
        let sXml = searchXml;
        while (true) {
          const idxLower = text.toLowerCase().indexOf(`<${variant}`, sXml);
          if (idxLower === -1) break;
          const nextChar = text[idxLower + 1 + variant.length];
          const boundaryOk = !nextChar || /\s|>|\//.test(nextChar);
          if (boundaryOk && !isInCodeSpan(idxLower, codeRanges)) {
            if (earliestIdx === -1 || idxLower < earliestIdx) {
              earliestIdx = idxLower;
              earliestMatch = { type: 'xml', tag, searchTag: variant };
            }
            break;
          }
          sXml = idxLower + 1;
        }
      }
    }

    if (earliestIdx === -1 || !earliestMatch) break;

    if (earliestMatch.type === 'bracket') {
      const cmd = extractBracketCommand(text, earliestIdx);
      if (cmd) {
        commands.push({ ...cmd, syntax: 'bracket' });
        pos = cmd.endIndex;
      } else {
        pos = earliestIdx + 1;
      }
    } else if (earliestMatch.type === 'xml') {
      const cmd = extractXmlCommand(text, earliestIdx, earliestMatch.searchTag);
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

export function extractBracketCommands(text: string, targetTags: string[] = ['TALK', 'SPAWN', 'CREATE ROLE', 'STOP', 'RESUME', 'STOP AGENT', 'RESUME AGENT', 'DELETE AGENT', 'TASK_UPDATE', 'TASK UPDATE']): BracketCommand[] {
  return extractDualCommands(text, targetTags);
}

export function stripCommandTags(text: string): string {
  if (!text) return '';
  const commands = extractDualCommands(text, ['TALK', 'SPAWN', 'CREATE ROLE', 'STOP', 'RESUME', 'STOP AGENT', 'RESUME AGENT', 'DELETE AGENT', 'TASK_UPDATE', 'TASK UPDATE']);
  if (commands.length === 0) return text.trim();
  let result = '';
  let lastIndex = 0;
  for (const cmd of commands) {
    result += text.substring(lastIndex, cmd.startIndex);
    lastIndex = cmd.endIndex;
  }
  result += text.substring(lastIndex);
  result = result.replace(/\[\/(?:TALK|SPAWN|STOP|RESUME|CREATE ROLE|STOP AGENT|RESUME AGENT|DELETE AGENT|TASK_UPDATE|TASK UPDATE)\]/gi, '');
  result = result.replace(/<\/(?:talk|spawn|stop|stop_agent|stop-agent|resume|resume_agent|resume-agent|create_role|create-role|delete|delete_agent|delete-agent|task_update|task-update)>/gi, '');
  return result.trim();
}

export function parseTalkTag(tagContent: string): { agentId: string; message: string; task?: string } | null {
  if (!tagContent) return null;

  const targetMatch = tagContent.match(/(?:agent-id|agent_id|target-id|target_id|target|agent|to|id)\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|([^\s\]]+))/i);
  const rawId = targetMatch ? (targetMatch[1] || targetMatch[2] || targetMatch[3] || targetMatch[4]) : '';
  const agentId = cleanTargetIdentifier(rawId);
  if (!agentId) return null;

  let task: string | undefined = undefined;
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
  let message: string | undefined = undefined;
  if (msgMarkerMatch && msgMarkerMatch.index !== undefined) {
    const msgStart = msgMarkerMatch.index + msgMarkerMatch[0].length;
    const afterMsg = tagContent.substring(msgStart);
    const taskAfterMatch = afterMsg.match(/\btask\s*=/i);
    const rawMsg = taskAfterMatch && taskAfterMatch.index !== undefined
      ? afterMsg.substring(0, taskAfterMatch.index).trim()
      : afterMsg.trim();
    message = stripQuotes(rawMsg);
  }

  const trimmedTask = task && task.trim() ? task.trim() : undefined;
  const trimmedMessage = message && message.trim() ? message.trim() : undefined;
  const finalMessage = trimmedMessage || (trimmedTask ? `New task: ${trimmedTask}` : '');
  if (agentId && finalMessage) {
    return { agentId, message: finalMessage, ...(trimmedTask ? { task: trimmedTask } : {}) };
  }
  return null;
}

export function parseTalkCommand(cmd: BracketCommand): { agentId: string; message: string; task?: string } | null {
  if (!cmd) return null;

  if (cmd.syntax === 'xml') {
    const attrText = cmd.attributes || '';
    const targetMatch = attrText.match(/(?:agent-id|agent_id|target-id|target_id|target|agent|to|id)\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|[‘]([^’]+)[’]|([^\s>]+))/i);
    const rawId = targetMatch ? (targetMatch[1] || targetMatch[2] || targetMatch[3] || targetMatch[4] || targetMatch[5]) : '';
    const agentId = cleanTargetIdentifier(rawId);
    if (!agentId) return null;

    let task: string | undefined = undefined;
    const taskMatch = attrText.match(/\btask\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|[‘]([^’]+)[’]|([^\s>]+))/i);
    if (taskMatch) {
      task = stripQuotes(taskMatch[1] || taskMatch[2] || taskMatch[3] || taskMatch[4] || taskMatch[5] || '');
    }

    let message = cmd.body || '';
    if (task && message) {
      const taskTagMatch = message.match(/<task>([\s\S]*?)<\/task>/i);
      if (taskTagMatch) {
        task = taskTagMatch[1].trim();
        message = message.replace(/<task>[\s\S]*?<\/task>/i, '').trim();
      }
    }
    if (!task && message) {
      const taskTagMatch2 = message.match(/<task>([\s\S]*?)<\/task>/i);
      if (taskTagMatch2) {
        task = taskTagMatch2[1].trim();
        message = message.replace(/<task>[\s\S]*?<\/task>/i, '').trim();
      }
    }
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

  return parseTalkTag(cmd.content || '');
}

export function parseSpawnCommand(cmd: BracketCommand): { role: string; name: string; task: string } | null {
  if (!cmd) return null;

  const INVALID_PLACEHOLDERS = new Set(['<role>', '<name>', '<task>', 'role', 'name', 'task', '...', 'none', 'undefined', 'null', 'your-name', '<your-name>']);

  if (cmd.syntax === 'xml') {
    const attrText = cmd.attributes || '';
    const roleMatch = attrText.match(/\brole\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|([^\s>]+))/i);
    const nameMatch = attrText.match(/\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|([^\s>]+))/i);
    const taskMatch = attrText.match(/\btask\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|([^\s>]+))/i);

    const role = cleanTargetIdentifier(roleMatch ? (roleMatch[1] || roleMatch[2] || roleMatch[3] || roleMatch[4]) : '').toLowerCase();
    const name = cleanTargetIdentifier(nameMatch ? (nameMatch[1] || nameMatch[2] || nameMatch[3] || nameMatch[4]) : '');
    let task = stripQuotes(taskMatch ? (taskMatch[1] || taskMatch[2] || taskMatch[3] || taskMatch[4]) : '');
    let bodyContent = '';
    if (cmd.body) {
      const taskTagMatch = cmd.body.match(/<task>([\s\S]*?)<\/task>/i);
      if (taskTagMatch) {
        if (!task) task = taskTagMatch[1].trim();
        bodyContent = cmd.body.replace(/<task>[\s\S]*?<\/task>/i, '').trim();
      } else {
        bodyContent = cmd.body.trim();
      }
    }
    if (task && bodyContent) {
      task = `${task} — ${bodyContent}`;
    } else if (!task && bodyContent) {
      task = bodyContent;
    }

    if (role && name && task && !INVALID_PLACEHOLDERS.has(role) && !INVALID_PLACEHOLDERS.has(name.toLowerCase())) {
      return { role, name, task };
    }
    return null;
  }

  const attrsText = cmd.content || '';
  const roleMatch = attrsText.match(/role=(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  const nameMatch = attrsText.match(/name=(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|(\S+))/i);
  const taskRegex = /task\s*=\s*/i;
  const taskMatch = attrsText.match(taskRegex);

  if (roleMatch && nameMatch && taskMatch) {
    let role = (roleMatch[1] || roleMatch[2] || roleMatch[3] || '').trim().toLowerCase();
    let name = (nameMatch[1] || nameMatch[2] || nameMatch[3] || nameMatch[4] || '').trim();
    role = cleanTargetIdentifier(role);
    name = cleanTargetIdentifier(name);
    if (!role || !name || INVALID_PLACEHOLDERS.has(role) || INVALID_PLACEHOLDERS.has(name.toLowerCase())) {
      return null;
    }
    const taskIndex = attrsText.search(taskRegex);
    const valStart = taskIndex + taskMatch[0].length;
    let rawTask = attrsText.substring(valStart).trim();
    rawTask = stripQuotes(rawTask);
    const task = rawTask.trim().normalize('NFC');
    if (task && !INVALID_PLACEHOLDERS.has(task.toLowerCase())) {
      return { role, name, task };
    }
  }
  return null;
}

export function parseSpawnTags(text: string): Array<{ role: string; name: string; task: string }> {
  const spawns: Array<{ role: string; name: string; task: string }> = [];
  if (!text) return spawns;
  const commands = extractBracketCommands(text, ['SPAWN']);
  for (const cmd of commands) {
    const parsed = parseSpawnCommand(cmd);
    if (parsed) {
      spawns.push(parsed);
      console.log(`[SpawnParse] Hợp lệ: role=${parsed.role} name=${parsed.name} task="${parsed.task.slice(0, 60)}..."`);
    }
  }
  return spawns;
}

export function parseOrchestratorCommands(
  text: string,
  targetOrchId: string = 'orchestrator',
  onParseFail?: (target: string, rawAttr: string) => void
): Array<{ agentId: string; message: string; task?: string }> {
  const talks: Array<{ agentId: string; message: string; task?: string }> = [];
  if (!text) return talks;
  const commands = extractBracketCommands(text, ['TALK']);
  for (const cmd of commands) {
    const parsed = parseTalkCommand(cmd);
    if (parsed) {
      talks.push(parsed);
    } else if (cmd.attributes && onParseFail) {
      const attrText = cmd.attributes;
      const rawTarget = (attrText.match(/(?:agent-id|agent_id|target-id|target_id|target|agent|to|id)\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|[‘]([^’]+)[’]|([^\s>]+))/i) || []).slice(1).find(v => v);
      if (rawTarget) {
        const cleanRaw = cleanTargetIdentifier(rawTarget.trim());
        const isPlaceholder = !cleanRaw || INVALID_TARGET_PLACEHOLDERS.has(cleanRaw.toLowerCase()) || cleanRaw === 'worker' || cleanRaw === 'target-id' || cleanRaw === 'agent-id';
        if (!isPlaceholder) {
          onParseFail(cleanRaw, attrText);
        }
      }
    }
  }
  return talks;
}

export function parseAgentOutput(
  content: string,
  defaultTo: string = 'orchestrator',
  findAgentFn?: (id: string) => { id: string } | undefined
): { to: string; message: string; task?: string }[] {
  const matches: { to: string; message: string; task?: string }[] = [];
  if (!content) return matches;

  const talks = parseOrchestratorCommands(content);
  for (const talk of talks) {
    let resolvedTo = 'orchestrator';
    let cleanTo = cleanTargetIdentifier(talk.agentId);
    if (!cleanTo || cleanTo.toLowerCase() === 'orchestrator' || cleanTo.toLowerCase() === 'main') {
      resolvedTo = 'orchestrator';
    } else if (cleanTo.toLowerCase() === 'user') {
      resolvedTo = 'user';
    } else {
      const found = findAgentFn ? findAgentFn(cleanTo) : undefined;
      resolvedTo = found ? found.id : cleanTo;
    }
    matches.push({ to: resolvedTo, message: talk.message, task: (talk as any).task });
  }

  const cleanContent = stripCommandTags(content);
  const tagRegex = /(?:\[FROM:\s*[^\]]+\]\s*)?\[TO:\s*([^\]]+)\]/gi;

  function isInsideCodeBlockOrSpan(text: string, index: number): boolean {
    let inFenced = false;
    let inInline = false;
    for (let i = 0; i < index && i < text.length; i++) {
      if (text.startsWith('```', i)) {
        inFenced = !inFenced;
        i += 2;
      } else if (text[i] === '`' && !inFenced) {
        inInline = !inInline;
      }
    }
    return inFenced || inInline;
  }

  const tagMatches: Array<{ index: number; length: number; rawTo: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(cleanContent)) !== null) {
    if (isInsideCodeBlockOrSpan(cleanContent, m.index)) {
      continue;
    }
    const cleanCandidate = cleanTargetIdentifier(m[1]);
    const rawTarget = (m[1] || '').trim();
    const cleanLower = (cleanCandidate || '').toLowerCase();
    const isSpecialRoute = cleanLower === 'orchestrator' || cleanLower === 'user' || cleanLower === 'main' || cleanLower === 'all' || cleanLower === 'broadcast';
    const isValidId = /^[A-Za-z0-9_-]+$/.test(cleanCandidate);
    const isPlaceholder = INVALID_TARGET_PLACEHOLDERS.has(cleanLower) || /^<.*>$/.test(rawTarget) || !cleanCandidate || !isValidId;
    if (isPlaceholder && !isSpecialRoute) {
      continue;
    }
    tagMatches.push({
      index: m.index,
      length: m[0].length,
      rawTo: m[1]
    });
  }

  if (tagMatches.length === 0) {
    const finalClean = cleanContent.replace(/\[FROM:\s*[^\]]+\]/gi, '').trim();
    if (finalClean) {
      matches.push({ to: defaultTo, message: finalClean });
    }
    return matches;
  }

  for (let i = 0; i < tagMatches.length; i++) {
    const cur = tagMatches[i];
    const startIndex = cur.index + cur.length;
    const endIndex = (i + 1 < tagMatches.length) ? tagMatches[i + 1].index : cleanContent.length;

    let msgText = cleanContent.substring(startIndex, endIndex).trim();
    msgText = msgText.replace(/\[FROM:\s*[^\]]+\]\s*$/i, '').trim();

    let extractedTask: string | undefined = undefined;
    const taskBlockMatch = msgText.match(/^\s*\[TASK\]\s*\n?([^\[]*)/i);
    if (taskBlockMatch) {
      const taskContent = taskBlockMatch[1] || '';
      const firstLine = taskContent.split('\n')[0].trim();
      extractedTask = firstLine ? firstLine.slice(0, 80) : undefined;
      msgText = msgText.replace(/^\s*\[TASK\]\s*\n?[^\[]*/i, '').trim();
    }

    let cleanTo = cleanTargetIdentifier(cur.rawTo);
    let resolvedTo = 'orchestrator';
    if (!cleanTo || cleanTo.toLowerCase() === 'orchestrator' || cleanTo.toLowerCase() === 'main') {
      resolvedTo = 'orchestrator';
    } else if (cleanTo.toLowerCase() === 'user') {
      resolvedTo = 'user';
    } else {
      const found = findAgentFn ? findAgentFn(cleanTo) : undefined;
      resolvedTo = found ? found.id : cleanTo;
    }

    if (msgText) {
      matches.push({ to: resolvedTo, message: msgText, ...(extractedTask ? { task: extractedTask } : {}) });
    }
  }

  const seen = new Set<string>();
  const deduped: typeof matches = [];
  for (const matchItem of matches) {
    const key = `${matchItem.to}|||${matchItem.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(matchItem);
    }
  }

  const merged: typeof deduped = [];
  for (const matchItem of deduped) {
    const last = merged[merged.length - 1];
    if (last && last.to === 'orchestrator' && matchItem.to === 'orchestrator') {
      last.message = `${last.message}\n\n${matchItem.message}`;
      if (matchItem.task) last.task = last.task || matchItem.task;
    } else {
      merged.push({ ...matchItem });
    }
  }
  return merged;
}

export function sanitizeCommandInput(text: string): string {
  if (!text) return '';
  return text
    .replace(/```[\s\S]*?```/g, '') // strip fenced code blocks
    .replace(/`[^`\n]*`/g, '')      // strip inline code
    .replace(/^\s*>.*$/gm, '');     // strip blockquotes
}
