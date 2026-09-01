// Sinh sea-config.json cho Node SEA (Single Executable Application)
// Gom dist/server.js + toan bo web/dist (index.html + assets) vao 1 file exe duy nhat.
import { readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();

function walk(dir, base, out) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, join(base, name), out);
    else out[join(base, name).split('\\').join('/')] = full.split('\\').join('/');
  }
}

const assets = {};
if (existsSync(join(root, 'dist', 'index.html'))) {
  assets['dist/index.html'] = join(root, 'dist', 'index.html').split('\\').join('/');
}
walk(join(root, 'web', 'dist'), 'web/dist', assets);
walk(join(root, 'src', 'prompts'), 'src/prompts', assets);

if (!assets['web/dist/index.html'] && !assets['dist/index.html']) {
  console.error('[gen-sea-assets] index.html khong ton tai trong web/dist hoac dist — chay `npm run build` truoc.');
  process.exit(1);
}

const config = {
  main: 'dist/sea-server.cjs', // bundle CJS (SEA không chạy ESM)
  output: 'dist/sea-prep.blob',
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets
};

writeFileSync(join(root, 'sea-config.json'), JSON.stringify(config, null, 2));
console.log(`[gen-sea-assets] sea-config.json: ${Object.keys(assets).length} assets embedded`);
