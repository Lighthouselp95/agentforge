import crypto from 'node:crypto';
import { hashPassword, verifyPassword, generateRandomToken } from './crypto.js';
import { signJwt, verifyJwt } from './jwt.js';

export class AuthService {
  /**
   * @param {import('./db.js').UserDatabase} db
   * @param {object} config
   * @param {string} config.jwtSecret
   * @param {number} [config.accessTokenTtl] seconds (default: 900 -> 15 mins)
   * @param {number} [config.refreshTokenTtl] seconds (default: 604800 -> 7 days)
   */
  constructor(db, config = {}) {
    this.db = db;
    this.jwtSecret = config.jwtSecret || process.env.JWT_SECRET || 'default-super-secret-key-change-in-prod-12345';
    this.accessTokenTtl = config.accessTokenTtl || 900; // 15 minutes
    this.refreshTokenTtl = config.refreshTokenTtl || 7 * 24 * 60 * 60; // 7 days
  }

  validateEmail(email) {
    if (!email || typeof email !== 'string') return false;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email.trim());
  }

  validateUsername(username) {
    if (!username || typeof username !== 'string') return false;
    const trimmed = username.trim();
    return trimmed.length >= 3 && trimmed.length <= 32 && /^[a-zA-Z0-9_-]+$/.test(trimmed);
  }

  validatePassword(password) {
    if (!password || typeof password !== 'string') return false;
    return password.length >= 6;
  }

  /**
   * Register a new user
   */
  async register({ username, email, password, role = 'user' }) {
    if (!this.validateUsername(username)) {
      throw new Error('Invalid username: must be 3-32 alphanumeric characters or _ -');
    }
    if (!this.validateEmail(email)) {
      throw new Error('Invalid email format');
    }
    if (!this.validatePassword(password)) {
      throw new Error('Invalid password: must be at least 6 characters');
    }

    const passwordHash = await hashPassword(password);
    const id = crypto.randomUUID();
    const newUser = {
      id,
      username: username.trim(),
      email: email.trim().toLowerCase(),
      passwordHash,
      role,
      createdAt: new Date().toISOString()
    };

    this.db.createUser(newUser);

    const { passwordHash: _, ...safeUser } = newUser;
    return safeUser;
  }

  /**
   * Authenticate user and issue JWT Access Token + Refresh Token
   */
  async login({ identifier, email, username, password }) {
    const loginId = identifier || email || username;
    if (!loginId || typeof loginId !== 'string') {
      throw new Error('Email or username is required');
    }
    if (!password || typeof password !== 'string') {
      throw new Error('Password is required');
    }

    const user = this.db.findUserByEmailOrUsername(loginId.trim());
    if (!user) {
      // Timing attack mitigation: do a dummy hash verification
      await verifyPassword(password, '00000000000000000000000000000000:00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000');
      throw new Error('Invalid credentials');
    }

    const isMatch = await verifyPassword(password, user.passwordHash);
    if (!isMatch) {
      throw new Error('Invalid credentials');
    }

    // Generate tokens
    const tokens = this.generateTokenPair(user);
    const { passwordHash: _, ...safeUser } = user;

    return {
      user: safeUser,
      ...tokens
    };
  }

  generateTokenPair(user) {
    const payload = {
      sub: user.id,
      username: user.username,
      email: user.email,
      role: user.role
    };

    const accessToken = signJwt(payload, this.jwtSecret, {
      expiresIn: this.accessTokenTtl
    });

    const refreshToken = generateRandomToken(48);
    this.db.storeRefreshToken(refreshToken, user.id, this.refreshTokenTtl);

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.accessTokenTtl
    };
  }

  /**
   * Refresh access token with Refresh Token rotation
   */
  async refreshToken(refreshToken) {
    if (!refreshToken || typeof refreshToken !== 'string') {
      throw new Error('Refresh token is required');
    }

    const record = this.db.getRefreshToken(refreshToken);
    if (!record) {
      throw new Error('Invalid or expired refresh token');
    }

    const user = this.db.findUserById(record.userId);
    if (!user) {
      this.db.revokeRefreshToken(refreshToken);
      throw new Error('User not found');
    }

    // Revoke old token (one-time use rotation)
    this.db.revokeRefreshToken(refreshToken);

    // Issue new pair
    const tokens = this.generateTokenPair(user);
    const { passwordHash: _, ...safeUser } = user;

    return {
      user: safeUser,
      ...tokens
    };
  }

  /**
   * Revoke refresh token (Logout)
   */
  async logout(refreshToken) {
    if (!refreshToken) return false;
    return this.db.revokeRefreshToken(refreshToken);
  }

  /**
   * Verify Access Token and return user
   */
  verifyAccessToken(token) {
    const result = verifyJwt(token, this.jwtSecret);
    if (!result.valid) {
      throw new Error(result.error || 'Invalid token');
    }
    const user = this.db.findUserById(result.payload.sub);
    if (!user) {
      throw new Error('User not found');
    }
    const { passwordHash: _, ...safeUser } = user;
    return {
      user: safeUser,
      payload: result.payload
    };
  }
}
