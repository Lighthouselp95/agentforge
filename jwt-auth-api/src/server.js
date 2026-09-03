import http from 'node:http';
import { AuthService } from './auth.service.js';
import { UserDatabase } from './db.js';

export class RateLimiter {
  constructor(windowMs = 60000, maxRequests = 30) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.hits = new Map(); // ip -> { count, resetTime }
  }

  isRateLimited(ip) {
    const now = Date.now();
    const record = this.hits.get(ip);
    if (!record || record.resetTime < now) {
      this.hits.set(ip, { count: 1, resetTime: now + this.windowMs });
      return false;
    }
    record.count += 1;
    if (record.count > this.maxRequests) {
      return true;
    }
    return false;
  }
}

export function createAuthServer(options = {}) {
  const db = options.db || new UserDatabase(options.dbFilePath || null);
  const authService = new AuthService(db, {
    jwtSecret: options.jwtSecret || process.env.JWT_SECRET || 'jwt-auth-secret-key-2026-very-secure',
    accessTokenTtl: options.accessTokenTtl || 900,
    refreshTokenTtl: options.refreshTokenTtl || 604800
  });

  const rateLimiter = new RateLimiter(60000, options.rateLimitMax || 60);

  const server = http.createServer(async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const ip = req.socket.remoteAddress || 'unknown';
    if (rateLimiter.isRateLimited(ip)) {
      sendJson(res, 429, {
        success: false,
        error: 'Too many requests, please slow down'
      });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    try {
      // 1. Health check
      if (req.method === 'GET' && (pathname === '/health' || pathname === '/')) {
        sendJson(res, 200, {
          success: true,
          status: 'ok',
          service: 'jwt-auth-api',
          uptime: process.uptime()
        });
        return;
      }

      // 2. Register
      if (req.method === 'POST' && pathname === '/api/auth/register') {
        const body = await parseJsonBody(req);
        const user = await authService.register(body);
        sendJson(res, 201, {
          success: true,
          message: 'User registered successfully',
          data: { user }
        });
        return;
      }

      // 3. Login
      if (req.method === 'POST' && pathname === '/api/auth/login') {
        const body = await parseJsonBody(req);
        const result = await authService.login(body);
        sendJson(res, 200, {
          success: true,
          message: 'Login successful',
          data: result
        });
        return;
      }

      // 4. Refresh Token
      if (req.method === 'POST' && pathname === '/api/auth/refresh') {
        const body = await parseJsonBody(req);
        const result = await authService.refreshToken(body.refreshToken);
        sendJson(res, 200, {
          success: true,
          message: 'Token refreshed successfully',
          data: result
        });
        return;
      }

      // 5. Logout
      if (req.method === 'POST' && pathname === '/api/auth/logout') {
        const body = await parseJsonBody(req);
        await authService.logout(body.refreshToken);
        sendJson(res, 200, {
          success: true,
          message: 'Logged out successfully'
        });
        return;
      }

      // 6. Protected Routes: /api/auth/me, /api/user/profile
      if (req.method === 'GET' && (pathname === '/api/auth/me' || pathname === '/api/user/profile')) {
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          sendJson(res, 401, {
            success: false,
            error: 'Authorization header missing or invalid format (Bearer token required)'
          });
          return;
        }

        const token = authHeader.slice(7).trim();
        try {
          const authData = authService.verifyAccessToken(token);
          sendJson(res, 200, {
            success: true,
            data: authData
          });
        } catch (err) {
          sendJson(res, 401, {
            success: false,
            error: err.message
          });
        }
        return;
      }

      // 404 Not Found
      sendJson(res, 404, {
        success: false,
        error: `Route ${req.method} ${pathname} not found`
      });
    } catch (err) {
      const statusCode = err.statusCode || (err.message.includes('already') || err.message.includes('Invalid') ? 400 : 500);
      sendJson(res, statusCode, {
        success: false,
        error: err.message || 'Internal Server Error'
      });
    }
  });

  return { server, authService, db };
}

function parseJsonBody(req, limitBytes = 1048576) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let bytes = 0;

    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > limitBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      raw += chunk;
    });

    req.on('end', () => {
      if (!raw || raw.trim() === '') {
        return resolve({});
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed);
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(data));
}
