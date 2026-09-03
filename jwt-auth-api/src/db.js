import fs from 'node:fs';
import path from 'node:path';

export class UserDatabase {
  /**
   * @param {string} [storageFilePath]
   */
  constructor(storageFilePath = null) {
    this.storageFilePath = storageFilePath;
    this.users = new Map(); // id -> user object
    this.usersByEmail = new Map(); // email.toLowerCase() -> id
    this.usersByUsername = new Map(); // username.toLowerCase() -> id
    this.refreshTokens = new Map(); // token -> { userId, expiresAt }
    this.loadFromDisk();
  }

  loadFromDisk() {
    if (!this.storageFilePath) return;
    try {
      if (fs.existsSync(this.storageFilePath)) {
        const raw = fs.readFileSync(this.storageFilePath, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.users)) {
          for (const u of data.users) {
            this.users.set(u.id, u);
            this.usersByEmail.set(u.email.toLowerCase(), u.id);
            this.usersByUsername.set(u.username.toLowerCase(), u.id);
          }
        }
        if (Array.isArray(data.refreshTokens)) {
          const now = Date.now();
          for (const rt of data.refreshTokens) {
            if (rt.expiresAt > now) {
              this.refreshTokens.set(rt.token, { userId: rt.userId, expiresAt: rt.expiresAt });
            }
          }
        }
      }
    } catch (err) {
      console.error('[DB] Warning: Failed to load database file, starting clean.', err.message);
    }
  }

  saveToDisk() {
    if (!this.storageFilePath) return;
    try {
      const dir = path.dirname(this.storageFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = {
        users: Array.from(this.users.values()),
        refreshTokens: Array.from(this.refreshTokens.entries()).map(([token, meta]) => ({
          token,
          userId: meta.userId,
          expiresAt: meta.expiresAt
        }))
      };
      const tempPath = `${this.storageFilePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tempPath, this.storageFilePath);
    } catch (err) {
      console.error('[DB] Error saving database to disk:', err.message);
    }
  }

  createUser(user) {
    const emailKey = user.email.toLowerCase();
    const usernameKey = user.username.toLowerCase();

    if (this.usersByEmail.has(emailKey)) {
      throw new Error('Email already registered');
    }
    if (this.usersByUsername.has(usernameKey)) {
      throw new Error('Username already taken');
    }

    this.users.set(user.id, user);
    this.usersByEmail.set(emailKey, user.id);
    this.usersByUsername.set(usernameKey, user.id);
    this.saveToDisk();
    return user;
  }

  findUserById(id) {
    return this.users.get(id) || null;
  }

  findUserByEmail(email) {
    if (!email) return null;
    const id = this.usersByEmail.get(email.toLowerCase());
    return id ? this.users.get(id) || null : null;
  }

  findUserByUsername(username) {
    if (!username) return null;
    const id = this.usersByUsername.get(username.toLowerCase());
    return id ? this.users.get(id) || null : null;
  }

  findUserByEmailOrUsername(identifier) {
    if (!identifier) return null;
    const byEmail = this.findUserByEmail(identifier);
    if (byEmail) return byEmail;
    return this.findUserByUsername(identifier);
  }

  storeRefreshToken(token, userId, ttlSeconds) {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.refreshTokens.set(token, { userId, expiresAt });
    this.saveToDisk();
  }

  getRefreshToken(token) {
    const record = this.refreshTokens.get(token);
    if (!record) return null;
    if (record.expiresAt < Date.now()) {
      this.refreshTokens.delete(token);
      this.saveToDisk();
      return null;
    }
    return record;
  }

  revokeRefreshToken(token) {
    const deleted = this.refreshTokens.delete(token);
    if (deleted) this.saveToDisk();
    return deleted;
  }

  revokeAllUserRefreshTokens(userId) {
    for (const [token, meta] of this.refreshTokens.entries()) {
      if (meta.userId === userId) {
        this.refreshTokens.delete(token);
      }
    }
    this.saveToDisk();
  }

  clear() {
    this.users.clear();
    this.usersByEmail.clear();
    this.usersByUsername.clear();
    this.refreshTokens.clear();
    if (this.storageFilePath && fs.existsSync(this.storageFilePath)) {
      try { fs.unlinkSync(this.storageFilePath); } catch {}
    }
  }
}
