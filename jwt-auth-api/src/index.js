import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuthServer } from './server.js';
import { UserDatabase } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '4000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'users.json');

const db = new UserDatabase(DB_FILE);
const { server } = createAuthServer({
  db,
  jwtSecret: process.env.JWT_SECRET || 'jwt-auth-super-secret-production-key-2026',
  accessTokenTtl: parseInt(process.env.ACCESS_TOKEN_TTL || '900', 10), // 15 mins
  refreshTokenTtl: parseInt(process.env.REFRESH_TOKEN_TTL || '604800', 10) // 7 days
});

server.listen(PORT, HOST, () => {
  console.log(`[JWT-AUTH-API] Server is running at http://${HOST}:${PORT}`);
  console.log(`[JWT-AUTH-API] Health check: http://${HOST}:${PORT}/health`);
});

// Graceful shutdown handling
function shutdown(signal) {
  console.log(`\n[JWT-AUTH-API] Received ${signal}, saving state and shutting down...`);
  db.saveToDisk();
  server.close(() => {
    console.log('[JWT-AUTH-API] Server stopped gracefully.');
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
