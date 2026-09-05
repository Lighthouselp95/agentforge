// ============ TEAM TABLE GUARD (chống rò rỉ [TEAM] table vào queue/replay) ============
// Khối [TEAM]...[/TEAM] + dòng `Your ID:` / `Active Team:` là system context do server
// tự build live (buildTeam) — KHÔNG phải nội dung user. Nếu lọt vào backendUserQueues /
// unprocessed disk / outbox, restart sẽ replay team table stale như tin nhắn thật.
// Mọi điểm enqueue/persist/replay PHẢI lọc qua 2 hàm dưới.

/** true nếu text là (hoặc chứa) team table context, không phải nội dung user thật. */
export function isTeamTableMessage(text: any): boolean {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;
  if (t.startsWith('[TEAM]')) return true;
  // Fingerprint buildTeam(): cặp marker Your ID: agent- + Active Team: trong cùng message
  if (t.includes('Your ID: agent-') && t.includes('Active Team:')) return true;
  return false;
}

/**
 * Lột bỏ khối [TEAM]...[/TEAM] và các dòng fingerprint buildTeam khỏi text.
 * Trả về phần nội dung user còn lại (trim). Trả '' nếu chỉ toàn team table.
 */
export function stripTeamTableContent(text: any): string {
  if (typeof text !== 'string') return '';
  let out = text;
  // Bỏ khối [TEAM] ... [/TEAM] (dot-all, nhiều khối)
  out = out.replace(/\[TEAM\][\s\S]*?\[\/TEAM\]/g, '');
  // Bỏ các dòng fingerprint buildTeam (Your ID/name/role/task/tasks/Partner, Active Team, Members)
  // và các dòng member dạng `  - name (role) [status]... | ID: xxx`
  const lines = out.split(/\r?\n/);
  const kept = lines.filter(ln => {
    const t = ln.trim();
    if (/^(Your (ID|name|role|task|tasks|Partner):|Active Team:|Members:)/.test(t)) return false;
    if (/^\s*-\s+.+\|\s*ID:\s*\S+/.test(ln)) return false;
    return true;
  });
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function resolveTeamIdForMsg(msg: any, getAgent?: (id: string) => any, getAllAgents?: () => any[], contextTeamId?: string): string {
  if (msg && msg.teamId && typeof msg.teamId === 'string') return msg.teamId;
  const candidates = [msg && msg.from, msg && msg.to];
  for (const cid of candidates) {
    if (!cid || typeof cid !== 'string' || cid === 'user' || cid === 'broadcast') continue;
    if (getAgent) {
      const ag = getAgent(cid);
      if (ag && ag.teamId && typeof ag.teamId === 'string') return ag.teamId;
    }
    if (cid === 'orchestrator' && getAllAgents) {
      const all = getAllAgents();
      const defaultOrch = all.find(a => (a.role === 'orchestrator' || a.id === 'orchestrator') && a.teamId);
      if (defaultOrch && defaultOrch.teamId) return defaultOrch.teamId;
    }
  }
  // system→user (hoặc system→*): không còn manh mối agent → dùng contextTeamId của caller
  // thay vì trả 'default' bừa (tránh relay notice sai team). Không có context → throw TEAM_ORCH_NOT_FOUND.
  if (typeof contextTeamId === 'string' && contextTeamId) return contextTeamId;
  const err: any = new Error(`TEAM_ORCH_NOT_FOUND: Không thể xác định teamId cho tin nhắn (from: ${msg?.from}, to: ${msg?.to})`);
  err.code = 'TEAM_ORCH_NOT_FOUND';
  throw err;
}
