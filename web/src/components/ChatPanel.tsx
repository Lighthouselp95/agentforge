import React, { useState, useMemo, useRef, useEffect, useLayoutEffect, useCallback, Component } from 'react';
import { highlight, isSupportedLang } from '../utils/highlight';

interface Message {
  id: string;
  agentId?: string;
  role?: string;
  content: string;
  timestamp?: number | string;
  thinking?: string;
}

interface ChatMsg {
  id: string;
  from: string;
  to?: string;
  content: string;
  task?: string;
  timestamp?: number | string;
  agentName?: string;
  agentRole?: string;
  msgType?: string;
  showOnUI?: boolean;
  // Toolcall cấu trúc từ event gốc opencode (backend gửi kèm trong payload)
  toolCalls?: Array<{ tool: string; input?: string; output?: string }>;
  thinking?: string;
  // Ordered parts (Option C): text + tool xen kẽ theo ĐÚNG thứ tự opencode emit — server gửi trong final snapshot.
  // Client render trực tiếp theo array. OPTIONAL (không có → render theo cách cũ).
  parts?: Array<{ type: 'text' | 'tool'; content?: string; tool?: string; input?: string; output?: string }>;
}

interface AgentInfo {
  id: string;
  name: string;
  role?: string;
  type?: string;
  task?: string;
  status?: string;
}

function stripTalkTags(text: string): string {
  if (!text) return '';
  let result = String(text);

  // Mask code blocks
  const codeBlocks: string[] = [];
  result = result.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => {
    const t = `__AF_CODE_BLOCK_${codeBlocks.length}__`;
    codeBlocks.push(m);
    return t;
  });

  // Doc Line Masking: bảo vệ dòng trích dẫn, danh sách markdown giải thích/hướng dẫn về thẻ
  // (ví dụ: "- Dùng thẻ <spawn role=... />", "> trích dẫn <talk ...>", "Hướng dẫn (ví dụ: gán agent.task = ...):")
  const docLines: string[] = [];
  result = result.replace(/^[ \t]*(?:>|[-*+]|\d+\.|\([^\n)]*|.*(?:ví dụ|hướng dẫn|cú pháp|lệnh|thẻ|dùng|tag|syntax|example|instruction|task_update)[^\n]*)[ \t]+.*(?:<|\b(?:TALK|SPAWN|TASK_UPDATE)\b).*$/gmi, (m) => {
    const t = `__AF_DOC_LINE_${docLines.length}__`;
    docLines.push(m);
    return t;
  });

  // 1. Strip full XML dispatch blocks WITH routing attributes: <talk target="..." task="...">payload</talk>
  result = result.replace(/^[ \t]*<\s*(?:talk|spawn|stop|resume|create_role|create-role|delete_agent)\b[^>]*\b(?:target|target-id|target_id|agent-id|agent_id|agent|to|id|role|name|task)\s*=[^>]*>[\s\S]*?<\/\s*(?:talk|spawn|stop|resume|create_role|create-role|delete_agent)\s*>[ \t]*\n?/gmi, '');
  // 2. Strip standalone self-closing dispatch commands
  result = result.replace(/^[ \t]*<\s*(?:spawn|stop|resume|create_role|create-role|delete_agent)\b[^>]*\b(?:target|target-id|target_id|agent-id|agent_id|agent|to|id|role|name|task)\s*=[^>]*\/>[ \t]*\n?/gmi, '');
  // 3. Strip unclosed opening dispatch tags (with routing) at line start
  result = result.replace(/^[ \t]*<\s*(?:talk|spawn)\b[^>]*\b(?:target|target-id|target_id|agent-id|agent_id|agent|to|id|role|name|task)\s*=[^>]*>[ \t]*\n?/gmi, '');

  // 4. Strip bracket [TALK target=...] tags on standalone lines
  const strText = result;
  let out = '';
  let pos = 0;
  const lower = strText.toLowerCase();
  while (pos < strText.length) {
    const talkIdx = lower.indexOf('[talk', pos);
    if (talkIdx === -1) {
      out += strText.substring(pos);
      break;
    }
    out += strText.substring(pos, talkIdx);
    let i = talkIdx + 5; // length of '[talk'
    let inQuotes: string | null = null;
    let foundClose = false;
    while (i < strText.length) {
      const char = strText[i];
      if (inQuotes) {
        if (char === inQuotes && strText[i - 1] !== '\\') {
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
      // Check if it's a real command tag with attributes or just conversational [TALK]
      const tagContent = strText.substring(talkIdx, i + 1);
      const isRealCommand = /\b(?:target|agent|agent-id|agent_id|target-id|target_id|to|id)\s*=/i.test(tagContent);
      if (isRealCommand) {
        pos = i + 1;
      } else {
        out += strText.substring(talkIdx, i + 1);
        pos = i + 1;
      }
    } else {
      const fallbackMatch = strText.substring(talkIdx).match(/^\[talk\s+[\s\S]*?\]/i);
      if (fallbackMatch) {
        pos = talkIdx + fallbackMatch[0].length;
      } else {
        out += strText.substring(talkIdx, talkIdx + 5);
        pos = talkIdx + 5;
      }
    }
  }
  // Strip bracket closing tag [/TALK]
  out = out.replace(/\[\/talk\]/gi, '');

  // Unmask
  for (let i = 0; i < docLines.length; i++) out = out.replace(`__AF_DOC_LINE_${i}__`, docLines[i]);
  for (let i = 0; i < codeBlocks.length; i++) out = out.replace(`__AF_CODE_BLOCK_${i}__`, codeBlocks[i]);

  return out.replace(/^\s+/, '').replace(/\n{3,}/g, '\n\n').trim();
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
// giữ nguyên thụt lề gốc của code. Dòng thêm (+) có syntax highlight (lang) như Write/Read viewer.
function DiffLine({ sign, text, tokens }: { sign: '-' | '+'; text: string; tokens?: any[] }) {
  const isRemove = sign === '-';
  const hasTokens = !isRemove && tokens && tokens.length > 0;
  return (
    <div style={{
      background: isRemove ? 'rgba(239, 68, 68, 0.14)' : 'rgba(34, 197, 94, 0.14)',
      color: isRemove ? '#fca5a5' : '#86efac',
      borderLeft: isRemove ? '3px solid #ef4444' : '3px solid #22c55e',
      padding: '1px 8px',
      fontFamily: 'monospace',
      fontSize: 11,
      lineHeight: 1.55,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word'
    }}>
      {hasTokens ? tokens.map((t, i) => (
        <span key={i} style={{ color: t.color || undefined, fontStyle: t.italic ? 'italic' : undefined, fontWeight: t.bold ? 700 : undefined }}>{t.text}</span>
      )) : (text || ' ')}
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
      fontSize: 11,
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

// ============ MARKDOWN RENDERER ============
function getLangBadge(lang: string) {
  const l = (lang || '').toLowerCase().trim();
  if (l === 'ts' || l === 'tsx' || l === 'typescript') return <span style={{ background: '#3178c6', color: '#ffffff', padding: '1px 5px', borderRadius: 3, fontWeight: 700, fontSize: 10, marginRight: 6 }}>TS</span>;
  if (l === 'js' || l === 'jsx' || l === 'javascript') return <span style={{ background: '#f7df1e', color: '#000000', padding: '1px 5px', borderRadius: 3, fontWeight: 700, fontSize: 10, marginRight: 6 }}>JS</span>;
  if (l === 'bash' || l === 'sh' || l === 'shell' || l === 'zsh') return <span style={{ color: '#22c55e', fontWeight: 700, fontSize: 11, marginRight: 6 }}>&gt;_</span>;
  if (l === 'json') return <span style={{ color: '#f97316', fontWeight: 700, fontSize: 11, marginRight: 6 }}>&#123; &#125;</span>;
  if (l === 'py' || l === 'python') return <span style={{ marginRight: 6 }}>🐍</span>;
  if (l === 'html' || l === 'xml') return <span style={{ marginRight: 6 }}>🌐</span>;
  if (l === 'css' || l === 'scss') return <span style={{ marginRight: 6 }}>🎨</span>;
  if (l === 'md' || l === 'markdown') return <span style={{ marginRight: 6 }}>📝</span>;
  return <span style={{ marginRight: 6 }}>📄</span>;
}

// ============ FILE PATH → LANG (cho highlight WriteFileViewer / ReadFileViewer) ============
// Map extension sang chuỗi lang khớp registry highlight.ts (js/jsx/ts/tsx/json/md/html/css/scss/py).
// Trả về '' nếu không nhận diện → fallback plain (không highlight), giữ hiệu năng.
function langFromPath(path: string): string {
  if (!path) return '';
  const base = String(path).toLowerCase().trim();
  const extMatch = base.match(/(?:^|[.])([a-z0-9]+)$/);
  if (!extMatch) return '';
  const ext = extMatch[1];
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return 'js';
  if (ext === 'ts' || ext === 'tsx' || ext === 'mts' || ext === 'cts') return 'ts';
  if (ext === 'json' || ext === 'jsonc') return 'json';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'html' || ext === 'htm' || ext === 'xml' || ext === 'svg') return 'html';
  if (ext === 'css' || ext === 'scss' || ext === 'sass' || ext === 'less') return 'css';
  if (ext === 'py' || ext === 'python') return 'py';
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh' || ext === 'ps1') return 'bash';
  return '';
}

// ============ FILE EXTENSION → ICON GLYPH + MÀU (VS Code style) ============
// Tạo box glyph nhỏ có màu riêng theo extension cho tiêu đề tool read/write.
// KHÔNG dùng thư viện icon (app nhẹ theo tiêu chí) — chỉ ký tự unicode + màu.
const EXT_ICON: Record<string, { glyph: string; color: string; bg: string }> = {
  ts:  { glyph: 'TS',  color: '#ffffff', bg: '#3178c6' },
  tsx: { glyph: 'TSX', color: '#ffffff', bg: '#3178c6' },
  mts: { glyph: 'TS',  color: '#ffffff', bg: '#3178c6' },
  cts: { glyph: 'TS',  color: '#ffffff', bg: '#3178c6' },
  js:  { glyph: 'JS',  color: '#000000', bg: '#f7df1e' },
  jsx: { glyph: 'JSX', color: '#000000', bg: '#f7df1e' },
  mjs: { glyph: 'JS',  color: '#000000', bg: '#f7df1e' },
  cjs: { glyph: 'JS',  color: '#000000', bg: '#f7df1e' },
  json: { glyph: '{ }', color: '#f97316', bg: 'transparent' },
  jsonc: { glyph: '{ }', color: '#f97316', bg: 'transparent' },
  md:  { glyph: 'M↓',  color: '#ffffff', bg: '#4aa3df' },
  markdown: { glyph: 'M↓', color: '#ffffff', bg: '#4aa3df' },
  html: { glyph: '</>', color: '#ffffff', bg: '#e34f26' },
  htm:  { glyph: '</>', color: '#ffffff', bg: '#e34f26' },
  xml:  { glyph: '</>', color: '#ffffff', bg: '#e34f26' },
  svg:  { glyph: 'SVG', color: '#ffffff', bg: '#ffb13b' },
  css:  { glyph: '#',   color: '#ffffff', bg: '#1572b6' },
  scss: { glyph: '#',   color: '#ffffff', bg: '#cd6799' },
  sass: { glyph: '#',   color: '#ffffff', bg: '#cd6799' },
  less: { glyph: '#',   color: '#ffffff', bg: '#1d365d' },
  py:   { glyph: 'PY',  color: '#ffffff', bg: '#3776ab' },
  python: { glyph: 'PY', color: '#ffffff', bg: '#3776ab' },
  sh:   { glyph: '>_',  color: '#ffffff', bg: '#3e8635' },
  bash: { glyph: '>_',  color: '#ffffff', bg: '#3e8635' },
  zsh:  { glyph: '>_',  color: '#ffffff', bg: '#3e8635' },
  ps1:  { glyph: '>_',  color: '#ffffff', bg: '#3e8635' }
};

function extIcon(path: string): React.ReactNode {
  if (!path) return <span style={{ marginRight: 6, color: '#94a3b8' }}>◇</span>;
  const base = String(path).toLowerCase().trim();
  const m = base.match(/(?:^|[.])([a-z0-9]+)$/);
  const ext = m ? m[1] : '';
  const cfg = EXT_ICON[ext];
  if (!cfg) return <span style={{ marginRight: 6, color: '#94a3b8' }}>📄</span>;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: 18, height: 16, marginRight: 6, borderRadius: 3, padding: '0 3px',
      background: cfg.bg, color: cfg.color, fontWeight: 700, fontSize: 10,
      fontFamily: 'monospace', boxSizing: 'border-box'
    }}>{cfg.glyph}</span>
  );
}

