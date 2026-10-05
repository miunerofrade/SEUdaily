import { terminateProcessTree } from '../process-tree.js';
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
import { playwrightBrowserConfig, browserChildEnvironment } from './browser-config.js';
import browserCatalog from './browser-catalog.json' with { type: 'json' };
const allowed = new Set(['browser_find', 'browser_press_key', 'browser_type', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_select_option', 'browser_tabs']);
const writes = new Set(['browser_click', 'browser_press_key', 'browser_select_option', 'browser_type']);
type BrowserState = { transport?: StdioClientTransport; client?: Client; proxy?: string; loading?: Promise<Record<string, ToolDefinition>>; timer?: ReturnType<typeof setTimeout>; activeCalls: number };
const browsers = new Map<string, BrowserState>();
function scheduleIdleClose(scope: string, state: BrowserState) {
    clearTimeout(state.timer);
    if (state.activeCalls) return;
    state.timer = setTimeout(() => void closeBrowserTools(scope), 900000);
    state.timer.unref();
}
async function connect(scope: string, state: BrowserState): Promise<Record<string, ToolDefinition>> {
    state.proxy = await campusProxy();
    const outputDir = resolve(projectRoot, '.seudaily', 'browser');
    mkdirSync(outputDir, { recursive: true });
    const configPath = resolve(outputDir, `playwright-${scope.replace(/[^a-zA-Z0-9-]/g, '_')}.json`);
    writeFileSync(configPath, JSON.stringify(playwrightBrowserConfig(process.platform, envValue('SEUDAILY_BROWSER'), state.proxy)));
    const managed = !!process.env.SEUDAILY_INSTALL_ROOT;
    const engine = await import('../../distribution/browser-engine.js');
    const entry = managed ? await engine.browserComponent(envValue('SEUDAILY_BROWSER')) : resolve(projectRoot, 'node_modules', '@playwright', 'mcp', 'cli.js');
    if (!managed) await engine.prepareBrowserEngine(projectRoot, envValue('SEUDAILY_BROWSER'));
    const connection = new Client({ name: 'seudaily-playwright', version: '1.1.0' });
    const transport = new StdioClientTransport({ command: process.execPath, cwd: projectRoot, stderr: 'pipe',
        env: browserChildEnvironment(),
        args: managed ? [entry, configPath] : [entry, '--config', configPath, '--headless', '--isolated', '--block-service-workers', '--codegen', 'none', '--image-responses', 'omit', '--snapshot-mode', 'full', '--output-dir', outputDir] });
    state.transport = transport;
    transport.stderr?.on('data', () => { });
    connection.onclose = () => { if (state.client === connection) { state.client = undefined; state.loading = undefined; } };
    try {
        await connection.connect(transport, { timeout: 30000 });
        state.client = connection;
        scheduleIdleClose(scope, state);
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
                        const owner = String(options.requestContext?.get('seudailyThreadId') || scope);
                        if (scope !== owner) {
                            const owned = await connectedBrowserTools(owner);
                            return owned[id].execute(args, options);
                        }
                        clearTimeout(state.timer);
                        state.activeCalls++;
                        let cancellation: Promise<void> | undefined;
                        const abort = () => { cancellation ??= closeBrowserTools(scope); };
                        options.abortSignal?.addEventListener('abort', abort, {once:true});
                        if (options.abortSignal?.aborted) abort();
                        let response;
                        try {
                            response = await connection.callTool({ name: tool.name, arguments: args as any }, undefined, { signal: options.abortSignal, timeout: 60000 });
                        } finally {
                            options.abortSignal?.removeEventListener('abort', abort);
                            await cancellation;
                            state.activeCalls--;
                            if (state.client === connection) scheduleIdleClose(scope, state);
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
async function connectedBrowserTools(scope = 'shared'): Promise<Record<string, ToolDefinition>> {
    let state = browsers.get(scope);
    if (!state) { state = {activeCalls:0}; browsers.set(scope,state); }
    if (state.client && state.proxy !== await campusProxy()) { await closeBrowserTools(scope); return connectedBrowserTools(scope); }
    if (!state.loading) state.loading = connect(scope,state).catch(error => {state!.loading = undefined; throw error;});
    return state.loading;
}
// Generated from the pinned MCP version: discovering tools needs metadata, not a browser.
export async function getPlaywrightBrowserTools(scope = 'shared'): Promise<Record<string, ToolDefinition>> {
    return Object.fromEntries(browserCatalog.map(tool => {
        const id = `playwright_${tool.name}`;
        return [id, defineTool({ id, description: tool.description ?? tool.name,
            inputSchema: z.fromJSONSchema(tool.inputSchema as any),
            requireApproval: (_input, options) => !isUnapprovedAccessEnabled(options) && writes.has(tool.name),
            execute: async (args, options) => {
                options.abortSignal?.throwIfAborted();
                const owner = String(options.requestContext?.get('seudailyThreadId') || scope);
                const tools = await connectedBrowserTools(owner);
                return tools[id].execute(args, options);
            }, toModelOutput: output => ({ type: 'text', value: output.data.text }) })];
    }));
}
export function isBrowserApprovalRequired(name: string) { return writes.has(name.replace(/^playwright_/, '')); }
export async function closeBrowserTools(scope?: string) {
    const targets = scope ? [[scope,browsers.get(scope)] as const] : [...browsers.entries()];
    await Promise.all(targets.map(async ([name,state]) => {
        if (!state) return;
        browsers.delete(name); clearTimeout(state.timer);
        const connection = state.client;
        if (!connection && state.loading) await state.loading.catch(() => {});
        const pid = state.transport?.pid;
        if (pid) await terminateProcessTree(pid);
        await (connection ?? state.client)?.close();
    }));
}
