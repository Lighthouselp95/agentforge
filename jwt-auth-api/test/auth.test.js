import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, generateRandomToken } from '../src/crypto.js';
import { signJwt, verifyJwt, decodeJwt } from '../src/jwt.js';
import { UserDatabase } from '../src/db.js';
import { AuthService } from '../src/auth.service.js';
import { createAuthServer } from '../src/server.js';

describe('1. Crypto Utilities', () => {
  test('hashPassword creates valid salt:hash format and verifies correctly', async () => {
    const rawPassword = 'mySecretPassword123!';
    const hash = await hashPassword(rawPassword);

    assert.ok(hash.includes(':'), 'Hash format should be salt:hash');
    const isValid = await verifyPassword(rawPassword, hash);
    assert.equal(isValid, true, 'Valid password should verify successfully');

    const isWrongValid = await verifyPassword('wrongPassword', hash);
    assert.equal(isWrongValid, false, 'Wrong password should fail verification');
  });

  test('generateRandomToken generates unique hex tokens', () => {
    const t1 = generateRandomToken(16);
    const t2 = generateRandomToken(16);
    assert.equal(t1.length, 32);
    assert.notEqual(t1, t2);
  });
});

describe('2. JWT Sign & Verify (HS256)', () => {
  const secret = 'super-test-secret-key';

  test('signJwt generates valid JWT and verifyJwt decodes payload', () => {
    const payload = { sub: 'user-123', email: 'user@example.com', role: 'admin' };
    const token = signJwt(payload, secret, { expiresIn: 3600 });

    assert.equal(typeof token, 'string');
    const parts = token.split('.');
    assert.equal(parts.length, 3);

    const verified = verifyJwt(token, secret);
    assert.equal(verified.valid, true);
    assert.equal(verified.payload.sub, 'user-123');
    assert.equal(verified.payload.email, 'user@example.com');
    assert.equal(verified.payload.role, 'admin');
    assert.ok(verified.payload.exp > verified.payload.iat);
  });

  test('verifyJwt fails with wrong secret or tampered signature', () => {
    const payload = { sub: 'user-123' };
    const token = signJwt(payload, secret);

    const resultWrongSecret = verifyJwt(token, 'wrong-secret');
    assert.equal(resultWrongSecret.valid, false);
    assert.match(resultWrongSecret.error, /Invalid token signature/);

    // Tamper token payload
    const parts = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ sub: 'admin-hacker' })).toString('base64url');
    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    const resultTampered = verifyJwt(tamperedToken, secret);
    assert.equal(resultTampered.valid, false);
  });

  test('verifyJwt detects expired token', async () => {
    const payload = { sub: 'user-123' };
    // Token that expires immediately (-10s)
    const token = signJwt(payload, secret, { expiresIn: -10 });

    const result = verifyJwt(token, secret);
    assert.equal(result.valid, false);
    assert.match(result.error, /expired/i);
  });

  test('decodeJwt extracts payload without verifying signature', () => {
    const payload = { sub: 'user-999', flag: 'test' };
    const token = signJwt(payload, secret);
    const decoded = decodeJwt(token);
    assert.equal(decoded.sub, 'user-999');
    assert.equal(decoded.flag, 'test');
  });
});

