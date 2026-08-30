// ============ SYNTAX HIGHLIGHTING (tự viết, 0 dependency) ============
// Triết lý dự án: app nhẹ nhất có thể, ít thư viện, hiệu suất cao.
// Không dùng Prism/Highlight.js (thêm ~tens KB gzipped). Thay vào đó tokenizer
// regex nhẹ cho các ngôn ngữ phổ biến khớp bộ badge CodeBlock.
// AN TOÀN XSS: chỉ trả về React elements (không bao giờ dùng dangerouslySetInnerHTML).
// Anchor mọi regex bằng ^ chống ReDoS/overlap — mỗi lần match 1 token duy nhất ở đầu.

type Tok = { text: string; color?: string; italic?: boolean; bold?: boolean };

interface Rule {
  re: RegExp; // bắt buộc match TỪ ĐẦU (^) của phần chưa xử lý
  fn: (m: RegExpExecArray) => Tok;
}

// Những token không match rule nào → plain, giữ nguyên (không bỏ ký tự)
function tokenize(code: string, rules: Rule[]): Tok[] {
  const out: Tok[] = [];
  let rest = code;
  // Giới hạn chống quá tải trên code block cực lớn (hiệu năng)
  let guard = 0;
  const MAX_ITER = 200000;
  while (rest.length > 0 && guard < MAX_ITER) {
    guard++;
    let matched = false;
    for (const r of rules) {
      r.re.lastIndex = 0;
      const m = r.re.exec(rest);
      if (m && m[0].length > 0) {
        out.push(r.fn(m));
        rest = rest.slice(m[0].length);
        matched = true;
        break;
      }
    }
    // Không rule nào match (khoảng trắng, ký tự hiếm, v.v.) → consume 1 ký tự giữ nguyên
    if (!matched) {
      // Gộp chuỗi không highlight liên tiếp để giảm số React node.
      // QUAN TRỌNG: chỉ scan window giới hạn + dùng substr (không slice toàn bộ)
      // để tránh O(n^2) trên code block cực lớn (ví dụ 250k ký tự plain).
      let j = 1;
      const MAX_SCAN = 512;
      const PROBE_LEN = 256;
      while (j < rest.length && j < MAX_SCAN) {
        let any = false;
        const probe = rest.substr(j, PROBE_LEN);
        for (const r of rules) { r.re.lastIndex = 0; if (r.re.test(probe)) { any = true; break; } }
        if (any) break;
        j++;
      }
      out.push({ text: rest.slice(0, j) });
      rest = rest.slice(j);
    }
  }
  if (guard >= MAX_ITER && rest.length > 0) out.push({ text: rest });
  return out;
}

// ============ PALETTE (khớp dark theme hiện tại) ============
const C = {
  keyword: '#c678dd',  // tím
  string: '#98c379',   // xanh lá
  number: '#d19a66',   // cam
  comment: '#7f848e',  // xám
  fn: '#61afef',       // xanh dương
  tag: '#e06c75',      // đỏ
  attr: '#d19a66',     // vàng cam
  prop: '#e06c75',
  literal: '#56b6c2',  // teal
  flag: '#61afef',
  unit: '#56b6c2',
  decorator: '#d19a66',
  selector: '#e06c75',
  punctuation: '#abb2bf',
};

// ============ RULES CHUNG ============
const wsBefore = (word: string) => new RegExp(`^(${word})(?=$|[^A-Za-z0-9_])`, '');
const kwToRule = (re: RegExp, color: string) => ({ re, fn: (m: RegExpExecArray) => ({ text: m[0], color }) });

