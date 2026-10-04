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