describe('3. AuthService Logic', () => {
  let db;
  let authService;

  before(() => {
    db = new UserDatabase();
    authService = new AuthService(db, {
      jwtSecret: 'test-secret',
      accessTokenTtl: 60,
      refreshTokenTtl: 3600
    });
  });

  test('User registration, duplicate prevention, and login flow', async () => {
    const user = await authService.register({
      username: 'alice',
      email: 'alice@example.com',
      password: 'password123'
    });

    assert.equal(user.username, 'alice');
    assert.equal(user.email, 'alice@example.com');
    assert.ok(user.id);
    assert.equal(user.passwordHash, undefined, 'passwordHash must not leak');

    // Duplicate registration should fail
    await assert.rejects(
      () => authService.register({ username: 'alice2', email: 'alice@example.com', password: 'password123' }),
      /Email already registered/
    );

    await assert.rejects(
      () => authService.register({ username: 'alice', email: 'alice2@example.com', password: 'password123' }),
      /Username already taken/
    );

    // Login with email
    const loginResult = await authService.login({
      email: 'alice@example.com',
      password: 'password123'
    });

    assert.ok(loginResult.accessToken);
    assert.ok(loginResult.refreshToken);
    assert.equal(loginResult.user.username, 'alice');

    // Login with username
    const loginByUsername = await authService.login({
      username: 'alice',
      password: 'password123'
    });
    assert.ok(loginByUsername.accessToken);

    // Login with wrong password
    await assert.rejects(
      () => authService.login({ email: 'alice@example.com', password: 'wrongPassword' }),
      /Invalid credentials/
    );

    // Verify access token
    const verified = authService.verifyAccessToken(loginResult.accessToken);
    assert.equal(verified.user.id, user.id);

    // Refresh token rotation
    const refreshed = await authService.refreshToken(loginResult.refreshToken);
    assert.ok(refreshed.accessToken);
    assert.ok(refreshed.refreshToken);
    assert.notEqual(refreshed.refreshToken, loginResult.refreshToken, 'Old refresh token should be rotated');

    // Reusing old refresh token must fail
    await assert.rejects(
      () => authService.refreshToken(loginResult.refreshToken),
      /Invalid or expired refresh token/
    );

    // Logout
    const loggedOut = await authService.logout(refreshed.refreshToken);
    assert.equal(loggedOut, true);

    // Using logged-out refresh token must fail
    await assert.rejects(
      () => authService.refreshToken(refreshed.refreshToken),
      /Invalid or expired refresh token/
    );
  });
});

describe('4. Full HTTP API Integration Tests', () => {
  let server;
  let baseUrl;

  before(async () => {
    const db = new UserDatabase();
    const app = createAuthServer({
      db,
      jwtSecret: 'integration-test-secret',
      accessTokenTtl: 30,
      refreshTokenTtl: 3600
    });
    server = app.server;

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after((done) => {
    server.close(done);
  });

  test('GET /health returns 200 OK', async () => {
    const res = await fetch(`${baseUrl}/health`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.success, true);
    assert.equal(json.status, 'ok');
  });

  test('Complete Authentication Flow via HTTP', async () => {
    // 1. Register
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'bob_builder',
        email: 'bob@builder.com',
        password: 'securePassword999'
      })
    });

    const regData = await regRes.json();
    assert.equal(regRes.status, 201);
    assert.equal(regData.success, true);
    assert.equal(regData.data.user.username, 'bob_builder');

    // 2. Login
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: 'bob@builder.com',
        password: 'securePassword999'
      })
    });

    const loginData = await loginRes.json();
    assert.equal(loginRes.status, 200);
    assert.equal(loginData.success, true);
    const { accessToken, refreshToken } = loginData.data;
    assert.ok(accessToken);
    assert.ok(refreshToken);

    // 3. Access protected route with Bearer token
    const profileRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const profileData = await profileRes.json();
    assert.equal(profileRes.status, 200);
    assert.equal(profileData.success, true);
    assert.equal(profileData.data.user.email, 'bob@builder.com');

    // 4. Access protected route without token (401)
    const unauthorizedRes = await fetch(`${baseUrl}/api/auth/me`);
    assert.equal(unauthorizedRes.status, 401);

    // 5. Refresh token
    const refreshRes = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    });
    const refreshData = await refreshRes.json();
    assert.equal(refreshRes.status, 200);
    assert.equal(refreshData.success, true);
    const newAccessToken = refreshData.data.accessToken;
    const newRefreshToken = refreshData.data.refreshToken;
    assert.ok(newAccessToken);
    assert.ok(newRefreshToken);

    // 6. Access protected route with new access token
    const newProfileRes = await fetch(`${baseUrl}/api/user/profile`, {
      headers: { Authorization: `Bearer ${newAccessToken}` }
    });
    assert.equal(newProfileRes.status, 200);

    // 7. Logout
    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: newRefreshToken })
    });
    const logoutData = await logoutRes.json();
    assert.equal(logoutRes.status, 200);
    assert.equal(logoutData.success, true);

    // 8. Refreshing again after logout fails
    const failedRefreshRes = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: newRefreshToken })
    });
    assert.equal(failedRefreshRes.status, 400);
  });
});
