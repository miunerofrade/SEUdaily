// Refresh metadata from the installed, pinned MCP service without opening a browser.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const allowed = new Set(['browser_find', 'browser_press_key', 'browser_type', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_select_option', 'browser_tabs']);
const client = new Client({ name: 'seudaily-browser-catalog', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js'), '--headless'], stderr: 'pipe' });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.filter(tool => allowed.has(tool.name));
  if (tools.length !== allowed.size) throw new Error('上游浏览器工具目录发生变化，请检查允许的工具列表。');
  await writeFile(new URL('../src/runtime/tools/browser-catalog.json', import.meta.url), JSON.stringify(tools, null, 2) + '\n');
} finally { await client.close(); }
