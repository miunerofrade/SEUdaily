import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { browserChildEnvironment } from '../../src/runtime/tools/browser-config.js';

export async function run() {
const snapshotText = async (result: any) => {
  const text = result.content.map((part: any) => part.text ?? '').join('\n');
  const file = text.match(/\[Snapshot\]\(([^)]+)\)/)?.[1];
  // Navigation emits a snapshot link; browser_snapshot returns inline YAML.
  return file ? readFile(file, 'utf8') : text;
};
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end('<html><title>Probe fixture</title><button onclick="this.textContent=\'点击成功\'">测试按钮</button></html>');
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(server.address() as any).port}`;
const command = JSON.parse(process.env.PROBE_CHILD_COMMAND!);
const client = new Client({ name: 'phase-one-fixture', version: '1' });
const transport = new StdioClientTransport({ command: command[0], args: command.slice(1), env: browserChildEnvironment(), stderr: 'pipe' });
let errors = ''; transport.stderr?.on('data', data => { errors += data.toString(); });
try {
  await client.connect(transport, { timeout: 30000 });
  const tools = (await client.listTools()).tools;
  assert.ok(tools.some(tool => tool.name === 'browser_navigate'));
  const navigate = await client.callTool({ name: 'browser_navigate', arguments: { url } });
  assert.ok(!navigate.isError, JSON.stringify(navigate));
  const text = await snapshotText(navigate);
  assert.match(text, /测试按钮/);
  const ref = text.match(/button "测试按钮" \[ref=(\w+)\]/)?.[1];
  assert.ok(ref, text);
  const click = await client.callTool({ name: 'browser_click', arguments: { target: ref } });
  assert.ok(!click.isError, JSON.stringify(click));
  const snapshot = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  assert.match(await snapshotText(snapshot), /点击成功/);
  await client.callTool({ name: 'browser_close', arguments: {} });
  console.log(JSON.stringify({ tools: true, navigate: true, click: true, snapshot: true, close: true }));
} catch (error) { console.error(errors); throw error; }
finally { await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