// ============ JS / TS / JSX / TSX (subset chung) ============
const jsRules: Rule[] = [
  { re: /^\/\/[^\n]*/, fn: (m) => ({ text: m[0], color: C.comment, italic: true }) },
  { re: /^\/\*[\s\S]*?\*\//, fn: (m) => ({ text: m[0], color: C.comment, italic: true }) },
  { re: /^`(?:[^`\\]|\\.)*`/, fn: (m) => ({ text: m[0], color: C.string }) },
  { re: /^'(?:[^'\\\n]|\\.)*'/, fn: (m) => ({ text: m[0], color: C.string }) },
  { re: /^"(?:[^"\\\n]|\\.)*"/, fn: (m) => ({ text: m[0], color: C.string }) },
  { re: /^(?:async|await|class|extends|super|return|if|else|try|catch|finally|for|while|do|switch|case|break|continue|new|delete|typeof|instanceof|in|of|const|let|var|function|import|from|export|default|throw|yield|this|void|null|undefined|true|false)(?=$|[^A-Za-z0-9_])/, fn: (m) => ({ text: m[0], color: C.keyword }) },
  { re: /^[A-Za-z_$][A-Za-z0-9_$]*(?=\s*\()/, fn: (m) => ({ text: m[0], color: C.fn }) },
  { re: /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/, fn: (m) => ({ text: m[0], color: C.number }) },
];

// ============ JSON ============
const jsonRules: Rule[] = [
  { re: /^"(?:[^"\\]|\\.)*"(?=\s*:)/, fn: (m) => ({ text: m[0], color: C.prop }) },
  { re: /^"(?:[^"\\]|\\.)*"/, fn: (m) => ({ text: m[0], color: C.string }) },
  { re: /^(?:true|false|null)(?=$|[^A-Za-z0-9_])/, fn: (m) => ({ text: m[0], color: C.literal }) },
  { re: /^-?(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/, fn: (m) => ({ text: m[0], color: C.number }) },
];

// ============ Markdown ============
const mdRules: Rule[] = [
  { re: /^(`+)[^`]*\1/, fn: (m) => ({ text: m[0], color: C.string }) },
  { re: /^#{1,6}\s+[^\n]*/, fn: (m) => ({ text: m[0], color: C.keyword, bold: true }) },
  { re: /^\*\*\*[^*]+\*\*\*|^___[^_]+___/, fn: (m) => ({ text: m[0], color: C.keyword, bold: true }) },
  { re: /^\*\*[^*]+\*\*|^__[^_]+__/, fn: (m) => ({ text: m[0], color: C.keyword, bold: true }) },
  { re: /^\[[^\]]*\]\([^)]*\)/, fn: (m) => ({ text: m[0], color: C.fn }) },
  { re: /^>[^\n]*/, fn: (m) => ({ text: m[0], color: C.comment, italic: true }) },
  { re: /^(\s*)([-*+]|\d+\.)(\s+)/, fn: (m) => ({ text: m[0], color: C.literal }) },
  { re: /^---$|^\*\*\*$|^___$/, fn: (m) => ({ text: m[0], color: C.comment }) },
  { re: /^(?:[!]?\*|_)[^*\s][^*]*\*/, fn: (m) => ({ text: m[0], italic: true }) },
];

// ============ Bash / Shell ============
const bashRules: Rule[] = [
  { re: /^#[^\n]*/, fn: (m) => ({ text: m[0], color: C.comment, italic: true }) },
  { re: /^'(?:[^'\\]|\\.)*'|^"(?:[^"\\]|\\.)*"/, fn: (m) => ({ text: m[0], color: C.string }) },
  { re: /^(`[^`]*`|\$\([^)]*\)|\$\{[^}]*\})/, fn: (m) => ({ text: m[0], color: C.fn }) },
  { re: /^(?:--?[A-Za-z0-9_-]+)/, fn: (m) => ({ text: m[0], color: C.flag }) },
  kwToRule(/^(?:if|then|else|elif|fi|for|while|do|done|case|esac|function|in|return|exit|local|export|source)\b/, C.keyword),
  kwToRule(/^(?:cd|ls|mkdir|rm|cp|mv|git|npm|pnpm|yarn|node|echo|cat|grep|sed|awk|curl|wget|sudo|chmod|chown|touch|tail|head|ps|kill|docker|npx)\b/, C.fn),
];

// ============ HTML / XML ============
const htmlRules: Rule[] = [
  { re: /^<!--[\s\S]*?-->/, fn: (m) => ({ text: m[0], color: C.comment, italic: true }) },
  { re: /^<\s*\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>])/, fn: (m) => ({ text: m[0], color: C.tag }) },
  { re: /^\/?>/, fn: (m) => ({ text: m[0], color: C.punctuation }) },
  { re: /^[A-Za-z_:][A-Za-z0-9_.:-]*(?==)/, fn: (m) => ({ text: m[0], color: C.attr }) },
  { re: /^"(?:[^"\\]|\\.)*"|^'(?:[^'\\]|\\.)*'/, fn: (m) => ({ text: m[0], color: C.string }) },
  { re: /^=/, fn: () => ({ text: '=', color: C.punctuation }) },
  { re: /^[A-Za-z_:][A-Za-z0-9_.:-]*\s*(?=[\/>])/, fn: (m) => ({ text: m[0], color: C.tag }) },
];

