// Bundle dist/server.js -> CJS cho Node SEA, thay import.meta.url bằng giá trị thật
// (esbuild mặc định sinh new URL('.', {}) khi không biết base -> ERR_INVALID_URL trong SEA).
import { build } from 'esbuild';
import path from 'node:path';

const entryUrl = 'file:///' + path.resolve('dist/server.js').split('\\').join('/');

await build({
  entryPoints: ['dist/server.js'],
  outfile: 'dist/sea-server.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  define: {
    'import.meta.url': JSON.stringify(entryUrl)
  }
});
console.log('[build-sea-bundle] dist/sea-server.cjs written');
