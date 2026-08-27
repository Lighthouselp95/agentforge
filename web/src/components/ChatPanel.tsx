import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, Component } from 'react';
// Queue bar animation keyframes (injected once)
if (typeof document !== 'undefined' && !document.getElementById('af-queue-style')) {
  const st = document.createElement('style');
  st.id = 'af-queue-style';
  st.textContent = `@keyframes af-queue-slide{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}`;
  document.head.appendChild(st);
}

interface Message {
  id: string;
  agentId?: string;
  role?: string;
  content: string;
  timestamp?: number | string;
}

interface ChatMsg {
  id: string;
  from: string;
  to?: string;
  content: string;
  timestamp?: number | string;
  agentName?: string;
  agentRole?: string;
  msgType?: string;
  // Toolcall cấu trúc từ event gốc opencode (backend gửi kèm trong payload)
  toolCalls?: Array<{ tool: string; input?: string; output?: string }>;
  thinking?: string;
}

interface AgentInfo {
  id: string;
  name: string;
  role?: string;
}

function stripTalkTags(text: string): string {
  if (!text) return '';
  const strText = String(text);
  let result = '';
  let pos = 0;
  const lower = strText.toLowerCase();
  while (pos < text.length) {
    const talkIdx = lower.indexOf('[talk', pos);
    if (talkIdx === -1) {
      result += text.substring(pos);
      break;
    }
    result += text.substring(pos, talkIdx);
    let i = talkIdx + 5; // length of '[talk'
    let inQuotes: string | null = null;
    let foundClose = false;
    while (i < text.length) {
      const char = text[i];
      if (inQuotes) {
        if (char === inQuotes && text[i - 1] !== '\\') {
          inQuotes = null;
        }
      } else {
        if (char === '"' || char === "'") {
          inQuotes = char;
        } else if (char === ']') {
          foundClose = true;
          break;
        }
      }
      i++;
    }
    if (foundClose) {
      pos = i + 1;
    } else {
      const fallbackMatch = text.substring(talkIdx).match(/^\[talk[\s\S]*?\]/i);
      if (fallbackMatch) {
        pos = talkIdx + fallbackMatch[0].length;
      } else {
        result += text.substring(talkIdx, talkIdx + 5);
        pos = talkIdx + 5;
      }
    }
  }
  return result.replace(/^\s+/, '').replace(/\n{3,}/g, '\n\n').trim();
}

