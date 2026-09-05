import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(new URL('.', import.meta.url)));

let earlySeaGetAsset: ((key: string) => ArrayBuffer) | null = null;
try {
  const req = createRequire(import.meta.url);
  const sea = req('node:sea') as any;
  if (typeof sea.isSea === 'function' && sea.isSea()) {
    earlySeaGetAsset = sea.getAsset;
  }
} catch {}

export const PROMPTS_CANDIDATE_DIRS = [
  join(process.cwd(), 'src', 'prompts'),
  join(dirname(process.execPath), 'src', 'prompts'),
  join(dirname(process.execPath), '..', 'src', 'prompts'),
  join(__dirname, '..', 'prompts'),
  join(__dirname, '..', '..', 'src', 'prompts'),
];

export function loadPrompt(name: string): string {
  // 1) Filesystem first: uu tien doc tu src/prompts
  for (const dir of PROMPTS_CANDIDATE_DIRS) {
    const p = join(dir, name);
    if (existsSync(p)) {
      try { return readFileSync(p, 'utf-8'); } catch {}
    }
  }
  // 2) SEA embedded
  if (earlySeaGetAsset) {
    try {
      const key = ('src/prompts/' + name).split('\\').join('/');
      const buf = earlySeaGetAsset(key);
      if (buf) return Buffer.from(buf).toString('utf-8');
    } catch {}
  }
  console.warn(`[Prompt] Not found: ${name} (tried ${PROMPTS_CANDIDATE_DIRS.join(' | ')}), using fallback`);
  return '';
}
