import { campusProxy } from '../vpn-state.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { defineTool, type ToolDefinition } from '../../agent/tool.js';
import { envValue, projectRoot } from '../runtime-paths.js';
import { isUnapprovedAccessEnabled } from '../permission-state.js';
import { playwrightBrowserConfig } from './browser-config.js';
const allowed = new Set(['browser_find', 'browser_press_key', 'browser_type', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_select_option', 'browser_tabs']);
const writes = new Set(['browser_click', 'browser_press_key', 'browser_select_option', 'browser_type']);
let client: Client | undefined;
let clientProxy: string | undefined;
let loading: Promise<Record<string, ToolDefinition>> | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let activeCalls = 0;
function scheduleIdleClose(connection: Client) {
    clearTimeout(idleTimer);
    if (activeCalls) return;
    idleTimer = setTimeout(() => {
        if (client === connection) void connection.callTool({ name: 'browser_close' }).catch(() => {});
    }, 900000);
    idleTimer.unref();
}
async function connect() {
    clientProxy = await campusProxy();
    const outputDir = resolve(projectRoot, '.seudaily', 'browser');
    mkdirSync(outputDir, { recursive: true });
    const configPath = resolve(outputDir, 'playwright-config.json');
    writeFileSync(configPath, JSON.stringify(playwrightBrowserConfig(process.platform, envValue('SEUDAILY_BROWSER'), clientProxy)));
    const managed = !!process.env.SEUDAILY_INSTALL_ROOT;
    const entry = managed ? await (await import('../../distribution/browser-engine.js')).browserComponent() : resolve(projectRoot, 'node_modules', '@playwright', 'mcp', 'cli.js');
    const connection = new Client({ name: 'seudaily-playwright', version: '1.1.0' });
    const transport = new StdioClientTransport({ command: process.execPath, cwd: projectRoot, stderr: 'pipe', args: managed ? [entry, configPath] : [entry, '--config', configPath, '--headless', '--isolated', '--block-service-workers', '--codegen', 'none', '--image-responses', 'omit', '--snapshot-mode', 'full', '--output-dir', outputDir] });
    transport.stderr?.on('data', () => { });
    connection.onclose = () => { if (client === connection) {
        client = undefined;
        loading = undefined;
    } };
    try {
        await connection.connect(transport, { timeout: 30000 });
        client = connection;
        scheduleIdleClose(connection);
        const definitions = [];
        let cursor: string | undefined;
        do {
            const page = await connection.listTools(cursor ? { cursor } : undefined, { timeout: 30000 });
            definitions.push(...page.tools);
            cursor = page.nextCursor;
        } while (cursor);
        return Object.fromEntries(definitions.filter(tool => allowed.has(tool.name)).map(tool => {
            const id = `playwright_${tool.name}`;
            return [id, defineTool({ id, description: tool.description ?? tool.name, inputSchema: z.fromJSONSchema(tool.inputSchema as any), requireApproval: (_input, options) => !isUnapprovedAccessEnabled(options) && writes.has(tool.name), execute: async (args, options) => {
                        options.abortSignal?.throwIfAborted();
                        clearTimeout(idleTimer);
                        activeCalls++;
                        let response;
                        try {
                            response = await connection.callTool({ name: tool.name, arguments: args as any }, undefined, { signal: options.abortSignal, timeout: 60000 });
                        } finally {
                            activeCalls--;
                            if (client === connection) scheduleIdleClose(connection);
                        }
                        const text = (response.content as any[]).filter(part => part.type === 'text').map(part => part.text).join('\n').slice(0, 64000);
                        return { status: response.isError ? 'failed' : 'completed', taskId: `task-${randomUUID()}`, summary: response.isError ? text.slice(0, 500) : `${tool.name} 已完成`, data: { text }, artifacts: [], citations: [], warnings: [], metrics: {} };
                    }, toModelOutput: output => ({ type: 'text', value: output.data.text }) })];
        }));
    }
    catch (error) {
        await connection.close().catch(() => { });
        throw error;
    }
}
export async function getPlaywrightBrowserTools() {
    if (client && clientProxy !== await campusProxy()) await closeBrowserTools();
    if (!loading)
    loading = connect().catch(error => { loading = undefined; throw error; }); return loading; }
export function isBrowserApprovalRequired(name: string) { return writes.has(name.replace(/^playwright_/, '')); }
export async function closeBrowserTools() { clearTimeout(idleTimer); const connection = client; client = undefined; loading = undefined; await connection?.close(); }
