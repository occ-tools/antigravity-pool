import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

process.env.DATABASE_URL ||= 'file:./dev.db';

type SqlValue = string | number | null;
type SqlParams = Record<string, SqlValue>;
export type Account = {
  id: string;
  name: string;
  email: string | null;
  refreshToken: string;
  status: string;
  lastUsed: Date;
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
  quotaStatus: string;
  quotaResetAt: Date | null;
  quotaMessage: string | null;
  quotaCheckedAt: Date | null;
  leaseUntil: Date | null;
};

export type AccountLease = {
  id: string;
  accountId: string;
  slot: number;
  leaseUntil: Date;
  createdAt: Date;
  updatedAt: Date;
};

type RequestLog = {
  id: string;
  accountId: string;
  model: string;
  statusCode: number;
  latency: number;
  promptTokens: number;
  completionTokens: number;
  error: string | null;
  timestamp: Date;
  account?: Account;
};

function sqlitePathFromUrl(url: string) {
  const value = url.replace(/^file:/, '');
  const normalized = value.startsWith('./') ? join('prisma', value.slice(2)) : value;
  return isAbsolute(normalized) ? normalized : join(/*turbopackIgnore: true*/ process.cwd(), normalized);
}

const schemaSql = `
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

  CREATE TABLE IF NOT EXISTS AccountLease (
    id TEXT PRIMARY KEY,
    accountId TEXT NOT NULL,
    slot INTEGER NOT NULL,
    leaseUntil TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (accountId) REFERENCES Account(id) ON DELETE CASCADE,
    UNIQUE(accountId, slot)
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
    timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (accountId) REFERENCES Account(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS Account_status_idx ON Account(status);
  CREATE INDEX IF NOT EXISTS Account_lastUsed_idx ON Account(lastUsed);
  CREATE INDEX IF NOT EXISTS Account_status_quotaResetAt_idx ON Account(status, quotaResetAt);
  CREATE INDEX IF NOT EXISTS AccountLease_leaseUntil_idx ON AccountLease(leaseUntil);
  CREATE INDEX IF NOT EXISTS AccountLease_accountId_slot_leaseUntil_idx ON AccountLease(accountId, slot, leaseUntil);
  CREATE INDEX IF NOT EXISTS RequestLog_timestamp_idx ON RequestLog(timestamp);
`;

let dbInstance: DatabaseSync | null = null;