function formatTimestamp(timestamp?: number | string): string {
  if (!timestamp) return '';
  const num = typeof timestamp === 'string' ? (Number(timestamp) || Date.parse(timestamp)) : timestamp;
  if (!num || isNaN(num) || num <= 0) return '';
  const d = new Date(num);
  if (isNaN(d.getTime())) return '';
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function formatFullDate(timestamp?: number | string): string {
  if (!timestamp) return '';
  const num = typeof timestamp === 'string' ? (Number(timestamp) || Date.parse(timestamp)) : timestamp;
  if (!num || isNaN(num) || num <= 0) return '';
  const d = new Date(num);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

// ============ TOOL CALL BLOCK ============
// Hiển thị toolcall của opencode dạng ô riêng biệt: badge tên tool + Collapse/Expand.
// Nguồn dữ liệu là PROP CÓ CẤU TRÚC (message.toolCalls), KHÔNG dò chuỗi trong content.
export interface ToolCallData {
  tool: string;
  input?: string;
  output?: string;
}

// Làm sạch mã ANSI escape rác từ output terminal (VD: [2m, [32m, ô vuông...)
function stripAnsi(text: any): string {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

// Parse input của toolcall thành object (input có thể là chuỗi JSON hoặc object sẵn)
function parseToolInputObject(input: string | undefined | null): Record<string, any> | null {
  if (input === undefined || input === null) return null;
  if (typeof input === 'object') return input as Record<string, any>;
  if (typeof input !== 'string') return null;
  try {
    const p = JSON.parse(input);
    return p && typeof p === 'object' ? (p as Record<string, any>) : null;
  } catch {
    return null;
  }
}

// Một dòng diff kiểu git: KHÔNG dùng tiền tố +/- — chỉ phân biệt bằng nền đỏ/xanh + viền trái,
// giữ nguyên thụt lề gốc của code.
function DiffLine({ sign, text }: { sign: '-' | '+'; text: string }) {
  const isRemove = sign === '-';
  return (
    <div style={{
      background: isRemove ? 'rgba(239, 68, 68, 0.14)' : 'rgba(34, 197, 94, 0.14)',
      color: isRemove ? '#fca5a5' : '#86efac',
      borderLeft: isRemove ? '3px solid #ef4444' : '3px solid #22c55e',
      padding: '1px 8px',
      fontFamily: 'monospace',
      fontSize: 12,
      lineHeight: 1.55,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word'
    }}>
      {text || ' '}
    </div>
  );
}

// Dòng ngữ cảnh giống nhau giữa old/new — xám nhạt, không bôi nền
function ContextLine({ text }: { text: string }) {
  return (
    <div style={{
      color: '#94a3b8',
      borderLeft: '3px solid transparent',
      padding: '1px 8px',
      fontFamily: 'monospace',
      fontSize: 12,
      lineHeight: 1.55,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word'
    }}>
      {text || ' '}
    </div>
  );
}

// CONTEXT-AWARE DIFF: so khớp LCS theo dòng — chỉ tô đỏ/xanh dòng THẬT SỰ khác nhau,
// các dòng giống nhau hiển thị xám làm ngữ cảnh (giống GitHub).
function computeDiffRows(oldStr: string, newStr: string): Array<{ type: 'ctx' | 'del' | 'add'; text: string }> {
  const a = oldStr.split('\n');
  const b = newStr.split('\n');
  // Guard file quá lớn: LCS O(n*m) tốn bộ nhớ — fallback render cũ (đỏ rồi xanh)
  if (a.length * b.length > 640000) {
    return [
      ...a.map(t => ({ type: 'del' as const, text: t })),
      ...b.map(t => ({ type: 'add' as const, text: t }))
    ];
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: Array<{ type: 'ctx' | 'del' | 'add'; text: string }> = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ type: 'ctx', text: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: 'del', text: a[i] });
      i++;
    } else {
      rows.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < a.length) rows.push({ type: 'del', text: a[i++] });
  while (j < b.length) rows.push({ type: 'add', text: b[j++] });
  return rows;
}

// ============ ANSI COLOR RENDERER ============
// Gỡ CSI điều khiển không phải màu; giữ SGR (...m) để tô màu như terminal thật.
const ANSI_NOISE_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-NPRZcf-nqry=><]/g;
const ANSI_SGR_SPLIT = /((?:\u001b\[|\u009b\[|\[)\d{1,3}(?:;\d{1,3}){0,8}m)/g;

function ansiApplyCode(code: number, style: React.CSSProperties): React.CSSProperties {
  const s = { ...style };
  switch (code) {
    case 0: return {};
    case 1: s.fontWeight = 'bold'; break;
    case 2: s.opacity = 0.6; break;
    case 22: delete s.fontWeight; delete s.opacity; break;
    case 39: delete s.color; break;
    case 30: case 90: s.color = '#94a3b8'; break;
    case 31: case 91: s.color = '#f87171'; break;
    case 32: case 92: s.color = '#4ade80'; break;
    case 33: case 93: s.color = '#facc15'; break;
    case 34: case 94: s.color = '#60a5fa'; break;
    case 35: case 95: s.color = '#c084fc'; break;
    case 36: case 96: s.color = '#38bdf8'; break;
    case 37: s.color = '#e2e8f0'; break;
    default: break;
  }
  return s;
}

function AnsiRenderer({ text }: { text: string }) {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.replace(ANSI_NOISE_RE, '');
  const tokens = cleaned.split(ANSI_SGR_SPLIT).filter(p => p !== '');
  let style: React.CSSProperties | undefined;
  const out: React.ReactNode[] = [];
  for (const p of tokens) {
    const m = p.match(/^(?:\u001b\[|\u009b\[|\[)(\d{1,3}(?:;\d{1,3}){0,8})m$/);
    if (m) {
      let cur: React.CSSProperties = style || {};
      for (const c of m[1].split(';')) {
        cur = ansiApplyCode(parseInt(c || '0', 10), cur);
      }
      style = Object.keys(cur).length ? cur : undefined;
      continue;
    }
    out.push(style ? <span key={out.length} style={style}>{p}</span> : <span key={out.length}>{p}</span>);
  }
  if (out.length === 0) return null;
  return <>{out}</>;
}

// ============ READ FILE VIEWER ============
// Hiển thị kết quả tool read dạng khung file đẹp: bỏ XML thô (<path>/<content>), có header đường dẫn.
function ReadFileViewer({ input, output }: { input?: string; output?: string }) {
  const rawOut = typeof output === 'string' ? stripAnsi(output) : '';
  const rawInp = typeof input === 'string' ? stripAnsi(input) : '';

  // 1) filePath: ưu tiên thẻ <path>, rồi đến input chuỗi trần / JSON {filePath}
  let filePath = '';
  const pm = rawOut.match(/<path>([\s\S]*?)<\/path>/i) || rawInp.match(/<path>([\s\S]*?)<\/path>/i);
  if (pm) {
    filePath = pm[1].trim();
  } else if (rawInp && !rawInp.startsWith('{') && !rawInp.includes('\n')) {
    filePath = rawInp.trim();
  } else {
    try {
      const j = JSON.parse(rawInp);
      if (j && typeof j.filePath === 'string') filePath = j.filePath;
      else if (j && typeof j.path === 'string') filePath = j.path;
    } catch {}
  }

  // 2) Nội dung code nằm giữa <content>...</content> (hoặc toàn bộ phần sau nếu thiếu thẻ đóng)
  const cm = rawOut.match(/<content>([\s\S]*?)<\/content>/i) || rawOut.match(/<content>([\s\S]*)$/i);
  const code = cm ? cm[1].replace(/^\r?\n/, '').replace(/\s+$/, '') : '';

  // 3) Dòng ghi chú cuối "(Showing lines ...)"
  const nm = rawOut.match(/\((Showing lines[\s\S]*?)\)/i);
  const note = nm ? nm[1].trim() : '';

  return (
    <div
      className="af-toolblock"
      style={{
      display: 'block',
      width: '100%',
      boxSizing: 'border-box',
      borderRadius: 10,
      border: '1px solid var(--af-border)',
      background: 'var(--bg-inset)',
      overflow: 'hidden',
      marginBottom: 4
    }}>
      {/* Header: 📁 filePath */}
      <div style={{
        padding: '5px 10px',
        background: 'var(--bg-panel)',
        borderBottom: '1px solid var(--af-border)',
        fontSize: 12,
        fontFamily: 'monospace',
        color: 'var(--text-muted)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }}>
        📁 {filePath || 'file'}
      </div>
      {/* Khung code nền tối, scroll tối đa 300px */}
      <div style={{
        maxHeight: 300,
        overflowY: 'auto',
        width: '100%',
        background: '#0d1117'
      }}>
        <pre style={{
          margin: 0,
          padding: '8px 10px',
          fontFamily: 'monospace',
          fontSize: 12,
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: '#c9d1d9'
        }}>
          {code || rawOut || '(empty)'}
        </pre>
      </div>
      {/* Dòng tóm tắt chân khung */}
      {note && (
        <div style={{ padding: '4px 10px 6px', fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
          {note}
        </div>
      )}
    </div>
  );
}

// ============ BASH COMMAND VIEWER ============
// Hiển thị tool bash dạng terminal: dòng prompt "$ command" + output giữ màu ANSI.
function BashCommandViewer({ input, output }: { input?: string; output?: string }) {
  let command = '';
  const obj = parseToolInputObject(input);
  if (obj) {
    if (typeof obj.command === 'string') command = obj.command;
    else if (typeof obj.cmd === 'string') command = obj.cmd;
  }
  if (!command && typeof input === 'string' && input.trim()) {
    command = input.trim();
  }
  const outText = typeof output === 'string' ? output : '';

  return (
    <div
      className="af-toolblock"
      style={{
      display: 'block',
      width: '100%',
      boxSizing: 'border-box',
      borderRadius: 10,
      border: '1px solid var(--af-border)',
      background: 'var(--bg-inset)',
      overflow: 'hidden',
      marginBottom: 4
    }}>
      <div style={{ padding: '8px 10px' }}>
        {/* Prompt line: $ command */}
        <div style={{
          color: '#38bdf8',
          fontWeight: 600,
          fontFamily: 'monospace',
          fontSize: 12,
          marginBottom: outText ? 8 : 0,
          wordBreak: 'break-all'
        }}>
          $ {command}
        </div>
        {/* Output: giữ màu ANSI, scroll tối đa 280px */}
        {outText && (
          <div style={{
            maxHeight: 280,
            overflowY: 'auto',
            width: '100%',
            fontFamily: 'monospace',
            fontSize: 12,
            lineHeight: 1.55
          }}>
            <AnsiRenderer text={outText} />
          </div>
        )}
      </div>
    </div>
  );
}

// ============ SEARCH COMMAND VIEWER (glob / grep / searcher) ============
// GitHub-style: header 🔍 TOOL pattern + danh sách kết quả tách số dòng/nội dung gọn gàng.
function SearchCommandViewer({ tool, input, output }: { tool: string; input?: string; output?: string }) {
  const rawInp = typeof input === 'string' ? stripAnsi(input) : '';
  const rawOut = typeof output === 'string' ? output : '';

  // Parse pattern / path / include từ input JSON (hoặc chuỗi trần làm pattern)
  let pattern = '', sPath = '', include = '';
  const obj = parseToolInputObject(rawInp);
  if (obj) {
    if (typeof obj.pattern === 'string') pattern = obj.pattern;
    else if (typeof obj.query === 'string') pattern = obj.query;
    if (typeof obj.path === 'string') sPath = obj.path;
    if (typeof obj.include === 'string') include = obj.include;
  }
  if (!pattern && rawInp.trim()) pattern = rawInp.trim();

  const rows = rawOut.split(/\r?\n/)
    .map(l => l.replace(ANSI_NOISE_RE, '').replace(/[\u001b\u009b]/g, ''))
    .filter(l => l.trim() !== '');

  return (
    <div
      className="af-toolblock"
      style={{
      display: 'block',
      width: '100%',
      boxSizing: 'border-box',
      borderRadius: 10,
      border: '1px solid var(--af-border)',
      background: 'var(--bg-inset)',
      overflow: 'hidden',
      marginBottom: 4
    }}>
      {/* Header: 🔍 TOOL pattern: "..." in path */}
      <div style={{
        padding: '6px 10px',
        background: 'var(--bg-panel)',
        borderBottom: '1px solid var(--af-border)',
        color: '#38bdf8',
        fontWeight: 600,
        fontFamily: 'monospace',
        fontSize: 12,
        wordBreak: 'break-all'
      }}>
        🔍 {String(tool).toUpperCase()}{pattern ? ` pattern: "${pattern}"` : ''}{sPath ? ` in ${sPath}` : ''}{include ? ` · ${include}` : ''}
      </div>
      {/* Danh sách kết quả — nền tối GitHub, scroll 280px */}
      <div style={{
        maxHeight: 280,
        overflowY: 'auto',
        width: '100%',
        background: '#0d1117'
      }}>
        {rows.length === 0 ? (
          <div style={{ padding: '8px 10px', fontFamily: 'monospace', fontSize: 12, color: '#8b949e' }}>(no results)</div>
        ) : rows.map((l, i) => {
          // grep -n style: "path/file.tsx:580:nội dung"
          const fm = l.match(/^([^\s:]+\.[A-Za-z0-9]{1,6}):(\d+):(.*)$/);
          if (fm) {
            return (
              <div key={i} style={{ display:'flex', gap:8, padding:'1px 10px', fontFamily:'monospace', fontSize:12, lineHeight:1.55 }}>
                <span style={{ color:'#8b949e', flexShrink:0 }}>📄 {fm[1]}</span>
                <span style={{ color:'#8b949e', flexShrink:0, minWidth:44, textAlign:'right' }}>{fm[2]}</span>
                <span style={{ color:'#c9d1d9', whiteSpace:'pre-wrap', wordBreak:'break-word' }}>{fm[3]}</span>
              </div>
            );
          }
          // dòng có số thứ tự: "Line 580:" hoặc "580:"
          const lm = l.match(/^(?:Line\s*)?(\d+)\s*[:：]\s*([\s\S]*)$/i);
          if (lm) {
            return (
              <div key={i} style={{ display:'flex', gap:8, padding:'1px 10px', fontFamily:'monospace', fontSize:12, lineHeight:1.55 }}>
                <span style={{ color:'#8b949e', flexShrink:0, minWidth:36, textAlign:'right' }}>{lm[1]}</span>
                <span style={{ color:'#c9d1d9', whiteSpace:'pre-wrap', wordBreak:'break-word' }}>{lm[2]}</span>
              </div>
            );
          }
          // đường dẫn file / thư mục trần
          const isFile = /\.[A-Za-z0-9]{1,6}$/.test(l.trim()) && !l.includes(' ');
          return (
            <div key={i} style={{ padding:'1px 10px', fontFamily:'monospace', fontSize:12, lineHeight:1.55, color:'#c9d1d9' }}>
              {isFile ? `📄 ${l.trim()}` : (/\.[A-Za-z0-9]{1,6}/.test(l) || l.includes('/') || l.includes('\\') ? `📁 ${l.trim()}` : l)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============ TOOL BLOCK SAFE BOUNDARY ============
// Fallback an toàn: nếu parse/render một ToolCallBlock lỗi, chỉ khối đó sập thành text mờ,
// không làm trắng toàn bộ panel chat.
class ToolBlockSafe extends Component<{ children: React.ReactNode }, { hasError: boolean }> {
  public state = { hasError: false };
  public static getDerivedStateFromError() {
    return { hasError: true };
  }
  public componentDidCatch(error: unknown) {
    console.error('[ToolBlockSafe] render error:', error);
  }
  public render() {
    if (this.state.hasError) {
      return (
        <div style={{
          borderRadius: 10,
          border: '1px dashed rgba(148,163,184,0.35)',
          background: 'var(--bg-inset)',
          padding: '8px 10px',
          fontFamily: 'monospace',
          fontSize: 12,
          color: 'var(--text-muted)',
          marginBottom: 4
        }}>
          ⚠️ Tool call data lỗi định dạng — không thể hiển thị chi tiết.
        </div>
      );
    }
    return this.props.children;
  }
}

// ============ TODO CHECKLIST VIEWER ============
// Format output cua tool todowrite/todoread thanh danh sach checklist dep mat
// thay vi in mang JSON tho. Parse duoc ca shape: mang truc tiep, {todos:[...]},
// hoac object bat ky chua mang o field dau tien.
function parseTodosFrom(raw?: string): any[] {
  if (!raw || !raw.trim()) return [];
  const tryParse = (s: string): any => { try { return JSON.parse(s); } catch { return undefined; } };
  let v = tryParse(raw);
  if (v === undefined) {
    // Output co the kem text bao quanh -> tim doan JSON dau tien [..] hoac {..}
    const start = raw.search(/[[{]/);
    const endBrk = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'));
    if (start >= 0 && endBrk > start) v = tryParse(raw.slice(start, endBrk + 1));
  }
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    if (Array.isArray((v as any).todos)) return (v as any).todos;
    for (const k of Object.keys(v as any)) {
      const inner = (v as any)[k];
      if (Array.isArray(inner)) return inner;
    }
  }
  return [];
}

const TODO_STATUS_ICON: Record<string, string> = {
  in_progress: '🟡',
  completed: '✅',
  pending: '⬜'
};

const TODO_PRIORITY_BADGE: Record<string, React.CSSProperties> = {
  high: { background: 'rgba(239,68,68,0.15)', color: '#f87171', border: '1px solid rgba(239,68,68,0.4)' },
  medium: { background: 'rgba(250,204,21,0.12)', color: '#facc15', border: '1px solid rgba(250,204,21,0.4)' },
  low: { background: 'rgba(148,163,184,0.12)', color: '#94a3b8', border: '1px solid rgba(148,163,184,0.35)' }
};

function TodoListViewer({ input, output }: { input?: string; output?: string }) {
  let todos = parseTodosFrom(output);
  if (todos.length === 0) todos = parseTodosFrom(input);
  return (
    <div style={{
      width: '100%', boxSizing: 'border-box', borderRadius: 10,
      border: '1px solid var(--af-border)', background: '#0d1117',
      overflow: 'hidden', margin: '4px 0'
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 10px', background: 'var(--bg-panel)',
        borderBottom: '1px solid var(--af-border)',
        fontSize: 11, fontWeight: 700, color: '#a5b4fc'
      }}>
        📋 Task Checklist ({todos.length} tasks)
      </div>
      {/* Danh sach todo */}
      <div style={{
        maxHeight: 280, overflowY: 'auto', width: '100%',
        padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 6
      }}>
        {todos.length === 0 && (
          <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'monospace', padding: '2px 4px' }}>
            (không parse được danh sách todo từ dữ liệu tool)
          </div>
        )}
        {todos.map((t: any, i: number) => {
          const status = String(t?.status || 'pending').toLowerCase();
          const icon = TODO_STATUS_ICON[status] || '⬜';
          const pr = String(t?.priority || '').toLowerCase();
          const badge = TODO_PRIORITY_BADGE[pr];
          const label = String(t?.content ?? t?.task ?? t?.title ?? '');
          return (
            <div key={i} style={{
              display: 'flex', alignItems: 'flex-start', gap: 8,
              padding: '5px 8px', borderRadius: 8,
              background: 'rgba(148,163,184,0.06)',
              border: '1px solid rgba(148,163,184,0.12)'
            }}>
              <span style={{ fontSize: 13, lineHeight: '17px', flexShrink: 0 }}>{icon}</span>
              <span style={{
                flex: 1, fontSize: 12, color: '#e2e8f0', lineHeight: '17px',
                textDecoration: status === 'completed' ? 'line-through' : 'none',
                opacity: status === 'completed' ? 0.72 : 1,
                wordBreak: 'break-word'
              }}>
                {label || JSON.stringify(t)}
              </span>
              {badge && (
                <span style={{
                  ...badge, fontSize: 9, fontWeight: 700, borderRadius: 9999,
                  padding: '1px 7px', fontFamily: 'monospace',
                  textTransform: 'uppercase', flexShrink: 0, lineHeight: '14px'
                }}>
                  {pr}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ToolCallBlock({ tool, input, output }: ToolCallData) {
  // FIX CRASH toLowerCase: tool có thể undefined khi payload lỗi → bọc an toàn 100%
  const safeTool = String(tool || 'unknown').toLowerCase();
  // Input: strip toàn bộ (dùng để parse JSON diff). Output: GIỮ mã màu SGR cho AnsiRenderer
  const safeInput = stripAnsi(input || '');
  const rawOutput = typeof output === 'string' ? output : '';

  // TodoListViewer cho tool todowrite/todoread — checklist đẹp thay vì JSON thô
  if (safeTool.includes('todo')) {
    return <TodoListViewer input={safeInput} output={rawOutput} />;
  }

  const content = [
    safeInput ? `▶ input:\n${safeInput}` : '',
    rawOutput ? `◀ output:\n${rawOutput}` : ''
  ].filter(Boolean).join('\n\n');
  const lineCount = Math.max(1, content.split('\n').length);

  // Git-style diff cho tool edit: parse input lấy {filePath, oldString, newString}
  const parsedInput = parseToolInputObject(safeInput);
  const isEditDiff =
    safeTool === 'edit' ||
    !!(parsedInput && ('oldString' in parsedInput || 'newString' in parsedInput));

  // ReadFileViewer cho tool read (hoặc output chứa khối <content>)
  const isReadView = safeTool === 'read' || /<content>/i.test(rawOutput);

  // BashCommandViewer cho tool bash/shell — dạng terminal $ command + output màu
  const isBashView = safeTool === 'bash' || safeTool === 'shell';

  // SearchCommandViewer cho glob/grep/searcher — GitHub-style kết quả tìm kiếm
  const isSearchView = safeTool === 'glob' || safeTool === 'grep' || safeTool === 'searcher';
  const oldLines: string[] =
    isEditDiff && parsedInput && typeof parsedInput.oldString === 'string' && parsedInput.oldString !== ''
      ? parsedInput.oldString.split('\n')
      : [];
  const newLines: string[] =
    isEditDiff && parsedInput && typeof parsedInput.newString === 'string' && parsedInput.newString !== ''
      ? parsedInput.newString.split('\n')
      : [];

  // Mặc định COLLAPSE (thu gọn 1 dòng) — user bấm Expand để xem chi tiết
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="af-toolblock"
      style={{
      display: 'block',
      width: '100%',
      boxSizing: 'border-box',
      borderRadius: 10,
      border: '1px solid var(--af-border)',
      background: 'var(--bg-inset)',
      overflow: 'hidden',
      margin: '4px 0'
    }}>
      {/* Header: badge tên tool + nút thu gọn/mở rộng */}
      <div
        className="af-toolblock-head"
        style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '5px 10px',
        background: 'var(--bg-panel)',
        borderBottom: expanded ? '1px solid var(--af-border)' : 'none',
        position: 'sticky',
        top: 0
      }}>
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          fontSize: 10,
          fontWeight: 700,
          color: '#93c5fd',
          background: 'rgba(59,130,246,0.12)',
          border: '1px solid rgba(59,130,246,0.3)',
          borderRadius: 9999,
          padding: '1px 8px',
          fontFamily: 'monospace',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}>
          🔧 {String(tool || 'unknown')}
        </span>
        <button
          onClick={() => setExpanded(e => !e)}
          style={{
            background: 'rgba(148,163,184,0.1)',
            border: '1px solid rgba(148,163,184,0.25)',
            color: '#cbd5e1',
            borderRadius: 4,
            padding: '1px 8px',
            fontSize: 10,
            cursor: 'pointer',
            fontFamily: 'monospace',
            flexShrink: 0
          }}
        >
          {expanded ? 'Collapse' : `Expand (${lineCount} dòng)`}
        </button>
      </div>
      {/* Body: monospace 12px, scroll tối đa 280px khi mở */}
      {expanded && (
        <div
          className="af-toolblock-body"
          style={{
          maxHeight: 280,
          overflowY: 'auto',
          width: '100%',
          padding: '8px 10px',
          fontFamily: 'monospace',
          fontSize: 12,
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: 'var(--text-secondary)'
        }}>
          {isEditDiff && parsedInput && ((oldLines.length > 0 || newLines.length > 0) || typeof parsedInput.filePath === 'string') ? (
            /* GIT-STYLE DIFF VIEW (context-aware) — chốt cứng maxHeight 300 + scroll */
            <div style={{ maxHeight: 300, overflowY: 'auto', width: '100%' }}>
              {typeof parsedInput.filePath === 'string' && parsedInput.filePath !== '' && (
                <div style={{ padding: '4px 8px 6px', color: '#94a3b8', fontFamily: 'monospace', fontSize: 12 }}>
                  📁 {parsedInput.filePath}
                </div>
              )}
              {computeDiffRows(
                oldLines.join('\n'),
                newLines.join('\n')
              ).map((row, i) =>
                row.type === 'ctx'
                  ? <ContextLine key={`c${i}`} text={row.text} />
                  : <DiffLine key={`d${i}`} sign={row.type === 'del' ? '-' : '+'} text={row.text} />
              )}
            </div>
          ) : isReadView ? (
            /* READ FILE VIEWER — khung file đẹp thay XML thô */
            <ReadFileViewer input={safeInput} output={rawOutput} />
          ) : isBashView ? (
            /* BASH COMMAND VIEWER — $ command + output màu ANSI */
            <BashCommandViewer input={safeInput} output={rawOutput} />
          ) : isSearchView ? (
            /* SEARCH COMMAND VIEWER — GitHub-style cho glob/grep/searcher */
            <SearchCommandViewer tool={tool} input={safeInput} output={rawOutput} />
          ) : (
            content ? <AnsiRenderer text={content} /> : '(empty)'
          )}
        </div>
      )}
    </div>
  );
}

// ============ THINKING BLOCK ============
// Hiển thị suy luận nội tại của model: mặc định thu gọn, viền mảnh, nền mờ hơn bubble.
function ThinkingBlock({ thinking }: { thinking: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="af-thinking"
      style={{
      display: 'block',
      width: '100%',
      boxSizing: 'border-box',
      borderRadius: 10,
      border: '1px solid rgba(148,163,184,0.18)',
      background: 'var(--bg-inset)',
      overflow: 'hidden',
      marginBottom: 6
    }}>
      {/* Header: 💭 Thinking + toggle */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '5px 10px'
      }}>
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          color: '#94a3b8',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5
        }}>
          💭 Thinking
        </span>
        <button
          onClick={() => setExpanded(e => !e)}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--text-muted)',
            padding: 0,
            fontSize: 10,
            cursor: 'pointer',
            fontFamily: 'monospace',
            flexShrink: 0
          }}
        >
          {expanded ? '[▲] Collapse' : '[▼] Expand'}
        </button>
      </div>
      {/* Nội dung: xám #94a3b8, italic 12px, scroll tối đa 220px */}
      {expanded && (
        <div style={{
          maxHeight: 220,
          overflowY: 'auto',
          width: '100%',
          padding: '8px 10px',
          borderTop: '1px solid rgba(148,163,184,0.12)',
          color: '#94a3b8',
          fontSize: 12,
          fontStyle: 'italic',
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word'
        }}>
          {thinking}
        </div>
      )}
    </div>
  );
}

function formatTokens(tokens?: number): string {
  if (tokens === undefined || tokens === null || tokens < 0) return '0';
  if (tokens === 0) return '0';
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`;
  }
  return tokens.toLocaleString();
}

function formatCost(cost?: number): string {
  if (!cost || cost <= 0) return '';
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  return `$${cost.toFixed(2)}`;
}

export interface TokenUsageDetail {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  cost?: number;
  contextLength?: number;
  input?: number;
  output?: number;
  total?: number;
  contextLimit?: number;
}

// ============ MEMOIZED MESSAGE ITEM ============
// Bọc React.memo để khi có tin nhắn mới stream tới, chỉ tin nhắn mới được re-render,
// toàn bộ danh sách cũ giữ nguyên DOM (props msg/agents/isCollapsed/onToggleReport đều ổn định tham chiếu).
interface MessageItemProps {
  msg: any;
  agents: AgentInfo[];
  isCollapsed: boolean;
  onToggleReport: (msgId: string) => void;
  isMobile?: boolean;
  showToolBlocks?: boolean;
}

const MessageItem = React.memo(function MessageItem({ msg, agents, isCollapsed, onToggleReport, isMobile = false, showToolBlocks = true }: MessageItemProps) {
  const isUser = msg.from === 'user' || (!msg.from && msg.role === 'user' && !msg.agentId);
  const isOrchestrator = msg.from === 'orchestrator';
  const isError = msg.msgType === 'error' || msg.from === 'error' || (typeof msg.content === 'string' && msg.content.startsWith('❌ Error'));
  const isOpenCode = msg.msgType === 'opencode';
  const isQueued = typeof msg.content === 'string' && msg.content.startsWith('[QUEUED]');

  let sender = msg.from;
  let senderColor = '#38bdf8';
  let roleBadge = '';

  if (isError) {
    sender = 'System Error';
    senderColor = '#f87171';
  } else if (isOpenCode) {
    sender = '⚡ OpenCode';
    senderColor = '#22d3ee';
    roleBadge = '';
  } else if (isOrchestrator) {
    sender = 'Orchestrator';
    senderColor = '#a5b4fc';
    roleBadge = 'main';
  } else if (isUser) {
    sender = 'You';
    senderColor = '#60a5fa';
  } else if (msg.from === 'system') {
    sender = 'System';
    senderColor = '#f87171';
  } else if (msg.agentName) {
    sender = msg.agentName;
    roleBadge = msg.agentRole || 'agent';
    senderColor = '#34d399';
  } else {
    const srcAgent = agents.find(a => a.id === msg.from || a.name === msg.from);
    if (srcAgent) {
      sender = srcAgent.name;
      roleBadge = srcAgent.role || 'agent';
    } else {
      sender = msg.from;
    }
    senderColor = '#34d399';
  }

  // Parse [TO: xxx] prefix
  const rawContent: string = msg.content || '';
  const toMatch = rawContent.match(/^\s*\[TO:\s*([^\]]+)\]\s*/i);
  const toTag = toMatch ? toMatch[1].trim() : null;
  let body = toMatch ? rawContent.slice(toMatch[0].length) : rawContent;
  body = stripTalkTags(body);
  const effectiveTo = msg.to && msg.to !== 'user' ? msg.to : toTag;

  // Resolve target display
  let displayTo = effectiveTo;
  if (effectiveTo) {
    if (effectiveTo === 'orchestrator') {
      displayTo = 'Orchestrator';
    } else if (effectiveTo === 'user') {
      displayTo = 'You';
    } else {
      const targetAgent = agents.find(a => a?.id === effectiveTo || ((a?.name || '').toLowerCase() === String(effectiveTo).toLowerCase()));
      if (targetAgent) {
        displayTo = targetAgent.name;
      }
    }
  }

  // Visual Bubble Themes — token hóa theo theme (modern minimalist: panel trung tính, viền mảnh)
  let bubbleBg = 'var(--bg-panel)';
  let bubbleBorder = '1px solid var(--af-border)';
  let textColor = 'var(--text-primary)';
  let bubbleShadow = 'var(--shadow-panel)';

  if (isOpenCode) {
    bubbleBg = 'var(--bg-inset)';
    bubbleBorder = '1px solid var(--af-border)';
    textColor = 'var(--text-secondary)';
    bubbleShadow = 'none';
  } else if (isUser) {
    bubbleBg = 'linear-gradient(135deg, var(--accent-strong) 0%, var(--accent) 100%)';
    bubbleBorder = '1px solid transparent';
    textColor = '#ffffff';
    bubbleShadow = '0 3px 12px rgba(37, 99, 235, 0.25)';
  } else if (isOrchestrator) {
    bubbleBg = 'var(--bg-panel)';
    bubbleBorder = '1px solid var(--af-border-strong)';
    textColor = 'var(--text-primary)';
    bubbleShadow = 'none';
  } else if (roleBadge.includes('verif') || roleBadge.includes('test')) {
    bubbleBg = 'var(--bg-panel)';
    bubbleBorder = '1px solid var(--af-border)';
    textColor = 'var(--text-primary)';
    bubbleShadow = 'none';
  } else if (roleBadge.includes('coder') || roleBadge.includes('debug')) {
    bubbleBg = 'var(--bg-panel)';
    bubbleBorder = '1px solid var(--af-border)';
    textColor = 'var(--text-primary)';
    bubbleShadow = 'none';
  } else if (roleBadge.includes('research') || roleBadge.includes('search') || roleBadge.includes('plan')) {
    bubbleBg = 'var(--bg-panel)';
    bubbleBorder = '1px solid var(--af-border)';
    textColor = 'var(--text-primary)';
    bubbleShadow = 'none';
  } else if (isError) {
    bubbleBg = 'rgba(239, 68, 68, 0.10)';
    bubbleBorder = '1px solid rgba(239, 68, 68, 0.35)';
    textColor = '#fca5a5';
    bubbleShadow = 'none';
  } else if (isQueued) {
    bubbleBg = 'rgba(245, 158, 11, 0.10)';
    bubbleBorder = '1px solid rgba(245, 158, 11, 0.35)';
    textColor = '#fef3c7';
  }

  const formattedTime = formatTimestamp(msg.timestamp);
  const fullDateTime = formatFullDate(msg.timestamp);

  // Collapsible structured reports
  const isReport = body.includes('=== TASK REPORT ===') || body.includes('=== ERROR REPORT ===') || body.includes('=== AGENT MESSAGE ===');

  // Tin có toolCalls (hoặc log opencode) — các khối tool/thinking render ĐỘC LẬP ngoài bubble
  const hasToolBlocks = showToolBlocks && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0;

  return (
    <div
      className="fade-in"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start'
      }}
    >
      {/* Sender Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 11,
        color: senderColor,
        marginBottom: 4,
        fontWeight: 600,
        paddingLeft: isUser ? 0 : 4,
        paddingRight: isUser ? 4 : 0,
        flexDirection: isUser ? 'row-reverse' : 'row'
      }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {isOrchestrator && <span>👑</span>}
          {isUser && <span>👤</span>}
          {!isOrchestrator && !isUser && <span>🤖</span>}
          <span>{sender}</span>
        </span>

        {roleBadge && (
          <span style={{
            background: 'var(--accent-soft)',
            padding: '1px 5px',
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 500,
            color: 'var(--text-secondary)'
          }}>
            {roleBadge}
          </span>
        )}

        {displayTo && (
          <span style={{ color: 'var(--text-muted)', fontWeight: 400, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span>→</span>
            <span style={{ color: 'var(--text-muted)' }}>{displayTo}</span>
          </span>
        )}

        {formattedTime && (
          <span
            style={{
              color: 'var(--text-muted)',
              fontSize: 10,
              fontWeight: 400,
              fontFamily: 'monospace'
            }}
            title={fullDateTime}
          >
            {formattedTime}
          </span>
        )}
      </div>

      {/* Khối 1: Thinking (nếu có) — nằm riêng độc lập, NGOÀI bubble */}
      {typeof msg.thinking === 'string' && msg.thinking.trim() && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          maxWidth: isMobile ? '94%' : '85%',
          alignSelf: isUser ? 'flex-end' : 'flex-start',
          marginBottom: 4
        }}>
          <ThinkingBlock thinking={msg.thinking} />
        </div>
      )}

      {/* Khối 2: ToolCallBlocks — các hộp công cụ độc lập, NGOÀI bubble */}
      {showToolBlocks && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0 && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          maxWidth: isMobile ? '94%' : '85%',
          alignSelf: isUser ? 'flex-end' : 'flex-start',
          marginBottom: 4
        }}>
          {(msg.toolCalls as any[]).map((tc, i) => {
            // Chuẩn hóa entry — entry lỗi định dạng không được làm sập panel
            const safe = {
              tool: typeof tc?.tool === 'string' && tc.tool ? tc.tool : 'tool',
              input: tc?.input === undefined || tc?.input === null ? undefined : String(tc.input),
              output: tc?.output === undefined || tc?.output === null ? undefined : String(tc.output)
            };
            return (
              <ToolBlockSafe key={safe.tool + '-' + i}>
                <ToolCallBlock tool={safe.tool} input={safe.input} output={safe.output} />
              </ToolBlockSafe>
            );
          })}
        </div>
      )}

      {/* Khối 3: Bubble text — chỉ lời thoại/kết luận */}
      <div
        className={`af-bubble${isUser ? ' af-bubble-user' : ''}`}
        style={{
        background: bubbleBg,
        color: textColor,
        padding: isOpenCode ? '10px 12px' : '12px 16px',
        borderRadius: isUser ? '16px 4px 16px 16px' : '14px',
        maxWidth: isOpenCode ? (isMobile ? '96%' : '95%') : (isMobile ? '94%' : '85%'),
        fontSize: isOpenCode ? 12 : 13,
        lineHeight: 1.6,
        whiteSpace: 'pre-wrap',
        fontFamily: isOpenCode ? 'monospace' : 'inherit',
        border: bubbleBorder,
        boxShadow: bubbleShadow,
        wordBreak: 'break-word',
        position: 'relative'
      }}>
        {isReport && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 8,
            paddingBottom: 6,
            borderBottom: '1px solid var(--af-border)'
          }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--report-label)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              📋 Structured Task Report
            </span>
            <button
              onClick={() => onToggleReport(msg.id)}
              style={{
                background: 'var(--bg-inset)',
                border: '1px solid var(--af-border)',
                color: 'var(--text-secondary)',
                borderRadius: 4,
                padding: '2px 8px',
                fontSize: 10,
                cursor: 'pointer'
              }}
            >
              {isCollapsed ? 'Show Full Report' : 'Collapse'}
            </button>
          </div>
        )}

        {isReport && isCollapsed ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 12, fontStyle: 'italic' }}>
            Report content collapsed. Click "Show Full Report" above to expand.
          </div>
        ) : (
          /* Report Block: FULL HEIGHT — không giới hạn chiều cao, không scroll lồng */
          <div style={{ fontFamily: isOpenCode ? 'monospace' : 'inherit', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {body}
          </div>
        )}
      </div>
    </div>
  );
});

interface Props {
  messages: Message[];
  onSend: (text: string) => void;
  onStop?: () => void;
  onClear?: () => void;
  loading?: boolean;
  title?: string;
  tokenUsage?: number | TokenUsageDetail;
  contextLength?: number;
  cost?: number;
  model?: string;
  status?: string;
  formatMessage?: (msg: ChatMsg) => { sender: string; content: string; isUser: boolean; timestamp?: number };
  allMessages?: ChatMsg[];
  agents?: AgentInfo[];
  isMobile?: boolean;
  connStatus?: 'connected' | 'disconnected';
  offlineForText?: string;
  uptimeText?: string;
  showToolBlocks?: boolean;
  queuedMessages?: ChatMsg[];
  onFlushQueue?: () => void;
}

export function ChatPanel({
  messages,
  onSend,
  onStop,
  onClear,
  loading,
  title,
  tokenUsage,
  contextLength,
  cost,
  model,
  status,
  formatMessage,
  allMessages,
  agents = [],
  isMobile = false,
  queuedMessages = [],
  onFlushQueue,
  connStatus,
  offlineForText,
  uptimeText,
  showToolBlocks = true
}: Props) {
  const [input, setInput] = useState('');
  const [collapsedReports, setCollapsedReports] = useState<Record<string, boolean>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const initialLoadRef = useRef(true);
  const AUTO_SCROLL_THRESHOLD = 140;

  // ============ VIRTUALIZED TAIL WINDOW ============
  // Chỉ render N tin nhắn MỚI NHẤT khi vào hội thoại → load nhanh (<150ms) kể cả history dài.
  const INITIAL_VISIBLE_COUNT = 50;
  const LOAD_OLDER_STEP = 50;
  const TOP_LOAD_TRIGGER_PX = 80;
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT);
  const prependAnchorRef = useRef<number | null>(null);
  const loadingOlderRef = useRef(false);

  const tu = typeof tokenUsage === 'object' ? (tokenUsage as TokenUsageDetail) : null;
  const rawTokens = contextLength || tu?.totalTokens || tu?.total || (typeof tokenUsage === 'number' ? tokenUsage : undefined);
  const effectiveCost = cost || tu?.cost;
  const formattedTokens = formatTokens(rawTokens);
  const formattedCost = formatCost(effectiveCost);

  // Build detailed tooltip
  const tooltipParts: string[] = [];
  if (rawTokens) tooltipParts.push(`Total: ${rawTokens.toLocaleString()} tokens`);
  if (tu?.inputTokens || tu?.input) tooltipParts.push(`Input: ${(tu.inputTokens || tu.input)?.toLocaleString()}`);
  if (tu?.outputTokens || tu?.output) tooltipParts.push(`Output: ${(tu.outputTokens || tu.output)?.toLocaleString()}`);
  if (tu?.reasoningTokens) tooltipParts.push(`Reasoning: ${tu.reasoningTokens.toLocaleString()}`);
  if (tu?.cacheReadTokens) tooltipParts.push(`Cache Read: ${tu.cacheReadTokens.toLocaleString()}`);
  if (tu?.cacheWriteTokens) tooltipParts.push(`Cache Write: ${tu.cacheWriteTokens.toLocaleString()}`);
  if (effectiveCost) tooltipParts.push(`Cost: $${effectiveCost.toFixed(4)}`);
  const tooltipText = tooltipParts.length > 0 ? tooltipParts.join(' | ') : `Context: ${rawTokens?.toLocaleString() || 0} tokens`;

  const rawDisplay: any[] = allMessages && allMessages.length >= 0 ? allMessages as any[] : messages as any[];
  const displayMessages = rawDisplay;

  // Tail-window slice: chỉ lấy visibleCount tin nhắn cuối cùng
  const totalLen = rawDisplay.length;
  const sliceStart = Math.max(0, totalLen - visibleCount);
  const visibleMessages = totalLen > sliceStart ? rawDisplay.slice(sliceStart) : rawDisplay;
  const hiddenOlderCount = sliceStart;

  const loadOlder = useCallback(() => {
    if (loadingOlderRef.current) return;
    const el = scrollRef.current;
    if (el) prependAnchorRef.current = el.scrollHeight;
    loadingOlderRef.current = true;
    setVisibleCount(c => c + LOAD_OLDER_STEP);
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    isNearBottomRef.current = distanceFromBottom <= AUTO_SCROLL_THRESHOLD;
    // Tự động nạp tin nhắn cũ khi người dùng cuộn sát lên đỉnh
    if (scrollTop <= TOP_LOAD_TRIGGER_PX && totalLen > visibleCount) {
      loadOlder();
    }
  }, [totalLen, visibleCount, loadOlder]);

  // Reset cửa sổ hiển thị khi chuyển agent/hội thoại khác
  useEffect(() => {
    initialLoadRef.current = true;
    setVisibleCount(INITIAL_VISIBLE_COUNT);
    loadingOlderRef.current = false;
    prependAnchorRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title]);

  useEffect(() => {
    if (displayMessages.length === 0) {
      initialLoadRef.current = true;
    }
  }, [displayMessages.length]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (initialLoadRef.current) {
      el.scrollTop = el.scrollHeight;
      initialLoadRef.current = false;
      isNearBottomRef.current = true;
    } else if (isNearBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, allMessages]);

  // Sau khi prepend tin nhắn cũ (load more), giữ nguyên vị trí cuộn của người dùng
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && prependAnchorRef.current !== null) {
      el.scrollTop = Math.max(0, el.scrollHeight - prependAnchorRef.current);
      prependAnchorRef.current = null;
    }
    loadingOlderRef.current = false;
  }, [visibleCount, totalLen]);

  const handleSend = () => {
    if (!input.trim()) return;
    onSend(input.trim());
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    } else if (e.key === 'Escape') {
      if (e.repeat) {
        e.preventDefault();
        return;
      }
      if (loading && onStop) {
        onStop();
      }
    }
  };

  const toggleReport = useCallback((msgId: string) => {
    setCollapsedReports(prev => ({
      ...prev,
      [msgId]: !prev[msgId]
    }));
  }, []);

  return (
    <div className="af-chatpanel" style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-main)' }}>
      {/* Header */}
      <div className="af-chat-header" style={{
        padding: isMobile ? '10px 12px' : '12px 20px',
        borderBottom: '1px solid var(--af-border)',
        background: 'var(--bg-panel)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 8,
        boxShadow: 'var(--shadow-panel)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 34,
            height: 34,
            borderRadius: 8,
            background: 'linear-gradient(135deg, #4f46e5 0%, #3b82f6 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 16,
            boxShadow: '0 2px 6px rgba(79, 70, 229, 0.3)'
          }}>
            💬
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="af-chat-title" style={{ fontSize: 14, fontWeight: 600, color: '#f8fafc', letterSpacing: '-0.01em' }}>
                {title || 'Orchestrator'}
              </span>

              {/* Status Badge */}
              {status && (
                <div style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 8px',
                  borderRadius: 9999,
                  background: status === 'working' ? 'rgba(34, 197, 94, 0.15)' : status === 'error' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(100, 116, 139, 0.15)',
                  border: `1px solid ${status === 'working' ? 'rgba(34, 197, 94, 0.35)' : status === 'error' ? 'rgba(239, 68, 68, 0.35)' : 'rgba(100, 116, 139, 0.25)'}`,
                  fontSize: 10,
                  fontWeight: 600,
                  color: status === 'working' ? '#4ade80' : status === 'error' ? '#f87171' : '#94a3b8'
                }}>
                  <span
                    className={status === 'working' ? 'pulsing-green' : status === 'error' ? 'pulsing-red' : ''}
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      backgroundColor: status === 'working' ? '#22c55e' : status === 'error' ? '#ef4444' : '#64748b'
                    }}
                  />
                  <span>{status}</span>
                </div>
              )}

              {/* Model Tag */}
              {model && (
                <div style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 8px',
                  borderRadius: 9999,
                  background: 'rgba(99, 102, 241, 0.12)',
                  border: '1px solid rgba(99, 102, 241, 0.3)',
                  color: '#a5b4fc',
                  fontSize: 10,
                  fontWeight: 500,
                  fontFamily: 'monospace'
                }}>
                  <span>🧠</span>
                  <span>{model}</span>
                </div>
              )}

              {/* Token Usage / Context Length Badge */}
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 8px',
                  borderRadius: 9999,
                  background: 'rgba(56, 189, 248, 0.12)',
                  border: '1px solid rgba(56, 189, 248, 0.3)',
                  color: '#38bdf8',
                  fontSize: 10,
                  fontWeight: 600,
                  fontFamily: 'monospace'
                }}
                title={tooltipText}
              >
                <span>⚡</span>
                <span>{formattedTokens} tokens{formattedCost ? ` | ${formattedCost}` : ''}</span>
              </div>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
              Interactive Chat Session
            </div>
          </div>
        </div>

        {/* Connection Status Badge (WS) */}
        {connStatus && (
          <div
            className={connStatus === 'disconnected' ? 'af-conn-badge-off' : undefined}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              borderRadius: 9999,
              background: connStatus === 'connected' ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.15)',
              border: `1px solid ${connStatus === 'connected' ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.45)'}`,
              fontSize: 11,
              fontWeight: 600,
              color: connStatus === 'connected' ? '#4ade80' : '#f87171',
              whiteSpace: 'nowrap'
            }}
          >
            <span
              className={connStatus === 'connected' ? 'pulsing-green' : 'pulsing-red'}
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                backgroundColor: connStatus === 'connected' ? '#22c55e' : '#ef4444',
                display: 'inline-block'
              }}
            />
            <span>
              {connStatus === 'connected'
                ? `🟢 Live WS${uptimeText ? ` (${uptimeText})` : ''}`
                : `🔴 Offline${offlineForText ? ` (${offlineForText} trước)` : ''}`}
            </span>
          </div>
        )}

        {onClear && (
          <button
            onClick={() => {
              if (window.confirm('Bạn có chắc muốn xóa toàn bộ cuộc trò chuyện?')) {
                onClear();
              }
            }}
            style={{
              background: 'rgba(239, 68, 68, 0.1)',
              color: '#f87171',
              border: '1px solid rgba(239, 68, 68, 0.25)',
              borderRadius: 6,
              padding: '6px 12px',
              fontSize: 12,
              cursor: 'pointer',
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              transition: 'all 0.2s'
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.background = 'rgba(239, 68, 68, 0.2)';
              e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.4)';
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)';
              e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.25)';
            }}
          >
            <span>🗑️</span>
            <span>Clear Chat</span>
          </button>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} onScroll={handleScroll} className="af-chat-scroll" style={{ flex: 1, overflow: 'auto', padding: isMobile ? '14px 10px' : '24px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {displayMessages.length === 0 ? (
          <div style={{
            textAlign: 'center',
            color: 'var(--text-muted)',
            margin: 'auto',
            padding: 32,
            maxWidth: 420
          }}>
            <div style={{
              width: 64,
              height: 64,
              borderRadius: 20,
              background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
              border: '1px solid #334155',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 32,
              margin: '0 auto 16px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.3)'
            }}>
              🤖
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#f1f5f9', letterSpacing: '-0.02em' }}>AgentForge Workspace</div>
            <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.5, color: 'var(--text-muted)' }}>
              Spawn your autonomous worker agents, coordinate workflows, and command the swarm.
            </div>
          </div>
        ) : (
          <>
            {hiddenOlderCount > 0 && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '0 0 12px' }}>
                <button
                  onClick={loadOlder}
                  style={{
                    background: 'rgba(30, 41, 59, 0.8)',
                    color: '#93c5fd',
                    border: '1px solid rgba(59, 130, 246, 0.3)',
                    borderRadius: 9999,
                    padding: '6px 16px',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'all 0.2s'
                  }}
                >
                  ⬆ Load {Math.min(LOAD_OLDER_STEP, hiddenOlderCount)} older messages ({hiddenOlderCount} remaining)
                </button>
              </div>
            )}
            {visibleMessages.map((msg: any) => (
              <MessageItem
                key={msg.id}
                msg={msg}
                agents={agents}
                isCollapsed={!!collapsedReports[msg.id]}
                onToggleReport={toggleReport}
                isMobile={isMobile}
              />
            ))}
          </>
        )}

        {loading && (
          <div className="fade-in" style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
            color: '#93c5fd',
            fontSize: 12,
            marginTop: 4,
            padding: '8px 16px',
            background: 'rgba(30, 41, 59, 0.8)',
            border: '1px solid rgba(59, 130, 246, 0.3)',
            borderRadius: 9999,
            width: 'fit-content',
            boxShadow: '0 4px 14px rgba(0,0,0,0.3)',
            backdropFilter: 'blur(8px)'
          }}>
            <span className="spin-icon">⏳</span>
            <span style={{ fontWeight: 500 }}>Agent is thinking and processing...</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      {/* QUEUED MESSAGES BAR — hien ngay tren khung typing khi dang busy */}
      {queuedMessages.length > 0 && (
        <div className="af-queue-bar" style={{
          margin: '0 12px 10px',
          padding: '8px 12px',
          borderRadius: 10,
          border: '1px dashed rgba(56,189,248,0.4)',
          background: 'rgba(56,189,248,0.08)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          color: '#38bdf8',
          fontFamily: 'monospace',
          maxHeight: 56,
          overflow: 'hidden',
          animation: 'af-queue-slide 0.25s ease',
          transition: 'all 0.25s ease'
        }}>
          <span style={{ flexShrink: 0 }}>⏳ Queued ({queuedMessages.length})</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
            {queuedMessages.length === 1
              ? queuedMessages[0].content.slice(0, 80)
              : `${queuedMessages[0].content.slice(0, 50)}… +${queuedMessages.length - 1} more`}
          </span>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>→ sẽ gửi khi rảnh</span>
          {onFlushQueue && (
            <button onClick={onFlushQueue} title="Gửi hết hàng đợi ngay" style={{ background: 'rgba(56,189,248,0.15)', border: '1px solid rgba(56,189,248,0.4)', color: '#38bdf8', borderRadius: 6, padding: '2px 8px', fontSize: 10, cursor: 'pointer', fontFamily: 'monospace', flexShrink: 0 }}>Gửi hết</button>
          )}
        </div>
      )}
      <div className="af-chat-input" style={{
        padding: isMobile ? '10px 12px' : '16px 20px',
        paddingBottom: isMobile ? 'calc(10px + env(safe-area-inset-bottom))' : 16,
        borderTop: '1px solid var(--af-border)',
        background: 'var(--bg-panel)'
      }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={loading ? "Type to queue next message... (Enter to send)" : "Type your message or instructions... (Enter to send, Shift+Enter for newline)"}
            style={{
              flex: 1,
              background: 'var(--bg-input)',
              color: 'var(--text-primary)',
              border: '1px solid var(--af-border-strong)',
              borderRadius: 'var(--radius-lg)',
              padding: '12px 16px',
              fontSize: isMobile ? 16 : 13,
              lineHeight: 1.5,
              resize: 'none',
              minHeight: 44,
              maxHeight: 140,
              fontFamily: 'inherit',
              outline: 'none',
              transition: 'border-color 0.2s, box-shadow 0.2s'
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'var(--accent)';
              e.currentTarget.style.boxShadow = '0 0 0 3px var(--accent-soft)';
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'var(--af-border-strong)';
              e.currentTarget.style.boxShadow = 'none';
            }}
            rows={1}
          />

          <button
            onClick={handleSend}
            disabled={!input.trim()}
            title={loading ? 'Queue' : 'Send'}
            style={{
              background: input.trim() ? 'linear-gradient(135deg, var(--accent) 0%, var(--accent-strong) 100%)' : 'var(--bg-input)',
              color: input.trim() ? '#ffffff' : 'var(--text-muted)',
              border: input.trim() ? 'none' : '1px solid var(--af-border-strong)',
              borderRadius: 'var(--radius-md)',
              width: 44,
              padding: 0,
              fontSize: 20,
              cursor: input.trim() ? 'pointer' : 'not-allowed',
              fontWeight: 700,
              height: 44,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: input.trim() ? '0 2px 10px rgba(37, 99, 235, 0.3)' : 'none',
              transition: 'all 0.2s'
            }}
            onMouseOver={(e) => {
              if (input.trim()) e.currentTarget.style.transform = 'scale(1.04)';
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.transform = 'scale(1)';
            }}
          >
            <span>↑</span>
          </button>

          {loading && (
            <button
              onClick={onStop}
              title="Stop agent (Esc)"
              style={{
                background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
                color: 'white',
                border: 'none',
                borderRadius: 12,
                padding: '12px 16px',
                fontSize: 13,
                cursor: 'pointer',
                fontWeight: 600,
                height: 44,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                boxShadow: '0 2px 10px rgba(239, 68, 68, 0.3)'
              }}
            >
              <span>⏹</span>
              {!isMobile && <span>Stop</span>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