// ============ CSS / SCSS ============
const cssRules: Rule[] = [
  { re: /^\/\*[\s\S]*?\*\//, fn: (m) => ({ text: m[0], color: C.comment, italic: true }) },
  { re: /^#[0-9a-fA-F]{3,8}\b/, fn: (m) => ({ text: m[0], color: C.number }) },
  { re: /^-?\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|fr|deg|rad|turn|ch|ex|pt|pc|cm|mm|in)?\b/, fn: (m) => ({ text: m[0], color: C.number }) },
  kwToRule(/^(?:!important|important)\b/, C.keyword),
  kwToRule(/^(?:and|or|not|var|calc|min|max|clamp)\s*\(/, C.fn),
  { re: /^([A-Za-z_][A-Za-z0-9_]*)(?=\s*:)/, fn: (m) => ({ text: m[0], color: C.prop }) },
  { re: /^\.-?[_A-Za-z-][A-Za-z0-9_-]*,?|^#-?[_A-Za-z-][A-Za-z0-9_-]*(?:[.#:\[][^\s{]*)?/, fn: (m) => ({ text: m[0], color: C.selector }) },
  { re: /^[@][A-Za-z-]+/, fn: (m) => ({ text: m[0], color: C.decorator }) },
];

// ============ Python ============
const pyRules: Rule[] = [
  { re: /^#[^\n]*/, fn: (m) => ({ text: m[0], color: C.comment, italic: true }) },
  { re: /^r"""[^]*?"""|^r'''[^]*?'''|^"""[^]*?"""|^'''[^]*?'''/, fn: (m) => ({ text: m[0], color: C.string }) },
  { re: /^f'[^'\\]*'|^f"[^"\\]*"|^b'[^'\\]*'|^b"[^"\\]*"|^r'[^'\\]*'|^r"[^"\\]*"|^'(?:[^'\\\n]|\\.)*'|^"(?:[^"\\\n]|\\.)*"/, fn: (m) => ({ text: m[0], color: C.string }) },
  { re: /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[jJ]?/, fn: (m) => ({ text: m[0], color: C.number }) },
  kwToRule(/^(?:def|class|return|import|from|as|if|elif|else|for|while|break|continue|pass|raise|try|except|finally|with|lambda|yield|global|nonlocal|in|not|and|or|is|None|True|False|async|await|del|assert)\b/, C.keyword),
  { re: /^@[A-Za-z_][A-Za-z0-9_.]*/, fn: (m) => ({ text: m[0], color: C.decorator }) },
  kwToRule(/^[A-Za-z_][A-Za-z0-9_]*(?=\s*\()/, C.fn),
];

// ============ REGISTRY: lang → rules ============
interface LangReg { re: RegExp; rules: Rule[]; }
const registry: LangReg[] = [
  { re: /^(?:javascript|js|jsx|tsx|typescript|ts)$/, rules: jsRules },
  { re: /^json$/, rules: jsonRules },
  { re: /^(?:md|markdown)$/, rules: mdRules },
  { re: /^(?:bash|sh|shell|zsh|console)$/, rules: bashRules },
  { re: /^(?:html|xml|svg|mxml|xhtml)$/, rules: htmlRules },
  { re: /^(?:css|scss|less|sass)$/, rules: cssRules },
  { re: /^(?:py|python)$/, rules: pyRules },
];

// Nhận diện lang có hỗ trợ highlight hay không (để fallback plain, không crash)
export function isSupportedLang(lang: string): boolean {
  const l = (lang || '').toLowerCase().trim();
  return registry.some(({ re }) => re.test(l));
}

export interface HighlightedToken {
  text: string;
  color?: string;
  italic?: boolean;
  bold?: boolean;
}

// Trả về mảng token (ReactNode-friendly). Nếu lang không hỗ trợ → [ {text: code} ] plain.
export function highlight(code: string | undefined, lang: string | undefined): HighlightedToken[] {
  const src = String(code == null ? '' : code);
  const l = (lang || '').toLowerCase().trim();
  const reg = registry.find(({ re }) => re.test(l));
  if (!reg) return [{ text: src }];
  return tokenize(src, reg.rules);
}
