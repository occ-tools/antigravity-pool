const { randomUUID } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const { dirname, isAbsolute, join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

process.env.DATABASE_URL ||= 'file:./dev.db';

function sqlitePathFromUrl(url) {
  const value = url.replace(/^file:/, '');
  const normalized = value.startsWith('./') ? join('prisma', value.slice(2)) : value;
  return isAbsolute(normalized) ? normalized : join(process.cwd(), normalized);
}

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nowIso() {
  return new Date().toISOString();
}

function openDb() {
  const dbPath = sqlitePathFromUrl(process.env.DATABASE_URL);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS Account (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      refreshToken TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      lastUsed TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      usageCount INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      quotaStatus TEXT NOT NULL DEFAULT 'unknown',
      quotaResetAt TEXT,
      quotaMessage TEXT,
      quotaCheckedAt TEXT,
      leaseUntil TEXT
    );

    CREATE TABLE IF NOT EXISTS RequestLog (
      id TEXT PRIMARY KEY,
      accountId TEXT NOT NULL,
      model TEXT NOT NULL,
      statusCode INTEGER NOT NULL,
      latency INTEGER NOT NULL,
      promptTokens INTEGER NOT NULL DEFAULT 0,
      completionTokens INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

function rowAccount(row) {
  return {
    ...row,
    lastUsed: row.lastUsed ? new Date(row.lastUsed) : null,
    createdAt: row.createdAt ? new Date(row.createdAt) : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt) : null,
    quotaResetAt: row.quotaResetAt ? new Date(row.quotaResetAt) : null,
    quotaCheckedAt: row.quotaCheckedAt ? new Date(row.quotaCheckedAt) : null,
    leaseUntil: row.leaseUntil ? new Date(row.leaseUntil) : null,
  };
}

function createLocalDb() {
  const db = openDb();
  return {
    close() {
      db.close();
    },
    listAccounts() {
      return db.prepare('SELECT * FROM Account ORDER BY createdAt DESC').all().map(rowAccount);
    },
    findAccountByEmail(email) {
      const row = db.prepare('SELECT * FROM Account WHERE email = $email LIMIT 1').get({ $email: email });
      return row ? rowAccount(row) : null;
    },
    updateAccount(id, data) {
      const fields = [];
      const params = { $id: id, $updatedAt: nowIso() };
      for (const [key, value] of Object.entries(data)) {
        fields.push(`${key} = $${key}`);
        params[`$${key}`] = value instanceof Date ? value.toISOString() : value;
      }
      fields.push('updatedAt = $updatedAt');
      db.prepare(`UPDATE Account SET ${fields.join(', ')} WHERE id = $id`).run(params);
      const updated = db.prepare('SELECT * FROM Account WHERE id = $id').get({ $id: id });
      return rowAccount(updated);
    },
    createAccount(data) {
      const id = data.id || randomUUID();
      const createdAt = nowIso();
      db.prepare(`
        INSERT INTO Account (id, name, email, refreshToken, status, lastUsed, usageCount, createdAt, updatedAt, quotaStatus, quotaResetAt, quotaMessage, quotaCheckedAt, leaseUntil)
        VALUES ($id, $name, $email, $refreshToken, $status, $lastUsed, $usageCount, $createdAt, $updatedAt, $quotaStatus, $quotaResetAt, $quotaMessage, $quotaCheckedAt, $leaseUntil)
      `).run({
        $id: id,
        $name: data.name,
        $email: data.email || null,
        $refreshToken: data.refreshToken,
        $status: data.status || 'active',
        $lastUsed: iso(data.lastUsed) || createdAt,
        $usageCount: data.usageCount || 0,
        $createdAt: createdAt,
        $updatedAt: createdAt,
        $quotaStatus: data.quotaStatus || 'unknown',
        $quotaResetAt: iso(data.quotaResetAt),
        $quotaMessage: data.quotaMessage || null,
        $quotaCheckedAt: iso(data.quotaCheckedAt),
        $leaseUntil: iso(data.leaseUntil),
      });
      const created = db.prepare('SELECT * FROM Account WHERE id = $id').get({ $id: id });
      return rowAccount(created);
    },
    requestLogsSince(timestamp) {
      return db.prepare('SELECT * FROM RequestLog WHERE timestamp >= $timestamp').all({ $timestamp: timestamp.toISOString() });
    },
  };
}

module.exports = { createLocalDb };
