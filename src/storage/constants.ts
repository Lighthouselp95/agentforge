import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, statSync, mkdirSync } from 'fs';

const __dirname_storage = dirname(fileURLToPath(new URL('.', import.meta.url)));
const STORAGE_CANDIDATE_ROOTS = [
  process.cwd(),
  dirname(process.execPath),
  join(dirname(process.execPath), '..'),
  join(__dirname_storage, '..'),
  join(__dirname_storage, '../..'),
  join(__dirname_storage, '../../..'),
];

export function resolveProjectRootForStorage(): string {
  // Uu tien tim package.json (goc project that) truoc — tranh release/data rong thang the
  for (const r of STORAGE_CANDIDATE_ROOTS) {
    if (existsSync(join(r, 'package.json'))) return r;
  }
  // Fallback: chon thu muc co state file lon nhat (nhieu du lieu nhat)
  let best: string | null = null;
  let bestSize = -1;
  for (const r of STORAGE_CANDIDATE_ROOTS) {
    const p = join(r, 'data', 'agentforge-state.json');
    if (existsSync(p)) {
      try {
        const sz = statSync(p).size;
        if (sz > bestSize) { bestSize = sz; best = r; }
      } catch {}
    }
    if (existsSync(join(r, '.opencode')) && best === null) best = r;
  }
  if (best) return best;
  return process.cwd();
}

export const PROJECT_ROOT_STORAGE = resolveProjectRootForStorage();
export const DATA_DIR = join(PROJECT_ROOT_STORAGE, 'data');
export const STATE_FILE = join(DATA_DIR, 'agentforge-state.json');
export const BAK_FILE = join(DATA_DIR, 'agentforge-state.json.bak');

export const MAX_PERSISTED_MESSAGES = Infinity;
export const MAX_LOGS_ENTRIES = 5000;

// Ensure data dir exists
mkdirSync(DATA_DIR, { recursive: true });
