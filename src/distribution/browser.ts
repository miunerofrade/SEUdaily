import { readFile } from 'node:fs/promises';
import { createConnection } from '@playwright/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const server = await createConnection({ ...config, browser: { ...config.browser, isolated: true },
  imageResponses: 'omit', snapshot: { mode: 'full' } } as any);
await server.connect(new StdioServerTransport());