function CodeBlock({ code, lang, isMobile }: { code: string; lang: string; isMobile?: boolean }) {
  const [copied, setCopied] = useState(false);

  // USER: giới hạn tối đa 90 dòng hiển thị code (cắt trước khi tokenize)
  const displayCode = clampToolLines(code).text;

  // Chỉ tokenize khi ngôn ngữ được hỗ trợ — fallback plain text giữ hiệu năng tối đa
  const supported = useMemo(() => isSupportedLang(lang), [lang]);
  const tokens = useMemo(() => (supported ? highlight(displayCode, lang) : []), [supported, displayCode, lang]);

  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  return (
    <div style={{
      borderRadius: 8,
      border: '1px solid var(--af-border)',
      background: 'var(--bg-inset)',
      margin: '8px 0',
      overflow: 'hidden',
      width: '100%',
      boxSizing: 'border-box'
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 12px',
        background: 'rgba(255, 255, 255, 0.03)',
        borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
        fontSize: 11,
        color: 'var(--text-secondary)',
        fontFamily: 'monospace'
      }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {getLangBadge(lang)}
          <span style={{ fontWeight: 600, textTransform: 'lowercase' }}>{lang || 'code'}</span>
        </div>
        <button
          onClick={handleCopy}
          style={{
            background: copied ? 'rgba(34, 197, 94, 0.15)' : 'transparent',
            border: copied ? '1px solid rgba(34, 197, 94, 0.3)' : 'none',
            color: copied ? '#10b981' : '#93c5fd',
            borderRadius: 4,
            padding: '2px 6px',
            fontSize: 11,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            transition: 'all 0.15s ease'
          }}
        >
          <span>{copied ? '✓' : '📋'}</span>
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre style={{
        margin: 0,
        padding: '10px 14px',
        overflowX: 'auto',
        maxWidth: '100%',
        fontSize: isMobile ? 12 : 11.5,
        lineHeight: 1.55,
        color: 'var(--text-primary)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
      }}>
        {supported ? (
          <code>{tokens.map((t, i) => (
            <span
              key={i}
              style={{
                color: t.color || undefined,
                fontStyle: t.italic ? 'italic' : undefined,
                fontWeight: t.bold ? 700 : undefined
              }}
            >
              {t.text}
            </span>
          ))}</code>
        ) : (
          <code>{displayCode}</code>
        )}
      </pre>
    </div>
  );
}

function parseXmlAttributes(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!attrStr) return attrs;
  const regex = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = regex.exec(attrStr)) !== null) {
    const key = String(match[1] || '').toLowerCase();
    const val = match[2] !== undefined ? match[2] : (match[3] !== undefined ? match[3] : (match[4] || ''));
    attrs[key] = val;
  }
  return attrs;
}

interface SplitMessageResult {
  conversationText: string;
  hasReport: boolean;
  reportTitle?: string;
  reportContent?: string;
}

function splitReportAndConversation(content: string): SplitMessageResult {
  if (!content) return { conversationText: '', hasReport: false };

  let text = String(content || '').normalize('NFC');

  // Code Span Masking: Tạm thời thay thế nội dung trong ```...``` hoặc `...` bằng placeholder
  // để bảo vệ các ví dụ mẫu XML/command bên trong code blocks không bị regex xóa nhầm
  const codeBlocks: string[] = [];
  text = text.replace(/```[\s\S]*?```|`[^`\n]+`/g, (match) => {
    const token = `__AF_CODE_BLOCK_${codeBlocks.length}__`;
    codeBlocks.push(match);
    return token;
  });

  // Doc Line Masking: bảo vệ dòng trích dẫn, danh sách markdown giải thích/hướng dẫn về thẻ
  // (ví dụ: "- Dùng thẻ <spawn role=... />", "> trích dẫn <talk ...>", "Chỉ đạo (ví dụ: gán agent.task = ...):")
  const docLines: string[] = [];
  text = text.replace(/^[ \t]*(?:>|[-*+]|\d+\.|\([^\n)]*|.*(?:ví dụ|hướng dẫn|cú pháp|lệnh|thẻ|dùng|tag|syntax|example|instruction|task_update)[^\n]*)[ \t]+.*(?:<|\b(?:TALK|SPAWN|TASK_UPDATE)\b).*$/gmi, (match) => {
    const token = `__AF_DOC_LINE_${docLines.length}__`;
    docLines.push(match);
    return token;
  });

  // 1. Strip genuine dispatch command blocks (standalone on their own lines or wrapping payload)
  text = text.replace(/^[ \t]*<\s*(?:talk|spawn|stop|resume|create_role|create-role|delete_agent)\b[^>]*\b(?:target|target-id|target_id|agent-id|agent_id|agent|to|id|role|name|task)\s*=[^>]*>[\s\S]*?<\/\s*(?:talk|spawn|stop|resume|create_role|create-role|delete_agent)\s*>[ \t]*\n?/gmi, '');
  text = text.replace(/^[ \t]*<\s*(?:spawn|stop|resume|create_role|create-role|delete_agent)\b[^>]*\b(?:target|target-id|target_id|agent-id|agent_id|agent|to|id|role|name|task)\s*=[^>]*\/>[ \t]*\n?/gmi, '');
  text = text.replace(/^[ \t]*<\s*(?:talk|spawn)\b[^>]*\b(?:target|target-id|target_id|agent-id|agent_id|agent|to|id|role|name|task)\s*=[^>]*>[ \t]*\n?/gmi, '');
  text = text.replace(/^[ \t]*\[(?:TALK|SPAWN|STOP|RESUME|CREATE ROLE)\b[^\]]*\][ \t]*\n?/gmi, '');

  // 3. Clean technical routing tags and headers
  text = text.replace(/(?:\[FROM:\s*[^\]]+\]\s*)?\[TO:\s*[^\]]+\]\s*(?:Task complete\.?)?/gi, '');
  text = text.replace(/^\s*\[TASK\][^\n]*\n?/gmi, '');

  // Khôi phục lại docLines đã được bảo vệ an toàn
  for (let i = 0; i < docLines.length; i++) {
    text = text.replace(`__AF_DOC_LINE_${i}__`, docLines[i]);
  }

  // Khôi phục lại các code blocks đã được bảo vệ an toàn
  for (let i = 0; i < codeBlocks.length; i++) {
    text = text.replace(`__AF_CODE_BLOCK_${i}__`, codeBlocks[i]);
  }

  // 4. Extract structured report block if present (XML <report>...</report> or Bracket === TASK REPORT ===)
  // 4.1. XML Report: <report type="task" status="completed" ...> ... </report>
  const xmlReportRe = /<(?:\s*(report|task_report|task-report|error_report|error-report))\b([^>]*)>([\s\S]*?)<\/\s*(?:report|task_report|task-report|error_report|error-report)\s*>/iu;
  const xmlMatch = text.match(xmlReportRe);

  if (xmlMatch && xmlMatch.index !== undefined) {
    const rawTag = String(xmlMatch[1] || '').toLowerCase();
    const attrText = xmlMatch[2] || '';
    const reportContent = xmlMatch[3].trim();
    const attrs = parseXmlAttributes(attrText);
    const reportTitle = (attrs['type'] || rawTag.replace(/[-_]+/g, ' ')).toUpperCase();

    const beforeText = text.substring(0, xmlMatch.index).trim();
    const afterText = text.substring(xmlMatch.index + xmlMatch[0].length).trim();
    let conversationText = [beforeText, afterText].filter(Boolean).join('\n\n').trim();
    conversationText = conversationText.replace(/__AF_CODE_BLOCK_(\d+)__/g, (_, idx) => codeBlocks[Number(idx)] || '');

    return {
      conversationText,
      hasReport: true,
      reportTitle: reportTitle.includes('REPORT') ? reportTitle : `${reportTitle} REPORT`,
      reportContent
    };
  }

  // 4.2. Bracket Report: === TASK REPORT === ... === END REPORT ===
  const reportRe = /(?:^|\n)[ \t]*===\s*([A-Z_ ]+REPORT)\s*===[ \t]*\r?\n([\s\S]*?)(?:[ \t]*===\s*END[^\n=]*REPORT\s*===[ \t]*(?:\r?\n|$)|$)/iu;
  const match = text.match(reportRe);

  if (match && match.index !== undefined) {
    const reportTitle = match[1].trim();
    const reportContent = match[2].trim();

    // 3-Tier Structured Validation:
    // Tier 1: Check for presence of core report markers (AGENT_ID, STATUS, ROLE, WHAT I DID, FILES, REQUIREMENTS)
    const hasCoreMarker = /\b(?:AGENT_ID|STATUS|ROLE|WHAT I DID|FILES|REQUIREMENTS_CHECKED|ERROR|BUG|VERDICT|KEY_DECISIONS)\s*:/iu.test(reportContent) ||
      (reportContent.startsWith('{') && reportContent.includes('"agent_id"'));
    // Tier 2: Check if content has at least 1-2 structured key-value fields or valid JSON
    const fieldCount = (reportContent.match(/^[A-Z_0-9]+:\s*/gmu) || []).length;
    const isRealReport = hasCoreMarker && (fieldCount >= 1 || reportContent.startsWith('{'));

    if (isRealReport) {
      // Everything before and after the report block is conversational text
      const beforeText = text.substring(0, match.index).trim();
      const afterText = text.substring(match.index + match[0].length).trim();
      let conversationText = [beforeText, afterText].filter(Boolean).join('\n\n').trim();
      conversationText = conversationText.replace(/__AF_CODE_BLOCK_(\d+)__/g, (_, idx) => codeBlocks[Number(idx)] || '');

      return {
        conversationText,
        hasReport: true,
        reportTitle,
        reportContent
      };
    }
  }

  let conversationText = text.trim().replace(/__AF_CODE_BLOCK_(\d+)__/g, (_, idx) => codeBlocks[Number(idx)] || '');

  return {
    conversationText,
    hasReport: false
  };
}

function ReportCard({ title, content }: { title: string; content: string }) {
  const [collapsed, setCollapsed] = useState(false);
  const parsedFields: Array<{ label: string; value: string }> = [];

  const rawTrimmed = (content || '').trim();

  // 1. Try parsing JSON if content is JSON
  if (rawTrimmed.startsWith('{') && rawTrimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(rawTrimmed);
      for (const [k, v] of Object.entries(obj)) {
        const valStr = typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
        parsedFields.push({ label: k.toUpperCase(), value: valStr });
      }
    } catch {}
  }

  // 2. Try parsing XML tags like <status>...</status> or <files>...</files>
  if (parsedFields.length === 0 && /<[a-zA-Z_0-9-]+>[\s\S]*?<\/[a-zA-Z_0-9-]+>/.test(rawTrimmed)) {
    const xmlFieldRe = /<([a-zA-Z_0-9-]+)>([\s\S]*?)<\/\1>/g;
    let xm: RegExpExecArray | null;
    while ((xm = xmlFieldRe.exec(rawTrimmed)) !== null) {
      parsedFields.push({ label: xm[1].toUpperCase().replace(/[-_]+/g, ' '), value: xm[2].trim() });
    }
  }

  // 3. Fallback to standard KEY: VALUE line parsing
  if (parsedFields.length === 0) {
    const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let currentLabel = '';
    let currentValue = '';

    for (const line of lines) {
      const match = line.match(/^([A-Z_0-9]+):\s*(.*)$/i);
      if (match) {
        if (currentLabel) {
          parsedFields.push({ label: currentLabel.toUpperCase(), value: currentValue.trim() });
        }
        currentLabel = match[1];
        currentValue = match[2] || '';
      } else {
        if (currentLabel) {
          currentValue += (currentValue ? '\n' : '') + line;
        } else {
          currentLabel = 'CONTENT';
          currentValue = line;
        }
      }
    }
    if (currentLabel) {
      parsedFields.push({ label: currentLabel.toUpperCase(), value: currentValue.trim() });
    }
  }

  return (
    <div style={{
      borderRadius: 8,
      border: '1px solid var(--af-border)',
      background: 'rgba(255, 255, 255, 0.02)',
      margin: '8px 0',
      overflow: 'hidden'
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '8px 12px',
        background: 'var(--bg-panel)',
        borderBottom: '1px solid var(--af-border)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 12.5, color: 'var(--text-primary)' }}>
          <span>📋</span>
          <span>{title || 'Structured Task Report'}</span>
        </div>
        <button
          onClick={() => setCollapsed(!collapsed)}
          style={{
            background: 'var(--bg-input)',
            border: '1px solid var(--af-border)',
            color: 'var(--text-secondary)',
            borderRadius: 4,
            padding: '2px 8px',
            fontSize: 11,
            cursor: 'pointer'
          }}
        >
          {collapsed ? 'Mở rộng' : 'Thu gọn'}
        </button>
      </div>

      {/* Body */}
      {!collapsed && (
        <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
          {parsedFields.map((field, fIdx) => {
            const isStatus = field.label === 'STATUS';
            const isCompleted = String(field.value || '').toLowerCase().includes('completed') || String(field.value || '').toLowerCase().includes('passed');
            const isError = String(field.value || '').toLowerCase().includes('blocked') || String(field.value || '').toLowerCase().includes('failed') || String(field.value || '').toLowerCase().includes('error');
            const isFiles = field.label === 'FILES';
            
            return (
              <div key={fIdx} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.02em' }}>
                  {field.label}:
                </div>
                <div style={{ paddingLeft: 4, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>
                  {isStatus ? (
                    <span style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: 0,
                      fontWeight: 600,
                      fontSize: 12,
                      background: 'transparent',
                      border: 'none',
                      color: isCompleted ? '#10b981' : isError ? '#f87171' : 'var(--text-secondary)'
                    }}>
                      {isCompleted ? '✓ ' : isError ? '✕ ' : ''}{field.value}
                    </span>
                  ) : isFiles ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {field.value.split(/\s*,\s*|\s*\n\s*/).filter(Boolean).map((file, fi) => (
                        <div key={fi} style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '3px 8px',
                          borderRadius: 4,
                          background: 'rgba(255, 255, 255, 0.04)',
                          fontFamily: 'monospace',
                          fontSize: 12
                        }}>
                          <span style={{ color: 'var(--text-secondary)', opacity: 0.5 }}>📄</span>
                          <span style={{ color: '#93c5fd' }}>{file.trim()}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    renderInlineMarkdown(field.value)
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  if (!text) return [];
  const safeText = String(text).normalize('NFC');
  const nodes: React.ReactNode[] = [];
  const regex = /(`[^`]+`|\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|(?<!\w)__[^_]+__(?!\w)|\*[^*]+\*|(?<!\w)_[^_]+_(?!\w)|~~[^~]+~~|\[[^\]]+\]\([^)]+\))/gu;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(safeText)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(safeText.slice(lastIndex, match.index));
    }
    const token = match[0];
    const key = `inline-${match.index}-${token.length}`;

    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(
        <code key={key} style={{
          background: 'rgba(255, 255, 255, 0.08)',
          color: '#93c5fd',
          padding: '2px 6px',
          borderRadius: 4,
          fontSize: '0.9em',
          fontFamily: 'monospace'
        }}>
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('***') && token.endsWith('***')) {
      nodes.push(<strong key={key} style={{ color: 'var(--text-primary)', fontWeight: 700 }}><em>{token.slice(3, -3)}</em></strong>);
    } else if ((token.startsWith('**') && token.endsWith('**')) || (token.startsWith('__') && token.endsWith('__'))) {
      nodes.push(<strong key={key} style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{token.slice(2, -2)}</strong>);
    } else if ((token.startsWith('*') && token.endsWith('*')) || (token.startsWith('_') && token.endsWith('_'))) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith('~~') && token.endsWith('~~')) {
      nodes.push(<del key={key} style={{ opacity: 0.6 }}>{token.slice(2, -2)}</del>);
    } else if (token.startsWith('[') && token.includes('](')) {
      const parts = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/u);
      if (parts) {
        nodes.push(
          <a key={key} href={parts[2]} target="_blank" rel="noreferrer" style={{ color: '#60a5fa', textDecoration: 'underline' }}>
            {parts[1]}
          </a>
        );
      } else {
        nodes.push(token);
      }
    } else {
      nodes.push(token);
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < safeText.length) {
    nodes.push(safeText.slice(lastIndex));
  }

  return nodes;
}

