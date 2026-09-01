import React from 'react';

export interface ParsedAgentTask {
  num: number;
  status: 'working' | 'pending' | 'completed' | 'blocked';
  text: string;
}

/**
 * Phân tích danh sách task từ agent:
 * - Ưu tiên mảng ag.tasks từ backend (nếu có)
 * - Fallback phân tích chuỗi ag.task (tách dòng, bỏ dòng completed rác nếu cần)
 */
export function parseAgentTaskList(ag?: {
  task?: string;
  tasks?: Array<{ id?: string; task: string; status: string }>;
  status?: string;
}): ParsedAgentTask[] {
  if (!ag) return [];
  const result: ParsedAgentTask[] = [];

  // 1. Kiểm tra ag.tasks mảng cấu trúc từ server
  if (Array.isArray(ag.tasks) && ag.tasks.length > 0) {
    (ag.tasks || []).forEach((t, idx) => {
      if (!t) return;
      let st: 'working' | 'pending' | 'completed' | 'blocked' = 'pending';
      const rawSt = String(t.status || '').toLowerCase();
      if (rawSt === 'working' || rawSt === 'in_progress') st = 'working';
      else if (rawSt === 'completed' || rawSt === 'done' || rawSt === 'passed') st = 'completed';
      else if (rawSt === 'blocked' || rawSt === 'error' || rawSt === 'failed') st = 'blocked';
      else st = 'pending';

      const clean = String(t.task || '').replace(/^#\d+\s*/, '').trim();
      if (clean) {
        result.push({
          num: idx + 1,
          status: st,
          text: clean
        });
      }
    });
    if (result.length > 0) return result;
  }

  // 2. Fallback phân tích chuỗi ag.task
  if (ag.task && typeof ag.task === 'string' && ag.task.trim()) {
    const lines = ag.task.split(/\r?\n/).map(l => (l || '').trim()).filter(Boolean);
    let count = 1;

    for (const l of lines) {
      if (!l) continue;
      let status: 'working' | 'pending' | 'completed' | 'blocked' = (ag.status === 'working' ? 'working' : 'pending');
      let cleanText = l;

      if (/^\[x\]/i.test(l) || /\b(?:completed|done|passed|đã xong|hoàn tất)\b/i.test(l)) {
        status = 'completed';
        cleanText = l.replace(/^\[x\]\s*/i, '').replace(/\b\((?:completed|done|passed|đã xong|hoàn tất)\)\s*/i, '');
      } else if (/^\[\~\]/i.test(l) || /^\[\>\]/i.test(l) || /\b(?:working|in_progress|in progress|đang làm|đang xử lý)\b/i.test(l)) {
        status = 'working';
        cleanText = l.replace(/^\[[\~>]\]\s*/i, '').replace(/\b\((?:working|in_progress|in progress|đang làm)\)\s*/i, '');
      } else if (/^\[\!\]/i.test(l) || /\b(?:blocked|error|failed|lỗi|bị chặn)\b/i.test(l)) {
        status = 'blocked';
        cleanText = l.replace(/^\[\!\]\s*/i, '').replace(/\b\((?:blocked|error|failed|lỗi)\)\s*/i, '');
      } else if (/^\[\s*\]/i.test(l) || /\b(?:pending|chờ|todo)\b/i.test(l)) {
        status = 'pending';
        cleanText = l.replace(/^\[\s*\]\s*/i, '').replace(/\b\((?:pending|chờ|todo)\)\s*/i, '');
      }

      cleanText = cleanText.replace(/^[-*•\d+.)#]\s*/, '').replace(/^#\d+\s*/, '').trim();
      if (cleanText) {
        result.push({
          num: count++,
          status,
          text: cleanText
        });
      }
    }
  }

  return result;
}

export function renderAgentTaskList(tasks?: ParsedAgentTask[]): React.ReactNode {
  if (!Array.isArray(tasks) || tasks.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {(tasks || []).map((t) => {
        if (!t) return null;
        const isComp = t.status === 'completed';
        const isWork = t.status === 'working';
        const isBlk = t.status === 'blocked';

        const tIcon = isComp ? '✅' : isWork ? '⚙️' : isBlk ? '⚠️' : '⏳';
        const tColor = isComp ? '#6ee7b7' : isWork ? '#93c5fd' : isBlk ? '#fca5a5' : '#94a3b8';
        const tBg = isWork ? 'rgba(59, 130, 246, 0.12)' : isComp ? 'rgba(16, 185, 129, 0.08)' : 'rgba(255, 255, 255, 0.03)';

        return (
          <div
            key={t.num}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 6,
              fontSize: 11.5,
              background: tBg,
              padding: '4px 7px',
              borderRadius: 5,
              border: '1px solid var(--af-border)'
            }}
          >
            <span style={{ fontSize: 11, flexShrink: 0, marginTop: 1 }}>{tIcon}</span>
            <span style={{ color: tColor, fontWeight: 700, fontSize: 10, textTransform: 'uppercase', flexShrink: 0, marginTop: 1 }}>
              #{t.num} [{t.status}]:
            </span>
            <span
              style={{
                color: 'var(--text-primary)',
                lineHeight: 1.4,
                wordBreak: 'break-word',
                flex: 1,
                textDecoration: isComp ? 'line-through' : 'none',
                opacity: isComp ? 0.7 : 1
              }}
            >
              {t.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}