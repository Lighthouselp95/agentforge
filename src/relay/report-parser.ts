// ============ REPORT PARSER & FORMATTER ============
import {
  getCodeFenceRanges,
  isInCodeSpan,
  parseAgentOutput as coreParseAgentOutput
} from '../core/command-parser.js';

// Lọc bỏ nhiễu toolcall trong content gửi về Orchestrator/main: dòng "● [TOOL ...]", "[TOOL RESULT ...]", "🔧 ..."
export function stripToolNoiseForOrchestrator(text: string): string {
  return (text || '')
    .split('\n')
    .filter(l => !/^\s*●\s*\[TOOL/i.test(l) && !/^\s*\[TOOL RESULT\]/i.test(l) && !/^\s*🔧/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Kiểm tra khối report: chấp nhận bất kỳ nội dung nào bên trong thẻ <report> hoặc khối report (tự do, không ép KEY: hay JSON)
export function hasReportBody(text: string): boolean {
  const body = (text || '').trim();
  if (!body) return false;
  // Loại bỏ thẻ mở/đóng thuần (VD === TASK REPORT === / === END REPORT === / <report>).
  const stripped = body
    .replace(/===\s*(?:TASK|RESEARCH|VERIFICATION|ERROR)\s+REPORT\s*===/gi, '')
    .replace(/===\s*END[^=\n]*REPORT\s*===/gi, '')
    .replace(/<\/?\s*(?:report|task_report|task-report|error_report|error-report)\s*>?/gi, '')
    .trim();
  return stripped.length > 0;
}

export function findReportMarkerOutsideCode(text: string): number | undefined {
  const fences = getCodeFenceRanges(text);
  const isCoded = (idx: number) => {
    for (const [s, e] of fences) if (idx >= s && idx < e) return true;
    return false;
  };
  const re = /===\s*(?:TASK|RESEARCH|VERIFICATION|ERROR)\s+REPORT\s*===/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!isCoded(m.index)) return m.index;
  }
  return undefined;
}

export function extractCleanTaskReport(content: string): string {
  const text = content || '';

  // 0. Nếu marker xuất hiện TRONG code fence (literal ví dụ) → KHÔNG phải report thật,
  // trả về text gốc để không bóc nhầm code sample thành report (hoặc cắt rỗng gốc).
  const haveRealMarker = findReportMarkerOutsideCode(text) !== undefined;

  // 1. Thẻ XML <report>...</report> (hoặc <task_report>, <error_report>)
  // Chỉ chấp nhận khi có marker header thật ngoài code, hoặc thẻ XML xuất hiện ngoài code fence.
  const xmlReportMatch = text.match(/<(?:\s*(?:report|task_report|task-report|error_report|error-report))\b[^>]*>([\s\S]*?)<\/\s*(?:report|task_report|task-report|error_report|error-report)\s*>/i);
  if (xmlReportMatch && xmlReportMatch.index !== undefined && !isInCodeSpan(xmlReportMatch.index, getCodeFenceRanges(text))) {
    return xmlReportMatch[0].trim();
  }

  // 2. Cú pháp Bracket === TASK REPORT === ... === END REPORT ===
  const startIdx = findReportMarkerOutsideCode(text);
  if (startIdx === undefined || !haveRealMarker) return text;
  let from = startIdx;
  // Giữ kèm dòng "Task complete." (hoặc "[TO: ...] Task complete.") ngay trước marker nếu có
  const before = text.slice(0, startIdx);
  const beforeTrim = before.trimEnd();
  const lastLineMatch = beforeTrim.match(/(?:^|\n)([^\n]*Task complete\.?[^\n]*)$/i);
  if (lastLineMatch) {
    from = beforeTrim.length - lastLineMatch[1].length;
  }
  // Marker kết thúc tương ứng: === END <loại> REPORT === (tìm ngoài code fence nếu có thể)
  const afterStart = text.slice(startIdx);
  const fencesAfter = getCodeFenceRanges(afterStart);
  const isCodedAfter = (idx: number) => {
    for (const [s, e] of fencesAfter) if (idx >= s && idx < e) return true;
    return false;
  };
  let end = text.length;
  const endRe = /===\s*END[^=\n]*REPORT\s*===/gi;
  let em: RegExpExecArray | null;
  while ((em = endRe.exec(afterStart)) !== null) {
    if (!isCodedAfter(em.index)) {
      end = startIdx + em.index + em[0].length;
      break;
    }
  }
  const report = text.slice(from, end).trim();
  // An toàn: nếu bóc ra nhưng rỗng/trống không (không có body thật: không dòng KEY: nào) →
  // trả về toàn bộ text gốc để fallback ở candidate xử lý.
  return hasReportBody(report) ? report : text.trim();
}

export function isEmptyAgentOutput(text: string | undefined | null): boolean {
  const t = (text || '').trim();
  return t.length === 0 || t === '(No response)';
}

export function parseAgentOutput(content: string, defaultTo: string = 'orchestrator'): { to: string; message: string; task?: string }[] {
  return coreParseAgentOutput(content, defaultTo);
}

export function formatIncomingHeader(fromName: string, fromId: string, fromRole: string, toName: string, toId: string, toRole: string): string {
  return `=== INCOMING MESSAGE ===\nFROM: ${fromName} (ID: ${fromId}, Role: ${fromRole})\nTO: ${toName} (ID: ${toId}, Role: ${toRole})\n=== MESSAGE ===`;
}

export function buildWorkerTalkPrompt(
  teamPrompt: string,
  from: { name: string; id: string; role: string; type?: string },
  to: { name: string; id: string; role: string; type?: string },
  message: string,
  workerReminder: string
): string {
  const header = formatIncomingHeader(from.name, from.id, from.role, to.name, to.id, to.role);
  const isFromOrch = from.role === 'orchestrator' || from.type === 'orchestrator' || from.id === 'orchestrator';
  const teamBlock = isFromOrch && teamPrompt ? `[TEAM]\n${teamPrompt}\n[/TEAM]\n\n` : '';
  return `${teamBlock}${header}\n${message}\n\n${workerReminder}`;
}