function database() {
  if (!dbInstance) {
    const dbPath = sqlitePathFromUrl(process.env.DATABASE_URL ?? 'file:./dev.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    dbInstance = new DatabaseSync(dbPath);
    dbInstance.exec(schemaSql);
  }
  return dbInstance;
}

function iso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nowIso() {
  return new Date().toISOString();
}

function rowAccount(row: unknown): Account {
  const item = row as Record<string, SqlValue>;
  return {
    id: String(item.id),
    name: String(item.name),
    email: item.email === null ? null : String(item.email),
    refreshToken: String(item.refreshToken),
    status: String(item.status),
    lastUsed: new Date(String(item.lastUsed)),
    usageCount: Number(item.usageCount),
    createdAt: new Date(String(item.createdAt)),
    updatedAt: new Date(String(item.updatedAt)),
    quotaStatus: String(item.quotaStatus),
    quotaResetAt: item.quotaResetAt ? new Date(String(item.quotaResetAt)) : null,
    quotaMessage: item.quotaMessage === null ? null : String(item.quotaMessage),
    quotaCheckedAt: item.quotaCheckedAt ? new Date(String(item.quotaCheckedAt)) : null,
    leaseUntil: item.leaseUntil ? new Date(String(item.leaseUntil)) : null,
  };
}

function rowLease(row: unknown): AccountLease {
  const item = row as Record<string, SqlValue>;
  return {
    id: String(item.id),
    accountId: String(item.accountId),
    slot: Number(item.slot),
    leaseUntil: new Date(String(item.leaseUntil)),
    createdAt: new Date(String(item.createdAt)),
    updatedAt: new Date(String(item.updatedAt)),
  };
}

function rowLog(row: unknown): RequestLog {
  const item = row as Record<string, SqlValue>;
  return {
    id: String(item.id),
    accountId: String(item.accountId),
    model: String(item.model),
    statusCode: Number(item.statusCode),
    latency: Number(item.latency),
    promptTokens: Number(item.promptTokens),
    completionTokens: Number(item.completionTokens),
    error: item.error === null ? null : String(item.error),
    timestamp: new Date(String(item.timestamp)),
  };
}

function accountById(id: string) {
  const row = database().prepare('SELECT * FROM Account WHERE id = $id').get({ $id: id });
  return row ? rowAccount(row) : null;
}

function leaseById(id: string) {
  const row = database().prepare('SELECT * FROM AccountLease WHERE id = $id').get({ $id: id });
  return row ? rowLease(row) : null;
}

function applyAccountUpdate(id: string, data: Record<string, unknown>) {
  const fields: string[] = [];
  const params: SqlParams = { $id: id, $updatedAt: nowIso() };

  for (const [key, value] of Object.entries(data)) {
    if (key === 'usageCount' && value && typeof value === 'object' && 'increment' in value) {
      fields.push('usageCount = usageCount + $usageIncrement');
      params.$usageIncrement = Number((value as { increment: number }).increment);
      continue;
    }
    fields.push(`${key} = $${key}`);
    params[`$${key}`] = value instanceof Date ? value.toISOString() : (value as SqlValue);
  }

  fields.push('updatedAt = $updatedAt');
  database().prepare(`UPDATE Account SET ${fields.join(', ')} WHERE id = $id`).run(params);
  const account = accountById(id);
  if (!account) throw new Error(`Account not found: ${id}`);
  return account;
}

function accountMatchesActiveWhere(account: Account, now: Date) {
  return account.status === 'active' || (account.status === 'exhausted' && account.quotaResetAt !== null && account.quotaResetAt <= now);
}

export const prisma = {
  async $connect() {},
  async $disconnect() {},
  async $queryRawUnsafe(sql: string) {
    database().exec(sql);
  },
  account: {
    async findMany(options: {
      where?: { id?: { notIn?: string[] }; OR?: Array<{ status: string; quotaResetAt?: { lte: Date } }> };
      orderBy?: { lastUsed?: 'asc'; createdAt?: 'desc'; name?: 'asc' };
      include?: { leases?: { where?: { leaseUntil?: { gt: Date } }; orderBy?: { leaseUntil: 'desc' }; take?: number } };
    } = {}) {
      const rows = database().prepare('SELECT * FROM Account').all().map(rowAccount);
      let accounts = rows;
      if (options.where?.id?.notIn) {
        const excluded = new Set(options.where.id.notIn);
        accounts = accounts.filter((account) => !excluded.has(account.id));
      }
      if (options.where?.OR) {
        const now = options.where.OR.find((entry) => entry.quotaResetAt)?.quotaResetAt?.lte ?? new Date();
        accounts = accounts.filter((account) => accountMatchesActiveWhere(account, now));
      }
      if (options.orderBy?.lastUsed === 'asc') {
        accounts.sort((a, b) => a.lastUsed.getTime() - b.lastUsed.getTime());
      } else if (options.orderBy?.createdAt === 'desc') {
        accounts.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      } else if (options.orderBy?.name === 'asc') {
        accounts.sort((a, b) => a.name.localeCompare(b.name));
      }
      if (!options.include?.leases) return accounts;

      const cutoff = options.include.leases.where?.leaseUntil?.gt;
      return accounts.map((account) => {
        let leases = database().prepare('SELECT * FROM AccountLease WHERE accountId = $accountId').all({ $accountId: account.id }).map(rowLease);
        if (cutoff) leases = leases.filter((lease) => lease.leaseUntil > cutoff);
        leases.sort((a, b) => b.leaseUntil.getTime() - a.leaseUntil.getTime());
        return { ...account, leases: leases.slice(0, options.include?.leases?.take ?? leases.length) };
      });
    },
    async count(options: { where?: { OR?: Array<{ status: string; quotaResetAt?: { lte: Date } }> } } = {}) {
      const accounts = database().prepare('SELECT * FROM Account').all().map(rowAccount);
      if (!options.where?.OR) return accounts.length;
      const now = options.where.OR.find((entry) => entry.quotaResetAt)?.quotaResetAt?.lte ?? new Date();
      return accounts.filter((account) => accountMatchesActiveWhere(account, now)).length;
    },
    async findFirst(options: { where: { refreshToken?: string } }) {
      if (!options.where.refreshToken) return null;
      const row = database().prepare('SELECT * FROM Account WHERE refreshToken = $refreshToken LIMIT 1').get({ $refreshToken: options.where.refreshToken });
      return row ? rowAccount(row) : null;
    },
    async findUnique(options: { where: { id: string } }) {
      return accountById(options.where.id);
    },
    async create(options: { data: Partial<Account> & { name: string; refreshToken: string } }) {
      const id = options.data.id ?? randomUUID();
      const createdAt = nowIso();
      database().prepare(`
        INSERT INTO Account (id, name, email, refreshToken, status, lastUsed, usageCount, createdAt, updatedAt, quotaStatus, quotaResetAt, quotaMessage, quotaCheckedAt, leaseUntil)
        VALUES ($id, $name, $email, $refreshToken, $status, $lastUsed, $usageCount, $createdAt, $updatedAt, $quotaStatus, $quotaResetAt, $quotaMessage, $quotaCheckedAt, $leaseUntil)
      `).run({
        $id: id,
        $name: options.data.name,
        $email: options.data.email ?? null,
        $refreshToken: options.data.refreshToken,
        $status: options.data.status ?? 'active',
        $lastUsed: iso(options.data.lastUsed) ?? createdAt,
        $usageCount: options.data.usageCount ?? 0,
        $createdAt: iso(options.data.createdAt) ?? createdAt,
        $updatedAt: iso(options.data.updatedAt) ?? createdAt,
        $quotaStatus: options.data.quotaStatus ?? 'unknown',
        $quotaResetAt: iso(options.data.quotaResetAt),
        $quotaMessage: options.data.quotaMessage ?? null,
        $quotaCheckedAt: iso(options.data.quotaCheckedAt),
        $leaseUntil: iso(options.data.leaseUntil),
      });
      return accountById(id) as Account;
    },
    async update(options: { where: { id: string }; data: Record<string, unknown> }) {
      return applyAccountUpdate(options.where.id, options.data);
    },
    async upsert(options: { where: { id: string }; update: Record<string, unknown>; create: Partial<Account> & { name: string; refreshToken: string } }) {
      const existing = accountById(options.where.id);
      if (existing) {
        return Object.keys(options.update).length ? applyAccountUpdate(existing.id, options.update) : existing;
      }
      return this.create({ data: { ...options.create, id: options.where.id } });
    },
    async delete(options: { where: { id: string } }) {
      const account = accountById(options.where.id);
      database().prepare('DELETE FROM Account WHERE id = $id').run({ $id: options.where.id });
      if (!account) throw new Error(`Account not found: ${options.where.id}`);
      return account;
    },
  },
  accountLease: {
    async deleteMany(options: { where?: { id?: string; leaseUntil?: { lte?: Date } } } = {}) {
      if (options.where?.id) {
        return database().prepare('DELETE FROM AccountLease WHERE id = $id').run({ $id: options.where.id });
      }
      if (options.where?.leaseUntil?.lte) {
        return database().prepare('DELETE FROM AccountLease WHERE leaseUntil <= $leaseUntil').run({ $leaseUntil: options.where.leaseUntil.lte.toISOString() });
      }
      return database().prepare('DELETE FROM AccountLease').run();
    },
    async count(options: { where?: { leaseUntil?: { gt: Date } } } = {}) {
      if (options.where?.leaseUntil?.gt) {
        const row = database().prepare('SELECT COUNT(*) AS count FROM AccountLease WHERE leaseUntil > $leaseUntil').get({ $leaseUntil: options.where.leaseUntil.gt.toISOString() }) as { count: number };
        return Number(row.count);
      }
      const row = database().prepare('SELECT COUNT(*) AS count FROM AccountLease').get() as { count: number };
      return Number(row.count);
    },
    async findUnique(options: { where: { accountId_slot?: { accountId: string; slot: number }; id?: string } }) {
      const row = options.where.accountId_slot
        ? database().prepare('SELECT * FROM AccountLease WHERE accountId = $accountId AND slot = $slot').get({
            $accountId: options.where.accountId_slot.accountId,
            $slot: options.where.accountId_slot.slot,
          })
        : database().prepare('SELECT * FROM AccountLease WHERE id = $id').get({ $id: options.where.id ?? '' });
      return row ? rowLease(row) : null;
    },
    async findUniqueOrThrow(options: { where: { id: string } }) {
      const lease = leaseById(options.where.id);
      if (!lease) throw new Error(`Lease not found: ${options.where.id}`);
      return lease;
    },
    async updateMany(options: { where: { id: string; leaseUntil?: { lte: Date } }; data: { leaseUntil: Date } }) {
      const result = database().prepare('UPDATE AccountLease SET leaseUntil = $newLeaseUntil, updatedAt = $updatedAt WHERE id = $id AND leaseUntil <= $oldLeaseUntil').run({
        $id: options.where.id,
        $oldLeaseUntil: options.where.leaseUntil?.lte.toISOString() ?? nowIso(),
        $newLeaseUntil: options.data.leaseUntil.toISOString(),
        $updatedAt: nowIso(),
      });
      return { count: result.changes };
    },
    async create(options: { data: { accountId: string; slot: number; leaseUntil: Date } }) {
      const id = randomUUID();
      const createdAt = nowIso();
      database().prepare('INSERT INTO AccountLease (id, accountId, slot, leaseUntil, createdAt, updatedAt) VALUES ($id, $accountId, $slot, $leaseUntil, $createdAt, $updatedAt)').run({
        $id: id,
        $accountId: options.data.accountId,
        $slot: options.data.slot,
        $leaseUntil: options.data.leaseUntil.toISOString(),
        $createdAt: createdAt,
        $updatedAt: createdAt,
      });
      return leaseById(id) as AccountLease;
    },
  },
  requestLog: {
    async create(options: { data: { accountId: string; model: string; statusCode: number; latency: number; promptTokens: number; completionTokens: number; error?: string | null } }) {
      const id = randomUUID();
      database().prepare(`
        INSERT INTO RequestLog (id, accountId, model, statusCode, latency, promptTokens, completionTokens, error, timestamp)
        VALUES ($id, $accountId, $model, $statusCode, $latency, $promptTokens, $completionTokens, $error, $timestamp)
      `).run({
        $id: id,
        $accountId: options.data.accountId,
        $model: options.data.model,
        $statusCode: options.data.statusCode,
        $latency: options.data.latency,
        $promptTokens: options.data.promptTokens,
        $completionTokens: options.data.completionTokens,
        $error: options.data.error ?? null,
        $timestamp: nowIso(),
      });
    },
    async findMany(options: { where?: { timestamp?: { gte: Date } }; include?: { account?: true | { select: { name: true } } }; orderBy?: { timestamp: 'desc' }; take?: number } = {}) {
      let logs = database().prepare('SELECT * FROM RequestLog').all().map(rowLog);
      if (options.where?.timestamp?.gte) {
        const cutoff = options.where.timestamp.gte;
        logs = logs.filter((log) => log.timestamp >= cutoff);
      }
      if (options.orderBy?.timestamp === 'desc') {
        logs.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
      }
      if (options.take) logs = logs.slice(0, options.take);
      if (!options.include?.account) return logs;

      return logs.map((log) => {
        const account = accountById(log.accountId);
        if (typeof options.include?.account === 'object') {
          return { ...log, account: account ? { name: account.name } : null };
        }
        return { ...log, account };
      });
    },
  },
};
