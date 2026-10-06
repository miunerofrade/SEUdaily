import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalClient } from '../src/agent/sqlite.ts';

test('unrelated work queues behind a transaction and survives its rollback', async t => {
  const client = new LocalClient(':memory:'); t.after(() => client.close());
  await client.execute('CREATE TABLE probe (id TEXT PRIMARY KEY)');
  const tx = await client.transaction('write');
  await tx.execute("INSERT INTO probe VALUES ('rolled-back')");
  let completed = false;
  const unrelated = client.execute("INSERT INTO probe VALUES ('retained')").then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  await tx.rollback(); tx.close(); await unrelated;
  assert.deepEqual((await client.execute('SELECT id FROM probe')).rows.map(row => row.id), ['retained']);
});

test('failed atomic batch maps constraint errors and releases the next request', async t => {
  const client = new LocalClient(':memory:'); t.after(() => client.close());
  await client.execute('CREATE TABLE probe (id TEXT PRIMARY KEY)');
  await client.execute("INSERT INTO probe VALUES ('original')");
  await assert.rejects(client.batch(["INSERT INTO probe VALUES ('temporary')", "INSERT INTO probe VALUES ('original')"]), { code: 'SQLITE_CONSTRAINT' });
  assert.deepEqual((await client.execute('SELECT id FROM probe')).rows.map(row => row.id), ['original']);
  await client.execute("INSERT INTO probe VALUES ('next')");
  assert.equal((await client.execute('SELECT COUNT(*) AS total FROM probe')).rows[0].total, 2);
});

test('closing waits for a transaction and already queued writes, rejects new work', async () => {
  const client = new LocalClient(':memory:');
  await client.execute('CREATE TABLE probe(id INTEGER)');
  const tx = await client.transaction();
  await tx.execute('INSERT INTO probe VALUES(1)');
  const queued = client.execute('INSERT INTO probe VALUES(2)');
  let closed = false;
  const closing = client.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  await assert.rejects(client.execute('SELECT 1'), /closed/);
  await tx.commit();
  await queued;
  await closing;
  await client.close();
});

test('file databases use WAL and durable commits survive reopening', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'seudaily-sqlite-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  let client = new LocalClient(join(directory,'agent.db'));
  assert.equal((await client.execute('PRAGMA journal_mode')).rows[0].journal_mode, 'wal');
  assert.equal((await client.execute('PRAGMA synchronous')).rows[0].synchronous, 2);
  await client.batch(['CREATE TABLE probe(id INTEGER)', 'INSERT INTO probe VALUES(42)']);
  await client.close();
  client = new LocalClient(join(directory,'agent.db'));
  assert.equal((await client.execute('SELECT id FROM probe')).rows[0].id, 42);
  await client.close();
});
