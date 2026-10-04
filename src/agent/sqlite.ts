/** Local SQLite storage. Transactions hold the queue until commit or rollback. */
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';

export type InStatement = string | { sql: string; args?: SQLInputValue[] };
export interface QueryResult {
  rows: Record<string, SQLOutputValue>[];
  columns: string[];
  rowsAffected: number;
  lastInsertRowid?: number | bigint;
}
export class LocalClient {
  #database;
  #queue = Promise.resolve();
  #closed = false;

  constructor(path: string) { this.#database = new DatabaseSync(path, { timeout: 5000 }); }

  async #acquire() {
    let release!: () => void;
    const previous = this.#queue;
    this.#queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    if (this.#closed) { release(); throw new Error('SQLite client is closed'); }
    return release;
  }

  #execute(input: InStatement): QueryResult {
    const { sql, args = [] } = typeof input === 'string' ? { sql: input } : input;
    try {
      const statement = this.#database.prepare(sql);
      const columns = statement.columns().map(column => column.name);
      if (columns.length) return { rows: statement.all(...args), columns, rowsAffected: 0 };
      const result = statement.run(...args);
      return { rows: [], columns, rowsAffected: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
    } catch (error) {
      // AgentStore uses this code to distinguish ID collisions from general failures.
      const sqliteError = error as Error & { errcode?: number; code?: string };
      if (sqliteError.errcode !== undefined && (sqliteError.errcode & 255) === 19) sqliteError.code = 'SQLITE_CONSTRAINT';
      throw error;
    }
  }

  async execute(statement: InStatement) {
    const release = await this.#acquire();
    try { return this.#execute(statement); } finally { release(); }
  }

  async batch(statements: InStatement[], mode: 'write' | 'read' = 'write') {
    const transaction = await this.transaction(mode);
    try {
      const results = [];
      for (const statement of statements) results.push(await transaction.execute(statement));
      await transaction.commit(); return results;
    } catch (error) { await transaction.rollback(); throw error; }
    finally { transaction.close(); }
  }

  async transaction(mode: 'write' | 'read' = 'write') {
    const release = await this.#acquire();
    try { this.#database.exec(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN'); }
    catch (error) { release(); throw error; }
    let active = true;
    const finish = (command: 'COMMIT' | 'ROLLBACK') => {
      if (!active) return;
      try { this.#database.exec(command); }
      catch (error) {
        if (command === 'COMMIT') this.#database.exec('ROLLBACK');
        throw error;
      } finally { active = false; release(); }
    };
    return {
      execute: async (statement: InStatement) => {
        if (!active) throw new Error('SQLite transaction is closed');
        return this.#execute(statement);
      },
      commit: async () => finish('COMMIT'),
      rollback: async () => finish('ROLLBACK'),
      close: () => finish('ROLLBACK'),
    };
  }

  close() { this.#closed = true; this.#database.close(); }
}