function splitMarkdownSections(content: string): Array<{ type: 'code' | 'md'; content: string; lang?: string }> {
  const sections: Array<{ type: 'code' | 'md'; content: string; lang?: string }> = [];
  const safeContent = String(content || '').normalize('NFC');
  const lines = safeContent.split(/\r?\n/);
  
  let inCode = false;
  let codeFenceLength = 0;
  let codeLang = '';
  let codeLines: string[] = [];
  let mdLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (!inCode) {
      // Check for code fence opening (3 or more backticks or tildes, optional leading indentation)
      const match = line.match(/^\s*(`{3,}|~{3,})([a-zA-Z0-9_+#.-]*)\s*$/);
      if (match) {
        if (mdLines.length > 0) {
          sections.push({ type: 'md', content: mdLines.join('\n') });
          mdLines = [];
        }
        inCode = true;
        codeFenceLength = match[1].length;
        codeLang = match[2] || '';
        codeLines = [];
      } else {
        mdLines.push(line);
      }
    } else {
      // In code: check for closing fence with exact codeFenceLength backticks/tildes on its own line
      const closeMatch = line.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (closeMatch && closeMatch[1].length === codeFenceLength) {
        sections.push({ type: 'code', lang: codeLang, content: codeLines.join('\n') });
        inCode = false;
        codeFenceLength = 0;
        codeLang = '';
        codeLines = [];
      } else {
        codeLines.push(line);
      }
    }
  }

  if (inCode) {
    // Unclosed code block - treat as code
    sections.push({ type: 'code', lang: codeLang, content: codeLines.join('\n') });
  } else if (mdLines.length > 0) {
    sections.push({ type: 'md', content: mdLines.join('\n') });
  }

  return sections;
}

function MarkdownRenderer({ content, isMobile }: { content: string; isMobile?: boolean }) {
  if (!content) return null;

  const sections = splitMarkdownSections(content);

  return (
    <div className="af-markdown" style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      fontSize: isMobile ? 12 : 12.5,
      lineHeight: 1.45,
      minWidth: 0,
      maxWidth: '100%',
      color: 'var(--text-primary)'
    }}>
      {sections.map((sec, secIdx) => {
        if (sec.type === 'code') {
          return <CodeBlock key={`sec-${secIdx}`} code={sec.content} lang={sec.lang || ''} isMobile={isMobile} />;
        }

        // Process markdown lines
        const lines = sec.content.split(/\r?\n/);
        const elements: React.ReactNode[] = [];
        let i = 0;

        while (i < lines.length) {
          const line = lines[i];
          const trimmed = line.trim();

          // Empty line
          if (!trimmed) {
            i++;
            continue;
          }

          // Structured Report Block fallback
          const reportMatch = trimmed.match(/^===\s*([A-Z_ ]+REPORT)\s*===/i);
          if (reportMatch) {
            const reportTitle = reportMatch[1].trim();
            const reportLines: string[] = [];
            i++; // skip start marker
            while (i < lines.length && !lines[i].trim().match(/^===\s*END/i)) {
              reportLines.push(lines[i]);
              i++;
            }
            if (i < lines.length && lines[i].trim().match(/^===\s*END/i)) {
              i++; // skip end marker
            }
            elements.push(
              <ReportCard key={`report-${i}`} title={reportTitle} content={reportLines.join('\n')} />
            );
            continue;
          }

          // Horizontal Rule (CommonMark Specification: 3+ of -, *, _ with optional spaces, e.g. `---`, `- - -`, `***`, `* * *`, `___`, `_ _ _`)
          if (/^(?:(?:\s*-\s*){3,}|(?:\s*\*\s*){3,}|(?:\s*_\s*){3,})$/.test(trimmed)) {
            elements.push(
              <hr
                key={`hr-${i}`}
                style={{
                  border: 'none',
                  borderTop: '1px solid var(--af-border)',
                  margin: '10px 0',
                  opacity: 0.8
                }}
              />
            );
            i++;
            continue;
          }

          // Markdown Headers (Modern Cursor / Claude Style)
          if (line.startsWith('# ')) {
            elements.push(<h1 key={`h1-${i}`} style={{ fontSize: 13.5, fontWeight: 700, letterSpacing: '-0.01em', margin: '8px 0 3px', color: 'var(--text-primary)', borderBottom: '1px solid var(--af-border)', paddingBottom: 2, lineHeight: 1.4 }}>{renderInlineMarkdown(line.slice(2))}</h1>);
            i++;
            continue;
          }
          if (line.startsWith('## ')) {
            elements.push(<h2 key={`h2-${i}`} style={{ fontSize: 13, fontWeight: 700, margin: '6px 0 2px', color: 'var(--text-primary)', lineHeight: 1.4 }}>{renderInlineMarkdown(line.slice(3))}</h2>);
            i++;
            continue;
          }
          if (line.startsWith('### ')) {
            elements.push(<h3 key={`h3-${i}`} style={{ fontSize: 12.5, fontWeight: 700, margin: '5px 0 2px', color: 'var(--text-primary)', lineHeight: 1.4 }}>{renderInlineMarkdown(line.slice(4))}</h3>);
            i++;
            continue;
          }
          if (line.startsWith('#### ')) {
            elements.push(<h4 key={`h4-${i}`} style={{ fontSize: 12.5, fontWeight: 700, margin: '4px 0 2px', color: 'var(--text-primary)', lineHeight: 1.4 }}>{renderInlineMarkdown(line.slice(5))}</h4>);
            i++;
            continue;
          }

          // Plain text headers (all caps or ending with colon like 'BÁO CÁO:' or 'Nguyên nhân:')
          const isAllCapsHeader = /^[A-Z0-9_\sÀ-ỸÁ-ỴĂ-ỮĐ]{3,}:?\s*$/.test(trimmed) && trimmed.length > 2 && trimmed.length < 80 && !trimmed.startsWith('HTTP');
          const isColonHeader = /^([A-ZÀ-Ỹa-zà-ỹ0-9_ -]{2,50}):$/.test(trimmed);
          if (isAllCapsHeader || isColonHeader) {
            elements.push(
              <div key={`head-${i}`} style={{ fontWeight: 700, fontSize: 12.5, color: 'var(--text-primary)', marginTop: 5, marginBottom: 2, lineHeight: 1.4 }}>
                {renderInlineMarkdown(line)}
              </div>
            );
            i++;
            continue;
          }

          // Horizontal rule (CommonMark compliant: 3 or more -, *, _ with optional spaces)
          if (/^(?:-{3,}|\*{3,}|_{3,}|(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(trimmed)) {
            elements.push(
              <hr
                key={`hr-${i}`}
                style={{
                  border: 'none',
                  borderTop: '1px solid var(--af-border)',
                  margin: '12px 0',
                  width: '100%'
                }}
              />
            );
            i++;
            continue;
          }

          // Blockquote
          if (line.startsWith('> ') || line === '>') {
            const bqLines: string[] = [];
            while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>')) {
              bqLines.push(lines[i].replace(/^>\s?/, ''));
              i++;
            }
            elements.push(
              <blockquote key={`bq-${i}`} style={{
                borderLeft: '3px solid #3b82f6',
                background: 'rgba(59, 130, 246, 0.08)',
                padding: '6px 12px',
                margin: '6px 0',
                borderRadius: '0 6px 6px 0',
                color: 'var(--text-secondary)'
              }}>
                {bqLines.map((bql, bqIdx) => <div key={bqIdx}>{renderInlineMarkdown(bql)}</div>)}
              </blockquote>
            );
            continue;
          }

          // Table
          if (trimmed.startsWith('|') && trimmed.endsWith('|') && i + 1 < lines.length && lines[i + 1].includes('---')) {
            const tableLines: string[] = [];
            while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
              tableLines.push(lines[i].trim());
              i++;
            }
            if (tableLines.length >= 2) {
              const headerCols = tableLines[0].slice(1, -1).split('|').map(c => c.trim());
              const bodyRows = tableLines.slice(2).map(r => r.slice(1, -1).split('|').map(c => c.trim()));
              elements.push(
                <div key={`tbl-${i}`} style={{ overflowX: 'auto', margin: '8px 0' }}>
                  <table style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: 12.5,
                    border: '1px solid var(--af-border)',
                    borderRadius: 6
                  }}>
                    <thead>
                      <tr style={{ background: 'var(--bg-inset)' }}>
                        {headerCols.map((hc, hcIdx) => (
                          <th key={hcIdx} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--af-border)', color: 'var(--text-primary)' }}>
                            {renderInlineMarkdown(hc)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {bodyRows.map((row, rowIdx) => (
                        <tr key={rowIdx} style={{ background: rowIdx % 2 === 1 ? 'rgba(255,255,255,0.02)' : 'transparent', borderBottom: '1px solid var(--af-border)' }}>
                          {row.map((cell, cellIdx) => (
                            <td key={cellIdx} style={{ padding: '6px 10px', color: 'var(--text-secondary)' }}>
                              {renderInlineMarkdown(cell)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
              continue;
            }
          }

          // Unordered List (standard markdown spec, multi-level indentation)
          if (/^(\s*)[*+-•\u2022]\s+/.test(line)) {
            const listItems: Array<{ text: string; isNested: boolean }> = [];
            while (i < lines.length && /^(\s*)[*+-•\u2022]\s+/.test(lines[i])) {
              const rawLine = lines[i];
              const isNested = /^\s{2,}[*+-•\u2022]\s+/.test(rawLine) || /^\t+[*+-•\u2022]\s+/.test(rawLine);
              listItems.push({
                text: rawLine.replace(/^(\s*)[*+-•\u2022]\s+/, ''),
                isNested
              });
              i++;
            }
            elements.push(
              <div key={`ul-${i}`} style={{ margin: '3px 0 4px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                {listItems.map((li, liIdx) => (
                  <div key={liIdx} style={{ paddingLeft: li.isNested ? 24 : 14, lineHeight: 1.45 }}>
                    {renderInlineMarkdown(li.text)}
                  </div>
                ))}
              </div>
            );
            continue;
          }

          // Ordered List (standard markdown spec, multi-level indentation)
          if (/^\s*\d+\.\s+/.test(line)) {
            const listItems: Array<{ num: string; text: string; isNested: boolean }> = [];
            while (i < lines.length && /^\s*(\d+)\.\s+(.*)$/.test(lines[i])) {
              const rawLine = lines[i];
              const isNested = /^\s{2,}\d+\.\s+/.test(rawLine) || /^\t+\d+\.\s+/.test(rawLine);
              const lm = rawLine.match(/^\s*(\d+)\.\s+(.*)$/);
              if (lm) {
                listItems.push({ num: lm[1], text: lm[2], isNested });
              }
              i++;
            }
            elements.push(
              <div key={`ol-${i}`} style={{ margin: '3px 0 4px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                {listItems.map((li, liIdx) => (
                  <div key={liIdx} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, paddingLeft: li.isNested ? 24 : 14, lineHeight: 1.45 }}>
                    <span style={{ color: '#93c5fd', fontWeight: 600, fontFamily: 'monospace', minWidth: 18, flexShrink: 0 }}>
                      {li.num}.
                    </span>
                    <div style={{ flex: 1 }}>{renderInlineMarkdown(li.text)}</div>
                  </div>
                ))}
              </div>
            );
            continue;
          }

          // Regular paragraph / text line with line break preservation
          elements.push(
            <div key={`p-${i}`} style={{ margin: '2px 0', whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>
              {renderInlineMarkdown(line)}
            </div>
          );
          i++;
        }

        return <React.Fragment key={`sec-${secIdx}`}>{elements}</React.Fragment>;
      })}
    </div>
  );
}

// ============ TOOL LINES CLAMP (giới hạn hiển thị) ============
// USER yêu cầu: mọi tool trong UI hiển thị tối đa 200 dòng (nâng từ 90 → 200) — tránh khung tool phình
// vô hạn khi output dài nhưng vẫn đủ đầy đủ không gian theo dõi code/kết quả.
const MAX_TOOL_LINES = 200;
function clampToolLines(text: string, max: number = MAX_TOOL_LINES): { text: string; cut: number; total: number } {
  if (!text) return { text, cut: 0, total: 0 };
  const str = String(text);
  const lines = str.split('\n');
  const total = lines.length;
  if (total <= max) return { text: str, cut: 0, total };
  const kept = lines.slice(0, max).join('\n');
  return { text: `${kept}\n… (đã cắt ${total - max} dòng, tổng ${total} dòng)`, cut: total - max, total };
}

// ============ WRITE FILE VIEWER ============
// Hiển thị tool write dạng khung file đẹp: header nổi bật, nội dung code có expand/collapse, badge thành công.
function WriteFileViewer({ input, output, isMobile }: { input?: string; output?: string; isMobile?: boolean }) {
  const rawOut = typeof output === 'string' ? stripAnsi(output) : '';
  const rawInp = typeof input === 'string' ? stripAnsi(input) : '';

  // Parse JSON input để lấy filePath + content
  let filePath = '';
  let fileContent = '';
  try {
    const j = JSON.parse(rawInp);
    if (j && typeof j.filePath === 'string') filePath = j.filePath;
    else if (j && typeof j.path === 'string') filePath = j.path;
    if (typeof j.content === 'string') fileContent = j.content;
  } catch {}

  if (!filePath && rawInp && !rawInp.startsWith('{') && !rawInp.includes('\n')) {
    filePath = rawInp.trim();
  }

  // USER: giới hạn tối đa 90 dòng hiển thị (cắt TRƯỚC khi highlight/count)
  const clampedFile = clampToolLines(fileContent);
  const displayContent = clampedFile.text;
  const lines = displayContent.split('\n');
  const lineCount = lines.length;

  // Syntax highlight: lang từ filePath → highlight như CodeBlock; fallback plain nếu không hỗ trợ
  const lang = langFromPath(filePath);
  const supported = useMemo(() => isSupportedLang(lang), [lang]);
  const tokens = useMemo(() => (supported ? highlight(displayContent, lang) : []), [supported, displayContent, lang]);

  return (
    <div style={{ width: '100%', boxSizing: 'border-box' }}>
      <pre style={{
        margin: 0,
        padding: '8px 12px',
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
        fontSize: 11.5,
        fontWeight: 500,
        lineHeight: 1.48,
        letterSpacing: '0.2px',
        WebkitFontSmoothing: 'antialiased',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--text-primary)',
        maxWidth: '100%',
        boxSizing: 'border-box'
      }}>
        {supported ? (
          <code>{tokens.map((t, i) => (
            <span
              key={i}
              style={{
                color: t.color || undefined,
                fontStyle: t.italic ? 'italic' : undefined,
                fontWeight: t.bold ? 700 : undefined
              }}
            >
              {t.text}
            </span>
          ))}</code>
        ) : (
          displayContent || '(empty)'
        )}
      </pre>
      {/* Footer: badge thành công */}
      <div style={{
        padding: '4px 10px 6px',
        fontSize: 11,
        color: '#86efac',
        fontFamily: 'monospace',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderTop: '1px solid var(--af-border)',
        gap: 8
      }}>
        <span>✓ Ghi file thành công</span>
        <span style={{ color: 'var(--text-muted)' }}>{lineCount} dòng</span>
      </div>
    </div>
  );
}

// ============ READ FILE VIEWER ============
// Hiển thị kết quả tool read dạng khung file đẹp: bỏ XML thô (<path>/<content>), có header đường dẫn.
function ReadFileViewer({ input, output, isMobile }: { input?: string; output?: string; isMobile?: boolean }) {
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

  // USER: giới hạn tối đa 90 dòng hiển thị (cắt TRƯỚC khi highlight)
  const clamped = clampToolLines(code);
  const displayCode = clamped.text;

  // Syntax highlight: lang từ filePath → highlight như CodeBlock; fallback plain nếu không hỗ trợ
  const lang = langFromPath(filePath);
  const supported = useMemo(() => isSupportedLang(lang), [lang]);
  const tokens = useMemo(() => (supported ? highlight(displayCode, lang) : []), [supported, displayCode, lang]);

  return (
    <div style={{ width: '100%', boxSizing: 'border-box' }}>
      <pre style={{
        margin: 0,
        padding: '8px 12px',
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
        fontSize: 11.5,
        fontWeight: 500,
        lineHeight: 1.48,
        letterSpacing: '0.2px',
        WebkitFontSmoothing: 'antialiased',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--text-primary)',
        maxWidth: '100%',
        boxSizing: 'border-box'
      }}>
        {supported ? (
          <code>{tokens.map((t, i) => (
            <span
              key={i}
              style={{
                color: t.color || undefined,
                fontStyle: t.italic ? 'italic' : undefined,
                fontWeight: t.bold ? 700 : undefined
              }}
            >
              {t.text}
            </span>
          ))}</code>
        ) : (
          displayCode || rawOut || '(empty)'
        )}
      </pre>
      {/* Dòng tóm tắt chân khung */}
      {note && (
        <div style={{ padding: '4px 10px 6px', fontSize: 10.5, color: 'var(--text-muted)', fontFamily: 'monospace', borderTop: '1px solid var(--af-border)' }}>
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
  const rawOutText = typeof output === 'string' ? output : '';
  // USER: giới hạn tối đa 90 dòng hiển thị (cắt output trước khi render ANSI)
  const outText = clampToolLines(rawOutText).text;

  return (
    <div
      className="af-toolblock"
      style={{
      display: 'block',
      width: '100%',
      boxSizing: 'border-box',
      borderRadius: 10,
      border: '1px solid var(--toolblock-border, var(--af-border))',
      background: 'var(--toolblock-bg, var(--bg-card))',
      boxShadow: 'var(--toolblock-shadow, 0 4px 20px rgba(0, 0, 0, 0.35))',
      overflow: 'hidden',
      marginBottom: 6
    }}>
      {/* Header Prompt bar */}
      <div style={{
        padding: '5px 9px',
        background: 'var(--toolblock-head-bg, var(--bg-input))',
        borderBottom: '1px solid var(--toolblock-head-border, var(--af-border))',
        color: '#4ade80',
        fontWeight: 600,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
        fontSize: 11.5,
        wordBreak: 'break-all'
      }}>
        <span style={{ color: '#4ade80', fontWeight: 600, fontSize: 11 }}>$</span> <span style={{ color: 'var(--text-primary)', fontWeight: 500, fontSize: 11.5 }}>{command}</span>
      </div>
      {/* Output: giữ màu ANSI trên nền tối sâu, scroll tối đa 600px */}
      {outText && (
        <div style={{
          maxHeight: 600,
          overflowY: 'auto',
          overflowX: 'auto',
          width: '100%',
          maxWidth: '100%',
          boxSizing: 'border-box',
          background: 'var(--toolblock-code-bg, var(--bg-inset))',
          padding: '8px 12px',
          fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
          fontSize: 11.5,
          fontWeight: 500,
          lineHeight: 1.48,
          letterSpacing: '0.2px',
          WebkitFontSmoothing: 'antialiased',
          color: 'var(--text-primary)'
        }}>
          <AnsiRenderer text={outText} />
        </div>
      )}
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

  const allRows = rawOut.split(/\r?\n/)
    .map(l => l.replace(ANSI_NOISE_RE, '').replace(/[\u001b\u009b]/g, ''))
    .filter(l => l.trim() !== '');
  // USER: giới hạn tối đa 90 dòng hiển thị kết quả tìm kiếm
  const rows = allRows.slice(0, MAX_TOOL_LINES);
  const rowCut = allRows.length - rows.length;

  return (
    <div
      className="af-toolblock"
      style={{
      display: 'block',
      width: '100%',
      maxWidth: '100%',
      boxSizing: 'border-box',
      borderRadius: 10,
      border: '1px solid var(--toolblock-border, var(--af-border))',
      background: 'var(--toolblock-bg, var(--bg-card))',
      boxShadow: 'var(--toolblock-shadow, 0 4px 20px rgba(0, 0, 0, 0.35))',
      overflowX: 'auto',
      overflowY: 'hidden',
      marginBottom: 6
    }}>
      {/* Header: 🔍 TOOL pattern: "..." in path */}
      <div style={{
        padding: '5px 9px',
        background: 'var(--toolblock-head-bg, var(--bg-input))',
        borderBottom: '1px solid var(--toolblock-head-border, var(--af-border))',
        color: 'var(--text-primary)',
        fontWeight: 600,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
        fontSize: 11.5,
        wordBreak: 'break-all'
      }}>
        <span style={{ color: '#22d3ee', fontWeight: 600, fontSize: 11 }}>🔍 {String(tool).toUpperCase()}</span> <span style={{ color: 'var(--text-primary)', fontWeight: 500, fontSize: 11.5 }}>{pattern ? ` pattern: "${pattern}"` : ''}{sPath ? ` in ${sPath}` : ''}{include ? ` · ${include}` : ''}{rowCut > 0 ? ` · (${rowCut} dòng bị cắt, tổng ${allRows.length})` : ''}</span>
      </div>
      {/* Danh sách kết quả — scroll 600px */}
      <div style={{
        maxHeight: 600,
        overflowY: 'auto',
        overflowX: 'auto',
        width: '100%',
        maxWidth: '100%',
        boxSizing: 'border-box',
        background: 'var(--toolblock-code-bg, var(--bg-inset))',
        padding: '6px 4px'
      }}>
        {rows.length === 0 ? (
          <div style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: 11.5, color: 'var(--text-muted)' }}>(no results)</div>
        ) : rows.map((l, i) => {
          // grep -n style: "path/file.tsx:580:nội dung"
          const fm = l.match(/^([^\s:]+\.[A-Za-z0-9]{1,6}):(\d+):(.*)$/);
          if (fm) {
            return (
              <div key={i} style={{ display:'flex', gap:8, padding:'2px 8px', fontFamily:"'JetBrains Mono', monospace", fontSize:11.5, fontWeight:500, lineHeight:1.48 }}>
                <span style={{ color:'#38bdf8', flexShrink:0 }}>📄 {fm[1]}</span>
                <span style={{ color:'var(--text-muted)', flexShrink:0, minWidth:44, textAlign:'right' }}>{fm[2]}</span>
                <span style={{ color:'var(--text-primary)', whiteSpace:'pre-wrap', wordBreak:'break-word' }}>{fm[3]}</span>
              </div>
            );
          }
          // dòng có số thứ tự: "Line 580:" hoặc "580:"
          const lm = l.match(/^(?:Line\s*)?(\d+)\s*[:：]\s*([\s\S]*)$/i);
          if (lm) {
            return (
              <div key={i} style={{ display:'flex', gap:8, padding:'2px 8px', fontFamily:"'JetBrains Mono', monospace", fontSize:11.5, fontWeight:500, lineHeight:1.48 }}>
                <span style={{ color:'var(--text-muted)', flexShrink:0, minWidth:36, textAlign:'right' }}>{lm[1]}</span>
                <span style={{ color:'var(--text-primary)', whiteSpace:'pre-wrap', wordBreak:'break-word' }}>{lm[2]}</span>
              </div>
            );
          }
          // đường dẫn file / thư mục trần
          const isFile = /\.[A-Za-z0-9]{1,6}$/.test(l.trim()) && !l.includes(' ');
          return (
            <div key={i} style={{ padding:'2px 8px', fontFamily:"'JetBrains Mono', monospace", fontSize:11.5, fontWeight:500, lineHeight:1.48, color:'var(--text-primary)' }}>
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
          fontSize: 11,
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
  // USER: giới hạn tối đa 90 todo hiển thị
  const todoCut = todos.length - MAX_TOOL_LINES;
  const shownTodos = todos.slice(0, MAX_TOOL_LINES);
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
        📋 Task Checklist ({todos.length} tasks){todoCut > 0 ? ` · (${todoCut} bị cắt)` : ''}
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
        {shownTodos.map((t: any, i: number) => {
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

function renderToolBadge(tool: string, parsedInput: any, safeInput: string): React.ReactNode {
  const norm = String(tool || '').toLowerCase().trim();

  // Extract file path if present
  const filePath = (parsedInput && (typeof parsedInput.filePath === 'string' ? parsedInput.filePath : (typeof parsedInput.path === 'string' ? parsedInput.path : ''))) || '';

  if (norm === 'edit') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
        {extIcon(filePath)}
        <span style={{ color: '#fb923c', fontWeight: 600, fontSize: 11 }}>Edit:</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontWeight: 500, fontSize: 11.5 }}>{filePath || 'file'}</span>
      </span>
    );
  }

  if (norm === 'write' || norm === 'write_file' || norm === 'writefile' || norm === 'create_file' || norm === 'write_to_file' || norm === 'writefile') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
        {extIcon(filePath)}
        <span style={{ color: '#fde047', fontWeight: 600, fontSize: 11 }}>Write:</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontWeight: 500, fontSize: 11.5 }}>{filePath || 'file'}</span>
      </span>
    );
  }

  if (norm === 'read') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
        {extIcon(filePath)}
        <span style={{ color: '#38bdf8', fontWeight: 600, fontSize: 11 }}>Read:</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontWeight: 500, fontSize: 11.5 }}>{filePath || 'file'}</span>
      </span>
    );
  }

  if (norm === 'bash' || norm === 'shell' || norm === 'cmd') {
    const cmd = (parsedInput && (typeof parsedInput.command === 'string' ? parsedInput.command : (typeof parsedInput.cmd === 'string' ? parsedInput.cmd : ''))) || safeInput || '';
    const cleanCmd = cmd.trim().replace(/\r?\n/g, ' ');
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        <span>💻</span>
        <span style={{ color: '#4ade80', fontWeight: 600, fontSize: 11 }}>Bash:</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontWeight: 500, fontSize: 11.5, maxWidth: 360 }}>{cleanCmd || 'command'}</span>
      </span>
    );
  }

  if (norm === 'glob') {
    const pattern = (parsedInput && typeof parsedInput.pattern === 'string' ? parsedInput.pattern : '') || '';
    const path = (parsedInput && typeof parsedInput.path === 'string' ? parsedInput.path : '') || '';
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        <span>📁</span>
        <span style={{ color: '#22d3ee', fontWeight: 600, fontSize: 11 }}>Glob:</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontWeight: 500, fontSize: 11.5 }}>{pattern || '*'}{path ? ` in ${path}` : ''}</span>
      </span>
    );
  }

  if (norm === 'grep') {
    const pattern = (parsedInput && typeof parsedInput.pattern === 'string' ? parsedInput.pattern : '') || '';
    const path = (parsedInput && typeof parsedInput.path === 'string' ? parsedInput.path : '') || '';
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        <span>🔍</span>
        <span style={{ color: '#f472b6', fontWeight: 600, fontSize: 11 }}>Grep:</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontWeight: 500, fontSize: 11.5 }}>/{pattern}/{path ? ` in ${path}` : ''}</span>
      </span>
    );
  }

  if (norm === 'searcher' || norm === 'search') {
    const query = (parsedInput && (typeof parsedInput.pattern === 'string' ? parsedInput.pattern : (typeof parsedInput.query === 'string' ? parsedInput.query : ''))) || '';
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        <span>🔍</span>
        <span style={{ color: '#f472b6', fontWeight: 600, fontSize: 11 }}>Search:</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontWeight: 500, fontSize: 11.5 }}>{query || 'query'}</span>
      </span>
    );
  }

  if (norm.includes('fetch') || norm.includes('webfetch')) {
    const url = (parsedInput && (typeof parsedInput.url === 'string' ? parsedInput.url : (typeof parsedInput.link === 'string' ? parsedInput.link : ''))) || '';
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        <span>🌐</span>
        <span style={{ color: '#38bdf8', fontWeight: 600, fontSize: 11 }}>Fetch:</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontWeight: 500, fontSize: 11.5, maxWidth: 320 }}>{url || 'url'}</span>
      </span>
    );
  }

  if (norm.includes('web_search') || norm.includes('websearch')) {
    const query = (parsedInput && (typeof parsedInput.query === 'string' ? parsedInput.query : (typeof parsedInput.q === 'string' ? parsedInput.q : ''))) || '';
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        <span>🌐</span>
        <span style={{ color: '#38bdf8', fontWeight: 600, fontSize: 11 }}>WebSearch:</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontWeight: 500, fontSize: 11.5 }}>{query || 'search'}</span>
      </span>
    );
  }

  if (norm === 'todowrite' || norm.includes('todo')) {
    const count = Array.isArray(parsedInput?.todos) ? parsedInput.todos.length : '';
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        <span>📋</span>
        <span style={{ color: '#fb923c', fontWeight: 600, fontSize: 11 }}>TodoList:</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontWeight: 500, fontSize: 11.5 }}>{count ? `${count} tasks` : 'update'}</span>
      </span>
    );
  }

  if (norm === 'skill') {
    const name = (parsedInput && typeof parsedInput.name === 'string' ? parsedInput.name : '') || '';
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        <span>⚡</span>
        <span style={{ color: '#facc15', fontWeight: 600, fontSize: 11 }}>Skill:</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontWeight: 500, fontSize: 11.5 }}>{name || 'custom'}</span>
      </span>
    );
  }

  // Fallback
  const target = filePath || (parsedInput && typeof parsedInput.target === 'string' ? parsedInput.target : '') || '';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
      <span>🔧</span>
      <span style={{ color: '#38bdf8', fontWeight: 600, fontSize: 11 }}>{String(tool || 'tool')}:</span>
      {target && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontWeight: 500, fontSize: 11.5 }}>{target}</span>}
    </span>
  );
}

function ToolCallBlock({ tool, input, output, isMobile }: ToolCallData & { isMobile?: boolean }) {
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
  // USER: giới hạn tối đa 90 dòng hiển thị (cắt content dùng cho lineCount/fallback)
  const clampedContent = clampToolLines(content);
  const displayContent = clampedContent.text;
  const lineCount = Math.max(1, displayContent.split('\n').length);

  // Git-style diff cho tool edit: parse input lấy {filePath, oldString, newString}
  const parsedInput = parseToolInputObject(safeInput);
  const isEditDiff =
    safeTool === 'edit' ||
    !!(parsedInput && ('oldString' in parsedInput || 'newString' in parsedInput));

  // ReadFileViewer cho tool read (hoặc output chứa khối <content>)
  const isReadView = safeTool === 'read' || /<content>/i.test(rawOutput);

  // WriteFileViewer cho tool write / write_file / create_file
  const isWriteView =
    safeTool === 'write' ||
    safeTool === 'write_file' ||
    safeTool === 'writefile' ||
    safeTool === 'create_file' ||
    safeTool === 'write_to_file' ||
    (!isEditDiff && !isReadView && parsedInput && typeof parsedInput.filePath === 'string' && typeof parsedInput.content === 'string');
  // BashCommandViewer cho tool bash/shell — dạng terminal $ command + output màu
  const isBashView = safeTool === 'bash' || safeTool === 'shell';

  // SearchCommandViewer cho glob/grep/searcher — GitHub-style kết quả tìm kiếm
  const isSearchView = safeTool === 'glob' || safeTool === 'grep' || safeTool === 'searcher';

  // Edit: lang từ filePath → syntax highlight cho dòng THÊM (+), giống Write/Read (fallback plain).
  const editFilePath = parsedInput && typeof parsedInput.filePath === 'string' ? parsedInput.filePath : '';
  const editLang = langFromPath(editFilePath);
  const editSupported = useMemo(() => isSupportedLang(editLang), [editLang]);

  const targetFilePath =
    editFilePath ||
    (parsedInput && (typeof parsedInput.filePath === 'string' ? parsedInput.filePath : (typeof parsedInput.path === 'string' ? parsedInput.path : ''))) ||
    '';
  const targetLang = targetFilePath ? langFromPath(targetFilePath) : '';

  const oldLines: string[] =
    isEditDiff && parsedInput && typeof parsedInput.oldString === 'string' && parsedInput.oldString !== ''
      ? clampToolLines(parsedInput.oldString).text.split('\n')
      : [];
  const newLines: string[] =
    isEditDiff && parsedInput && typeof parsedInput.newString === 'string' && parsedInput.newString !== ''
      ? clampToolLines(parsedInput.newString).text.split('\n')
      : [];

  // Mặc định COLLAPSED (thu gọn, hiện hint click để mở) — user bấm/click header để mở rộng.
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const copyText =
      isEditDiff && parsedInput && typeof parsedInput.newString === 'string'
        ? parsedInput.newString
        : (isWriteView && parsedInput && typeof parsedInput.content === 'string')
        ? parsedInput.content
        : rawOutput || safeInput || content;
    if (!copyText) return;
    navigator.clipboard.writeText(copyText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  return (
    <div
      className="af-toolblock"
      style={{
      display: 'block',
      width: '100%',
      maxWidth: '100%',
      boxSizing: 'border-box',
      borderRadius: 10,
      border: '1px solid var(--toolblock-border, var(--af-border))',
      background: 'var(--toolblock-bg, var(--bg-card))',
      boxShadow: 'var(--toolblock-shadow, 0 4px 20px rgba(0, 0, 0, 0.35))',
      overflowX: 'auto',
      overflowY: 'hidden',
      marginBottom: 6
    }}>
      {/* Header DUY NHẤT 1 DÒNG: badge tên tool + target path + lang + nút Copy + nút Thu/Phóng */}
      <div
        className="af-toolblock-head"
        onClick={() => setExpanded(e => !e)}
        role="button"
        aria-expanded={expanded}
        title={expanded ? 'Thu gọn' : 'Mở rộng'}
        style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '5px 10px',
        background: 'var(--toolblock-head-bg, var(--bg-input))',
        borderBottom: expanded ? '1px solid var(--toolblock-head-border, var(--af-border))' : 'none',
        position: 'sticky',
        top: 0,
        cursor: 'pointer',
        userSelect: 'none'
      }}>
        {/* Bên trái: Badge loại tool + Tên/Đường dẫn tệp tin */}
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          fontSize: 11,
          fontWeight: 600,
          background: 'rgba(255, 255, 255, 0.05)',
          border: '1px solid var(--af-border)',
          borderRadius: 9999,
          padding: '2px 8px',
          fontFamily: 'monospace',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: '70%'
        }}>
          {renderToolBadge(safeTool, parsedInput, safeInput)}
        </span>

        {/* Bên phải: Ngôn ngữ nhỏ gọn + Nút Copy + Nút Thu/Phóng */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {targetLang && (
            <span style={{
              fontSize: 9.5,
              fontWeight: 700,
              padding: '1px 5px',
              borderRadius: 3,
              background: 'rgba(255, 255, 255, 0.08)',
              color: 'var(--text-secondary)',
              fontFamily: 'monospace',
              textTransform: 'uppercase'
            }}>
              {targetLang}
            </span>
          )}
          <button
            onClick={handleCopy}
            style={{
              background: copied ? 'rgba(34, 197, 94, 0.15)' : 'rgba(148, 163, 184, 0.12)',
              border: copied ? '1px solid rgba(34, 197, 94, 0.35)' : '1px solid var(--af-border)',
              color: copied ? '#4ade80' : 'var(--text-secondary)',
              borderRadius: 4,
              padding: '1px 6px',
              fontSize: 10,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              fontFamily: 'monospace',
              fontWeight: 600,
              transition: 'all 0.15s ease'
            }}
            title="Sao chép nội dung"
          >
            <span>{copied ? '✓' : '📋'}</span>
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
          <span
            onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
            style={{
              background: 'rgba(148, 163, 184, 0.15)',
              border: '1px solid rgba(148, 163, 184, 0.3)',
              color: 'var(--text-primary)',
              borderRadius: 4,
              padding: '1px 6px',
              fontSize: 10,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'monospace'
            }}
            role="button"
            aria-label={expanded ? 'Thu gọn' : 'Mở rộng'}
          >
            {expanded ? 'Collapse' : `Expand (${lineCount} dòng)`}
          </span>
        </div>
      </div>
      {/* Body: monospace 11.5px, scroll tối đa 600px khi mở */}
      {expanded && (
        <div
          className="af-toolblock-body"
          style={{
          maxHeight: 600,
          overflowY: 'auto',
          overflowX: 'hidden',
          width: '100%',
          maxWidth: '100%',
          boxSizing: 'border-box',
          padding: '8px 12px',
          background: 'var(--toolblock-code-bg, var(--bg-inset))',
          fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
          fontSize: 11.5,
          fontWeight: 500,
          lineHeight: 1.48,
          letterSpacing: '0.2px',
          WebkitFontSmoothing: 'antialiased',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: 'var(--text-primary)'
        }}>
          {isEditDiff && parsedInput && ((oldLines.length > 0 || newLines.length > 0) || typeof parsedInput.filePath === 'string') ? (
            /* GIT-STYLE DIFF VIEW (context-aware) — không lặp lại header file */
            <div style={{ maxHeight: 600, overflowY: 'auto', overflowX: 'auto', width: '100%', maxWidth: '100%', boxSizing: 'border-box' }}>
              {computeDiffRows(
                oldLines.join('\n'),
                newLines.join('\n')
              ).map((row, i) =>
                row.type === 'ctx'
                  ? <ContextLine key={`c${i}`} text={row.text} />
                  : <DiffLine key={`d${i}`} sign={row.type === 'del' ? '-' : '+'} text={row.text}
                      tokens={row.type === 'add' && editSupported ? highlight(row.text, editLang) : undefined} />
              )}
              {/* Footer trạng thái: badge thành công + số dòng thêm/xóa */}
              <div style={{
                padding: '4px 10px 6px',
                fontSize: 11,
                color: '#86efac',
                fontFamily: 'monospace',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8
              }}>
                <span>✓ Sửa file thành công</span>
                <span style={{ color: '#94a3b8' }}>
                  +{newLines.length} −{oldLines.length} dòng
                </span>
              </div>
            </div>
          ) : isWriteView ? (
            /* WRITE FILE VIEWER — header nổi bật + expand/collapse + badge thành công */
            <WriteFileViewer input={safeInput} output={rawOutput} isMobile={isMobile} />
          ) : isReadView ? (
            /* READ FILE VIEWER — khung file đẹp thay XML thô */
            <ReadFileViewer input={safeInput} output={rawOutput} isMobile={isMobile} />
          ) : isBashView ? (
            /* BASH COMMAND VIEWER — $ command + output màu ANSI */
            <BashCommandViewer input={safeInput} output={rawOutput} />
          ) : isSearchView ? (
            /* SEARCH COMMAND VIEWER — GitHub-style cho glob/grep/searcher */
            <SearchCommandViewer tool={tool} input={safeInput} output={rawOutput} />
          ) : (
            content ? <AnsiRenderer text={displayContent} /> : '(empty)'
          )}
        </div>
      )}
    </div>
  );
}

// ============ THINKING BLOCK ============
// Hiển thị suy luận nội tại của model, kiểu coding-agent: block mềm, nền nhẹ, tối giản.
// Mặc định thu gọn thành 1 dòng có nhãn rõ ràng + nút mở rộng. Chữ đọc rõ, tương phản tốt.
function ThinkingBlock({ thinking }: { thinking: string }) {
  const [expanded, setExpanded] = useState(false);

  // Preview: trích 1 dòng gọn đầu tiên, cắt tại 500 ký tự
  const preview = thinking.split('\n').map(l => l.trim()).filter(Boolean)[0] || thinking.slice(0, 500);

  return (
    <div
      className="af-thinking"
      onClick={() => setExpanded(e => !e)}
      style={{
        display: 'block',
        width: '100%',
        maxWidth: '100%',
        boxSizing: 'border-box',
        borderRadius: 8,
        background: 'rgba(30,41,59,0.35)',
        border: '1px solid rgba(99,102,241,0.25)',
        overflow: 'hidden',
        cursor: 'pointer',
        marginBottom: 4
      }}
    >
      {/* Header: nhãn rõ ràng + nút mở rộng — KHÔNG hiển thị dòng rỗng. Toggle do root container xử lý (click cả vùng). */}
      <div
        role="button"
        aria-expanded={expanded}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '6px 10px',
          cursor: 'pointer',
          userSelect: 'none'
        }}
      >
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          color: '#cbd5e1',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          letterSpacing: '0.02em'
        }}>
          <span style={{ fontSize: 11, opacity: 0.8 }}>🧠</span>
          {expanded ? 'Thinking' : 'Đã suy nghĩ'}
        </span>
        <span style={{
          fontSize: 10,
          color: '#94a3b8',
          fontFamily: 'monospace',
          flexShrink: 0,
          fontWeight: 500,
          display: 'inline-flex',
          alignItems: 'center'
        }}>
          {expanded ? '▲ Thu gọn' : '▼'}
        </span>
      </div>

      {/* Collapsed: 1 dòng gọn, chữ rõ ràng — không hiển thị dòng rỗng/cục tròn xấu */}
      {!expanded && preview && (
        <div style={{
          padding: '0 10px 7px',
          fontSize: 11.5,
          color: '#b6c2d1',
          lineHeight: 1.5,
          fontWeight: 450,
          opacity: 1,
          overflow: 'hidden',
          maxHeight: 20,
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          cursor: 'pointer'
        }}>
          {preview}
        </div>
      )}

      {/* Expanded: card nền mờ nhẹ kiểu coding-agent, scroll vừa phải (200-240px), chữ sáng rõ */}
      {expanded && (
        <div style={{
          width: '100%',
          padding: '9px 12px',
          borderTop: '1px solid rgba(148,163,184,0.14)',
          background: 'rgba(15,23,42,0.75)',
          color: '#d7dee9',
          fontSize: 12.5,
          fontWeight: 420,
          lineHeight: 1.7,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 600,
          overflowY: 'auto'
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
  const isStopUser = msg.msgType === 'stop_user';
  const isStopOrchestrator = msg.msgType === 'stop_orchestrator';
  const isStopError = msg.msgType === 'stop_error';
  const isOrchestratorPlanning = isOrchestrator && /(?:\[TALK\]|\[SPAWN\]|^\[TASK\]|^\[RESEARCH\]|^\[VERIFICATION\])/i.test(msg.content || '');
  const isOrchestratorInternal = msg.msgType === 'orchestrator_internal';
  // Lệnh giao task của Orchestrator (spawn/talk do server tạo): render thành CỤC RIÊNG distinct,
  // kèm receiver là agent. KHÔNG lẫn vào bubble chat thường.
  const isOrchestratorTask = isOrchestrator && msg.msgType === 'talk' && msg.to && msg.to !== 'user' && msg.to !== 'broadcast';

  let sender = msg.from;
  let senderColor = '#38bdf8';
  let roleBadge = '';
  let srcAgent: AgentInfo | undefined;
  let targetAgent: AgentInfo | undefined;

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
    srcAgent = agents.find(a => a.id === msg.from || a.name === msg.from);
    if (srcAgent) {
      sender = srcAgent.name;
      roleBadge = srcAgent.role || 'agent';
    } else {
      sender = msg.from;
    }
    senderColor = '#34d399';
  }

  // Parse and strip internal prompt wrappers ([TEAM]...[/TEAM], [TASK], === INCOMING MESSAGE ===, === SYSTEM REMINDER ===, etc.)
  let rawContent: string = msg.content || '';
  if (rawContent.includes('=== INCOMING MESSAGE ===') && rawContent.includes('=== MESSAGE ===')) {
    const msgIdx = rawContent.indexOf('=== MESSAGE ===');
    let inner = rawContent.substring(msgIdx + '=== MESSAGE ==='.length);
    const remIdx = inner.indexOf('=== SYSTEM REMINDER ===');
    if (remIdx !== -1) inner = inner.substring(0, remIdx);
    rawContent = inner.trim();
  }
  
  if (rawContent.includes('[TEAM]') && rawContent.includes('[/TEAM]')) {
    rawContent = rawContent.replace(/\[TEAM\][\s\S]*?\[\/TEAM\]/g, '').trim();
  }
  rawContent = rawContent.replace(/\[TASK\][^\n]*\n?/g, '').trim();
  if (rawContent.includes('=== SYSTEM REMINDER ===')) {
    const sRemIdx = rawContent.indexOf('=== SYSTEM REMINDER ===');
    rawContent = rawContent.substring(0, sRemIdx).trim();
  }
  if (rawContent.includes('=== INCOMING MESSAGE ===')) {
    rawContent = rawContent.replace(/=== INCOMING MESSAGE ===[\s\S]*?=== MESSAGE ===/g, '').trim();
  }

  // Parse [TO: xxx] prefix or <talk target="..."> prefix
  let toTag: string | null = null;
  const toMatch = rawContent.match(/^\s*\[TO:\s*([^\]]+)\]\s*/iu);
  if (toMatch) {
    toTag = toMatch[1].trim();
  } else {
    const xmlTalkMatch = rawContent.match(/^\s*<talk\s+[^>]*\btarget\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/iu);
    if (xmlTalkMatch) {
      toTag = (xmlTalkMatch[1] || xmlTalkMatch[2] || xmlTalkMatch[3] || '').trim();
    }
  }
  let body = rawContent
    .replace(/^\s*(?:\[FROM:\s*[^\]]+\]\s*)?\[TO:\s*[^\]]+\]\s*/iu, '')
    .replace(/^\s*<talk\b[^>]*>\s*/iu, '');
  body = isUser ? body : stripTalkTags(body);
  if (isOrchestratorInternal && !msg.showOnUI) {
    body = '_(Internal orchestrator planning hidden)_';
  }
  const effectiveTo = msg.to && msg.to !== 'user' ? msg.to : toTag;

  // Resolve target display
  let displayTo = effectiveTo;
  if (effectiveTo) {
    if (effectiveTo === 'orchestrator') {
      displayTo = 'Orchestrator';
    } else if (effectiveTo === 'user') {
      displayTo = 'You';
    } else {
      targetAgent = agents.find(a => a?.id === effectiveTo || ((a?.name || '').toLowerCase() === String(effectiveTo).toLowerCase()));
      if (targetAgent) {
        displayTo = targetAgent.name;
      }
    }
  }

  // Resolve task label for header with full defensive guards
  let rawTaskStr = '';
  if (typeof (msg as any)?.task === 'string' && (msg as any).task.trim()) {
    rawTaskStr = (msg as any).task;
  } else if (typeof (msg as any)?.taskName === 'string' && (msg as any).taskName.trim()) {
    rawTaskStr = (msg as any).taskName;
  } else if (srcAgent && srcAgent.type !== 'orchestrator' && srcAgent.id !== 'orchestrator' && typeof srcAgent.task === 'string' && srcAgent.task.trim()) {
    rawTaskStr = srcAgent.task;
  } else if (targetAgent && targetAgent.type !== 'orchestrator' && targetAgent.id !== 'orchestrator' && typeof targetAgent.task === 'string' && targetAgent.task.trim()) {
    rawTaskStr = targetAgent.task;
  }

  const cleanTaskTitle = rawTaskStr
    ? rawTaskStr.split('\n')[0].replace(/^#?\d+[\.:\s-]*\s*/, '').replace(/^\[(?:working|pending|completed|blocked)\]\s*/i, '').replace(/^(?:⚙️|⏳|✅|⚠️|⚡|🎯)\s*/, '').trim()
    : '';

  // Visual Bubble Themes — Full Flat Conversation Style (Cursor / Claude / v0 style)
  let bubbleBg = 'transparent';
  let bubbleBorder = 'none';
  let textColor = 'var(--text-primary)';
  let bubbleShadow = 'none';

  if (isOpenCode) {
    bubbleBg = 'var(--bg-inset)';
    bubbleBorder = '1px solid var(--af-border)';
    textColor = 'var(--text-secondary)';
    bubbleShadow = 'none';
  } else if (isOrchestratorTask) {
    // Cục riêng cho lệnh giao task của Orchestrator — nền/viền chàm accent, dễ nhận diện
    bubbleBg = 'rgba(99, 102, 241, 0.07)';
    bubbleBorder = '1px solid rgba(99, 102, 241, 0.45)';
    textColor = 'var(--text-primary)';
    bubbleShadow = '0 2px 12px rgba(99, 102, 241, 0.12)';
  } else if (isUser) {
    bubbleBg = 'rgba(59, 130, 246, 0.08)';
    bubbleBorder = '1px solid rgba(59, 130, 246, 0.2)';
    textColor = 'var(--text-primary)';
    bubbleShadow = 'none';
  } else if (isError || isStopError) {
    bubbleBg = 'rgba(239, 68, 68, 0.08)';
    bubbleBorder = '1px solid rgba(239, 68, 68, 0.25)';
    textColor = '#f87171';
    bubbleShadow = 'none';
  } else if (isQueued) {
    bubbleBg = 'rgba(245, 158, 11, 0.08)';
    bubbleBorder = '1px solid rgba(245, 158, 11, 0.25)';
    textColor = 'var(--text-primary)';
  } else if (isStopUser || isStopOrchestrator) {
    bubbleBg = 'rgba(234, 179, 8, 0.08)';
    bubbleBorder = '1px solid rgba(234, 179, 8, 0.25)';
    textColor = 'var(--text-primary)';
  }

  const formattedTime = formatTimestamp(msg.timestamp);
  const fullDateTime = formatFullDate(msg.timestamp);

  // Split conversation text and structured report card
  const splitResult = useMemo(() => {
    return isUser ? { conversationText: body, hasReport: false } : splitReportAndConversation(body);
  }, [body, isUser]);

  const { conversationText, hasReport, reportTitle, reportContent } = splitResult;

  // Tin có toolCalls (hoặc log opencode) — các khối tool/thinking render ĐỘC LẬP ngoài bubble
  const hasToolBlocks = showToolBlocks && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0;
  // Option C: server gửi msg.parts (text + tool xen kẽ theo đúng thứ tự emit). Nếu có → render interleaved,
  // bỏ qua Khối 2 (toolCalls block riêng) + Khối 3 (bubble text) để không in trùng.
  const hasParts = Array.isArray((msg as any).parts) && (msg as any).parts.length > 0;
  const isRawCommandOutput = isOpenCode && /(?:<talk\s+|<spawn\s+|\[TALK\s+|\[SPAWN\s+|===\s*(?:TASK|ERROR|VERIFICATION)\s+REPORT\s*===)/i.test(msg.content || '');
  // Guard bubble rỗng: message chỉ có thinking/toolCall (content rỗng) KHÔNG tạo bubble text rỗng (cục tròn)
  const hasBubbleContent = !!body && String(body).trim().length > 0;

  if (isOrchestratorInternal && msg.from === 'orchestrator' && !msg.showOnUI) {
    return null;
  }

  if (isOpenCode && isRawCommandOutput && !hasToolBlocks && (!msg.thinking || !String(msg.thinking).trim())) {
    return null;
  }

  // Guard tin nhắn rỗng: nếu sau khi làm sạch không còn conversationText, không có report,
  // không có body, không có thinking, không có toolCalls và không có parts -> ẨN TOÀN BỘ MessageItem,
  // tránh sinh ra header mồ côi (chỉ hiện tên người gửi mà không có bong bóng nội dung nào).
  const hasAnyThinking = typeof msg.thinking === 'string' && msg.thinking.trim().length > 0;
  const hasAnyText = !!(conversationText && conversationText.trim()) || !!(hasReport && reportContent && reportContent.trim()) || !!(body && body.trim());
  const hasAnyContent = hasAnyText || hasAnyThinking || hasToolBlocks || hasParts;

  if (!hasAnyContent) {
    return null;
  }

  return (
    <div
      className="fade-in"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
        minWidth: 0,
        overflowWrap: 'anywhere',
        // Fix copy 6.33: chặn selection lan sang cả khối (sender header/tool thinking header là
        // tiện ích không cần copy). Root kế thừa none; các bubble content element bên dưới
        // override userSelect:'text' để user vẫn chọn được đúng text tin nhắn, không nhảy ra
        // toàn bộ panel/block khi kéo qua nhiều tin liền kề.
        userSelect: 'none'
      }}
    >
      {/* Sender Header: Clean, Spacious, High-Contrast Routing Pills */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 11,
        marginBottom: 6,
        fontWeight: 600,
        paddingLeft: isUser ? 0 : 2,
        paddingRight: isUser ? 2 : 0,
        flexDirection: isUser ? 'row-reverse' : 'row',
        flexWrap: 'nowrap',
        overflowX: 'auto',
        maxWidth: '100%',
        scrollbarWidth: 'none'
      }}>
        {/* Sender Capsule Pill */}
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 10px',
          borderRadius: 9999,
          fontSize: 11,
          fontWeight: 700,
          whiteSpace: 'nowrap',
          background: isUser
            ? 'rgba(59, 130, 246, 0.22)'
            : isOrchestrator
            ? 'rgba(99, 102, 241, 0.22)'
            : 'rgba(16, 185, 129, 0.22)',
          border: isUser
            ? '1px solid rgba(96, 165, 250, 0.5)'
            : isOrchestrator
            ? '1px solid rgba(129, 140, 248, 0.5)'
            : '1px solid rgba(52, 211, 153, 0.5)',
          color: isUser ? '#dbeafe' : isOrchestrator ? '#e0e7ff' : '#d1fae5'
        }}>
          {isOrchestrator && <span>👑</span>}
          {isUser && <span>👤</span>}
          {!isOrchestrator && !isUser && <span>🤖</span>}
          <span>{sender}</span>
          {!isOrchestrator && !isUser && roleBadge && (
            <span style={{ opacity: 0.85, fontWeight: 600, fontSize: 10 }}>· {roleBadge}</span>
          )}
        </span>

        {/* Direction Arrow & Receiver Capsule Pill */}
        {displayTo && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span style={{ color: '#a5b4fc', fontWeight: 800, fontSize: 13, lineHeight: 1 }}>➜</span>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '3px 10px',
              borderRadius: 9999,
              fontSize: 11,
              fontWeight: 700,
              whiteSpace: 'nowrap',
              background: 'rgba(148, 163, 184, 0.18)',
              border: '1px solid rgba(203, 213, 225, 0.45)',
              color: '#f8fafc'
            }}>
              {String(displayTo || '').toLowerCase() === 'you' || String(displayTo || '').toLowerCase() === 'user' ? <span>👤</span> : <span>🤖</span>}
              <span>{displayTo}</span>
            </span>
          </span>
        )}

        {/* Task Capsule Pill */}
        {cleanTaskTitle && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 8px',
              borderRadius: 6,
              background: 'rgba(59, 130, 246, 0.12)',
              border: '1px solid rgba(59, 130, 246, 0.25)',
              color: 'var(--af-primary, #60a5fa)',
              fontSize: 11,
              fontWeight: 500,
              maxWidth: 280,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flexShrink: 1
            }}
            title={`Nhiệm vụ: ${cleanTaskTitle}`}
          >
            <span>🎯</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {cleanTaskTitle}
            </span>
          </span>
        )}

        {/* Monospace Timestamp */}
        {formattedTime && (
          <span
            style={{
              color: 'var(--text-muted)',
              fontSize: 10,
              fontWeight: 500,
              fontFamily: 'monospace',
              opacity: 0.85,
              flexShrink: 0,
              marginLeft: isUser ? 0 : 4,
              marginRight: isUser ? 4 : 0
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
          maxWidth: isMobile ? '98%' : '100%',
          alignSelf: isUser ? 'flex-end' : 'flex-start',
          marginBottom: 4,
          userSelect: 'text'
        }}>
          <ThinkingBlock thinking={msg.thinking} />
        </div>
      )}

      {/* Khối 2: ToolCallBlocks — các hộp công cụ độc lập, NGOÀI bubble (bỏ qua khi đã render interleaved parts) */}
      {!hasParts && showToolBlocks && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0 && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          maxWidth: isMobile ? '98%' : '100%',
          alignSelf: isUser ? 'flex-end' : 'flex-start',
          marginBottom: 4,
          userSelect: 'text'
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
                <ToolCallBlock tool={safe.tool} input={safe.input} output={safe.output} isMobile={isMobile} />
              </ToolBlockSafe>
            );
          })}
        </div>
      )}

      {/* Khối 2.5: Option C — render parts xen kẽ text + tool theo ĐÚNG thứ tự opencode emit.
          Server gửi msg.parts = [ {type:'text',content}, {type:'tool',tool,input,output}, ... ].
          Text segment render như bubble text; tool segment render ToolCallBlock. */}
      {hasParts && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          maxWidth: isMobile ? '98%' : '100%',
          alignSelf: isUser ? 'flex-end' : 'flex-start',
          gap: 4,
          userSelect: 'text'
        }}>
          {((msg as any).parts as any[]).map((part, i) => {
            if (!part) return null;
            if (part.type === 'tool') {
              const safeTool = {
                tool: typeof part.tool === 'string' && part.tool ? part.tool : 'tool',
                input: part.input === undefined || part.input === null ? undefined : String(part.input),
                output: part.output === undefined || part.output === null ? undefined : String(part.output)
              };
              return (
                <div key={'pt-' + i} style={{ width: '100%', maxWidth: isMobile ? '98%' : '100%' }}>
                  <ToolBlockSafe>
                    <ToolCallBlock tool={safeTool.tool} input={safeTool.input} output={safeTool.output} isMobile={isMobile} />
                  </ToolBlockSafe>
                </div>
              );
            }
            // Fix interleave 6.44 (rework 6.33): GIỮ render text segments của snapshot opencode trong
            // Khối 2.5 để xen kẽ text + tool ĐÚNG thứ tự emit. Server giờ giữ text+tool trong parts.
            // text không nhân đôi vì Khối 2 + Khối 3 bị ẩn khi hasParts, và canonical reply trùng được
            // lọc ở agent view (App.tsx). Đoạn text dạng "TYPE: ..." (assistant/user/system metadata)
            // được bỏ tiền tố TYPE để hiển thị sạch; event text thô giữ nguyên.
            let segText = String(part.content || '');
            if (!segText) return null;
            // Bỏ tiền tố "TYPE: " (ASSISTANT:/USER:/SYSTEM:...) trên segment text meta — hiển thị nội dung thật
            if (isOpenCode && /^[A-Z_]+:\s/u.test(segText) && !/^✖|^◆/u.test(segText)) {
              segText = segText.replace(/^[A-Z_]+:\s?/u, '');
            }
            if (!String(segText).trim()) return null;

            // Bóc tách cấu trúc report nếu segment này chứa <report>...</report> hoặc === TASK REPORT ===
            const segSplit = splitReportAndConversation(segText);
            const segConvText = segSplit.conversationText;
            const segHasReport = segSplit.hasReport;
            const segReportTitle = segSplit.reportTitle;
            const segReportContent = segSplit.reportContent;

            return (
              <div
                key={'pt-' + i}
                className={`af-bubble${isUser ? ' af-bubble-user' : ''}`}
                style={{
                background: (isUser || isOrchestratorTask) ? bubbleBg : 'transparent',
                color: textColor,
                padding: (isUser || isOrchestratorTask) ? '10px 14px' : '10px 0',
                borderRadius: 12,
                width: 'fit-content',
                maxWidth: '100%',
                minWidth: 0,
                overflowWrap: 'anywhere',
                boxSizing: 'border-box',
                fontSize: isOpenCode ? 12 : (isMobile ? 12 : 12.5),
                lineHeight: 1.45,
                whiteSpace: isOpenCode ? 'pre-wrap' : 'normal',
                fontFamily: isOpenCode ? 'monospace' : 'inherit',
                border: (isUser || isOrchestratorTask) ? bubbleBorder : 'none',
                boxShadow: (isUser || isOrchestratorTask) ? bubbleShadow : 'none',
                wordBreak: 'break-word',
                position: 'relative'
              }}>
                {isOpenCode ? (
                  <div style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {segText}
                  </div>
                ) : (
                  <>
                    {segConvText ? <MarkdownRenderer content={segConvText} isMobile={isMobile} /> : null}
                    {segHasReport && segReportContent ? (
                      <div style={{ marginTop: segConvText ? 10 : 0 }}>
                        <ReportCard
                          title={segReportTitle || 'Structured Task Report'}
                          content={segReportContent}
                        />
                      </div>
                    ) : null}
                    {!segConvText && !segHasReport && segText ? (
                      <MarkdownRenderer content={segText} isMobile={isMobile} />
                    ) : null}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Khối 3: Bubble text — dạng flat stream chuyên nghiệp. Chỉ render khi có nội dung text thật */}
      {!hasParts && (hasBubbleContent && (!isOpenCode || !isRawCommandOutput || (!hasToolBlocks && (!msg.thinking || !String(msg.thinking).trim())))) && (
        <div
          className={`af-bubble${isUser ? ' af-bubble-user' : ''}`}
          style={{
          background: (isUser || isOrchestratorTask) ? bubbleBg : 'transparent',
          color: textColor,
          padding: (isUser || isOrchestratorTask) ? '10px 14px' : '10px 0',
          borderRadius: 12,
          width: 'fit-content',
          maxWidth: isMobile ? '98%' : '100%',
          minWidth: 0,
          overflowWrap: 'anywhere',
          boxSizing: 'border-box',
          fontSize: isOpenCode ? 12 : 12.5,
          lineHeight: 1.45,
          whiteSpace: isOpenCode ? 'pre-wrap' : 'normal',
          fontFamily: isOpenCode ? 'monospace' : 'inherit',
          border: (isUser || isOrchestratorTask) ? bubbleBorder : 'none',
          boxShadow: (isUser || isOrchestratorTask) ? bubbleShadow : 'none',
          wordBreak: 'break-word',
          position: 'relative',
          userSelect: 'text'
        }}>
          {isOrchestratorTask ? (
            <MarkdownRenderer content={conversationText || body} isMobile={isMobile} />
          ) : isOpenCode ? (
            <div style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {body}
            </div>
          ) : (
            <>
              {conversationText ? (
                <MarkdownRenderer content={conversationText} isMobile={isMobile} />
              ) : null}
              {hasReport && reportContent ? (
                <div style={{ marginTop: conversationText ? 10 : 0 }}>
                  <ReportCard
                    title={reportTitle || 'Structured Task Report'}
                    content={reportContent}
                  />
                </div>
              ) : null}
              {!conversationText && !hasReport && body ? (
                <MarkdownRenderer content={body} isMobile={isMobile} />
              ) : null}
            </>
          )}
        </div>
      )}
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
  onClearQueue?: () => void;
  onRemoveQueueItem?: (index: number) => void;
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
  onClearQueue,
  onRemoveQueueItem,
  connStatus,
  offlineForText,
  uptimeText,
  showToolBlocks = true
}: Props) {
  const [input, setInput] = useState('');
  const isComposingRef = useRef(false);
  const [collapsedReports, setCollapsedReports] = useState<Record<string, boolean>>({});
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const initialLoadRef = useRef(true);
  const AUTO_SCROLL_THRESHOLD = 150;

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
    setShowScrollBtn(distanceFromBottom > AUTO_SCROLL_THRESHOLD);
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

  // Sticky scroll: CHỈ auto-scroll xuống đáy khi user đang Ở GẦN ĐÁY (trong AUTO_SCROLL_THRESHOLD).
  // Dùng "signature" của tin cuối (length + id + content length) — ổn định khi App re-render vô cớ
  // (SSE tick/status), nhưng đổi khi CÓ tin mới HOẶC streaming content → không bỏ lỡ theo dõi streaming.
  const lastMsg =
    displayMessages.length > 0 ? (displayMessages[displayMessages.length - 1] as any) : undefined;
  const lastMsgSig = lastMsg
    ? `${displayMessages.length}:${String(lastMsg?.id ?? '')}:${String(lastMsg?.content ?? '').length}`
    : '';
  const prevSigRef = useRef(lastMsgSig);

  // Khi có thay đổi tin nhắn thật (thêm mới / streaming): nếu user ở gần đáy → kéo xuống theo,
  // ngược lại (user đang đọc tin cũ) GIỮ NGUYÊN vị trí.
  useEffect(() => {
    const sig = lastMsgSig;
    const changed = sig !== prevSigRef.current;
    prevSigRef.current = sig;

    if (displayMessages.length === 0) {
      // Không có tin → chờ tin tiếp, đánh dấu để scroll đáy ở lần tin đầu của phiên
      initialLoadRef.current = true;
      return;
    }

    const el = scrollRef.current;
    if (!el) return;

    if (changed && isNearBottomRef.current) {
      // Mobile: KHÔNG auto-scroll smooth khi đang gõ (bàn phím mở làm layout viewport đổi → giật).
      // Giữ vị trí typing ổn định; user vẫn kéo tay hoặc dùng nút ↓ (showScrollBtn) khi cần.
      const activeEl = document.activeElement as HTMLElement | null;
      const typingOnMobile = isMobile && activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT');
      if (typingOnMobile) {
        setShowScrollBtn(true); // có tin mới mà đang gõ → nhá nút ↓ để user tự kéo khi xong
      } else {
        el.scrollTo({ top: el.scrollHeight, behavior: isMobile ? 'auto' : 'smooth' });
        setShowScrollBtn(false);
      }
    }
  }, [lastMsgSig, displayMessages.length]);

  // Lần mount đầu tiên (hoặc phiên mới sau khi display rỗng) → scroll đáy một lần, không smooth giật.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (initialLoadRef.current && displayMessages.length > 0) {
      el.scrollTop = el.scrollHeight;
      initialLoadRef.current = false;
      isNearBottomRef.current = true;
      setShowScrollBtn(false);
    }
  }, [displayMessages.length]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollBtn(distanceFromBottom > AUTO_SCROLL_THRESHOLD);
  }, [lastMsgSig, visibleCount]);

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
     console.log('handleSend raw input:', input);
     const trimmed = input.trim();
     console.log('handleSend trimmed:', trimmed);
     if (!trimmed) return;
     onSend(trimmed);
     setInput('');
   };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Bỏ qua Enter khi đang composition IME (gõ tiếng Việt/Unikey): nếu xử lý send
    // ngay lúc composition chưa hoàn tất, React controlled value bị cắt mất ký tự
    // đang pending của bộ gõ (ví dụ mất ký tự đầu "Ý" trong "Ý tôi là...").
    if (e.key === 'Enter' && !e.shiftKey) {
      if (isComposingRef.current || e.nativeEvent.isComposing) return;
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
      {/* Header: fixed 48px, nowrap, overflow-x auto, compact badges */}
      <div className="af-chat-header" style={{
        padding: isMobile ? '8px 12px 8px 56px' : '8px 16px',
        borderBottom: '1px solid var(--af-border)',
        background: 'var(--bg-panel)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'nowrap',
        height: 48,
        minHeight: 48,
        boxSizing: 'border-box',
        gap: 8,
        boxShadow: 'var(--shadow-panel)',
        overflowX: 'auto',
        overflowY: 'hidden',
        scrollbarWidth: 'none'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flexShrink: 1 }}>
          <div style={{
            width: 30,
            height: 30,
            borderRadius: 7,
            background: 'linear-gradient(135deg, #4f46e5 0%, #3b82f6 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 15,
            boxShadow: '0 2px 6px rgba(79, 70, 229, 0.3)',
            flexShrink: 0
          }}>
            💬
          </div>
          <div style={{ minWidth: 0, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'nowrap' }}>
              <span className="af-chat-title" style={{
                fontSize: 13.5,
                fontWeight: 600,
                color: 'var(--text-primary)',
                letterSpacing: '-0.01em',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}>
                {title || 'Orchestrator'}
              </span>

              {/* Status Badge */}
              {status && (
                <div style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '1px 7px',
                  borderRadius: 9999,
                  background: status === 'working' ? 'rgba(34, 197, 94, 0.15)' : status === 'error' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(100, 116, 139, 0.15)',
                  border: `1px solid ${status === 'working' ? 'rgba(34, 197, 94, 0.35)' : status === 'error' ? 'rgba(239, 68, 68, 0.35)' : 'rgba(100, 116, 139, 0.25)'}`,
                  fontSize: 10,
                  fontWeight: 600,
                  color: status === 'working' ? '#4ade80' : status === 'error' ? '#f87171' : '#94a3b8',
                  flexShrink: 0,
                  whiteSpace: 'nowrap'
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
                  padding: '1px 7px',
                  borderRadius: 9999,
                  background: 'rgba(99, 102, 241, 0.12)',
                  border: '1px solid rgba(99, 102, 241, 0.3)',
                  color: '#a5b4fc',
                  fontSize: 10,
                  fontWeight: 500,
                  fontFamily: 'monospace',
                  flexShrink: 0,
                  whiteSpace: 'nowrap'
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
                  padding: '1px 7px',
                  borderRadius: 9999,
                  background: 'rgba(56, 189, 248, 0.12)',
                  border: '1px solid rgba(56, 189, 248, 0.3)',
                  color: '#38bdf8',
                  fontSize: 10,
                  fontWeight: 600,
                  fontFamily: 'monospace',
                  flexShrink: 0,
                  whiteSpace: 'nowrap'
                }}
                title={tooltipText}
              >
                <span>⚡</span>
                <span>{formattedTokens} tokens{formattedCost ? ` | ${formattedCost}` : ''}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right side controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {/* Connection Status Badge (WS) */}
          {connStatus && (
            <div
              className={connStatus === 'disconnected' ? 'af-conn-badge-off' : undefined}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '3px 8px',
                borderRadius: 9999,
                background: connStatus === 'connected' ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.15)',
                border: `1px solid ${connStatus === 'connected' ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.45)'}`,
                fontSize: 10.5,
                fontWeight: 600,
                color: connStatus === 'connected' ? '#4ade80' : '#f87171',
                whiteSpace: 'nowrap',
                flexShrink: 0
              }}
            >
              <span
                className={connStatus === 'connected' ? 'pulsing-green' : 'pulsing-red'}
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  backgroundColor: connStatus === 'connected' ? '#22c55e' : '#ef4444',
                  display: 'inline-block'
                }}
              />
              <span>
                {connStatus === 'connected'
                  ? `Live WS${uptimeText ? ` (${uptimeText})` : ''}`
                  : `Offline${offlineForText ? ` (${offlineForText} trước)` : ''}`}
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
                padding: '4px 10px',
                fontSize: 11.5,
                cursor: 'pointer',
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                whiteSpace: 'nowrap',
                flexShrink: 0
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
      </div>

      {/* Messages */}
      <div ref={scrollRef} onScroll={handleScroll} className="af-chat-scroll" style={{ flex: 1, overflow: 'auto', minWidth: 0, padding: isMobile ? '8px 6px' : '14px 16px', display: 'flex', flexDirection: 'column', gap: 8, userSelect: 'none' }}>
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
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>AgentForge Workspace</div>
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
            {(() => {
              // FIX: Skip opencode system wrapper message ("⚡ OpenCode") when the
              // next message from the same agent is a report, to avoid double rendering
              // the report (system wrapper + internal agent report card).
              const deduplicatedMessages = visibleMessages.filter((msg: any, idx: number) => {
                const isWrapper = msg.msgType === 'opencode' && msg.content;
                if (!isWrapper) return true;
                const next = visibleMessages[idx + 1];
                if (!next) return true;
                const sameAgent = !!msg.agentId && msg.agentId === next.agentId;
                const nextIsReport = !!next.content && (next.content.includes('=== TASK REPORT ===') || next.content.includes('=== ERROR REPORT ===') || next.content.includes('=== AGENT MESSAGE ==='));
                return !(sameAgent && nextIsReport);
              });
              return deduplicatedMessages.map((msg: any) => (
                <MessageItem
                  key={msg.id}
                  msg={msg}
                  agents={agents}
                  isCollapsed={!!collapsedReports[msg.id]}
                  onToggleReport={toggleReport}
                  isMobile={isMobile}
                />
              ));
            })()}
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

        {/* Floating scroll-to-bottom button */}
        {showScrollBtn && (
          <button
            onClick={() => {
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
              isNearBottomRef.current = true;
              setShowScrollBtn(false);
            }}
            style={{
              position: 'absolute',
              bottom: '90px',
              right: '24px',
              zIndex: 10,
              borderRadius: '50%',
              width: 36,
              height: 36,
              background: '#2563eb',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
              boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 14,
              lineHeight: 1
            }}
            title="Cuộn xuống cuối"
          >
            ↓
          </button>
        )}

        <div ref={bottomRef} style={{ height: 24, flexShrink: 0 }} />
      </div>

      {/* Input & Queue Bubble */}
      <div className="af-chat-input" style={{
        padding: isMobile ? '8px 10px' : '12px 18px',
        paddingBottom: isMobile ? 'calc(8px + env(safe-area-inset-bottom))' : 12,
        borderTop: '1px solid var(--af-border)',
        background: 'var(--bg-panel)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        position: 'relative'
      }}>
        {/* Floating Queue Bubble docked directly above the typing box */}
        {queuedMessages.length > 0 && (
          <div style={{
            background: 'var(--bg-inset, #121824)',
            border: '1px solid rgba(59, 130, 246, 0.35)',
            borderRadius: 'var(--radius-md)',
            padding: '8px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            boxShadow: '0 4px 18px rgba(0, 0, 0, 0.3)',
            animation: 'fadeIn 0.2s ease-in-out'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 13 }}>📨</span>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--wb-info, #38bdf8)' }}>
                  Hàng đợi tin nhắn ({queuedMessages.length})
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {onFlushQueue && (
                  <button
                    onClick={onFlushQueue}
                    style={{
                      background: 'rgba(16, 185, 129, 0.18)',
                      border: '1px solid rgba(52, 211, 153, 0.4)',
                      color: '#6ee7b7',
                      borderRadius: 4,
                      padding: '2px 8px',
                      fontSize: 10.5,
                      fontWeight: 700,
                      cursor: 'pointer'
                    }}
                    title="Gộp gửi toàn bộ hàng đợi ngay lập tức"
                  >
                    ⚡ Gửi hết
                  </button>
                )}
                {onClearQueue && (
                  <button
                    onClick={onClearQueue}
                    style={{
                      background: 'rgba(239, 68, 68, 0.15)',
                      border: '1px solid rgba(239, 68, 68, 0.35)',
                      color: '#f87171',
                      borderRadius: 4,
                      padding: '2px 8px',
                      fontSize: 10.5,
                      fontWeight: 600,
                      cursor: 'pointer'
                    }}
                    title="Xóa toàn bộ hàng đợi"
                  >
                    🗑️ Xóa hết
                  </button>
                )}
              </div>
            </div>

            {/* List of queued items */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 120, overflowY: 'auto' }}>
              {queuedMessages.map((q, i) => {
                const tgtAgent = agents.find(a => a.id === q.to);
                const tgtName = q.to === 'orchestrator' || !q.to ? 'Orchestrator' : (tgtAgent ? tgtAgent.name : q.to);
                return (
                  <div key={`${q.id}-${i}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, fontSize: 11, background: 'rgba(255, 255, 255, 0.03)', padding: '3px 6px', borderRadius: 4, border: '1px solid var(--af-border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 3,
                        padding: '1px 5px',
                        borderRadius: 3,
                        background: 'rgba(99, 102, 241, 0.18)',
                        border: '1px solid rgba(129, 140, 248, 0.4)',
                        color: '#c7d2fe',
                        fontSize: 10,
                        fontWeight: 700,
                        flexShrink: 0
                      }}>
                        Gửi tới: {q.to === 'orchestrator' || !q.to ? '👑' : '🤖'} {tgtName}
                      </span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)', flex: 1 }}>
                        {q.content.slice(0, 100)}
                      </span>
                    </div>
                    {onRemoveQueueItem && (
                      <button
                        onClick={() => onRemoveQueueItem(i)}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          color: 'var(--wb-danger, #f87171)',
                          cursor: 'pointer',
                          padding: '1px 4px',
                          fontSize: 10.5,
                          fontWeight: 700,
                          flexShrink: 0
                        }}
                        title="Xóa tin này khỏi hàng đợi"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onCompositionStart={() => { isComposingRef.current = true; }}
            onCompositionEnd={() => { isComposingRef.current = false; }}
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
              color: input.trim() ? 'var(--text-primary)' : 'var(--text-muted)',
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
