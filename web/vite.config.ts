import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: __dirname,  // config nằm trong web/ → root chính là web/
  build: {
    outDir: resolve(__dirname, 'dist')
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // Agent chạy (opencode) có thể mất vài phút; mặc định proxyTimeout 120s sẽ cắt đứt kết nối
        // khiến browser báo "Failed to fetch". Nới lỏng lên 10 phút.
        timeout: 600000,
        proxyTimeout: 600000,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes, req, res) => {
            res.setHeader('X-Accel-Buffering', 'no');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
          });
        }
      },
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
        timeout: 600000
      }
    }
  }
});
