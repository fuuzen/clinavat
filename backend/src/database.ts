import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HttpError, type User } from './models.js';
import { ensureLocalHost } from './local-host.js';
import { initializeSchema } from './db/schema.js';
import { runMigrations } from './db/migrations.js';
import { runStartupRecovery } from './db/recovery.js';

export function databasePath(dataDirectory: string): string {
  return join(resolve(dataDirectory), 'clinavat.sqlite');
}

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const filename = databasePath(dataDir);
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    initializeSchema(this.db);
    runMigrations(this.db, this);
    runStartupRecovery(this);
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }

  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createUser(input: Omit<User, 'created_at'>, requireEmpty = false) {
    return this.transaction(() => {
      if (requireEmpty && this.get('SELECT id FROM users LIMIT 1')) throw new HttpError(409, '平台已初始化');
      if (this.get('SELECT id FROM users WHERE username=?', input.username)) throw new HttpError(409, '用户名已存在');
      this.run('INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,?)', input.id, input.username, input.password_hash, input.role);
      const user = this.get<User>('SELECT * FROM users WHERE id=?', input.id)!;
      if (user.role === 'admin') ensureLocalHost(this, user.id);
      return { user, slots: [] };
    });
  }

  close() {
    this.db.close();
  }
}
