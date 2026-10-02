import { mkdir, readFile, writeFile, readdir, realpath, stat, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { defineTool, type ToolDefinition, type ToolExecutionOptions } from '../agent/tool.js';
import { projectRoot, sandboxWorkspaceRoot, envValue } from './runtime-paths.js';
import { isFullAccessExtraEnabled, isUnapprovedAccessEnabled } from './permission-state.js';
import { createCommandSandbox, type CommandSandboxSelection } from './native-command-sandbox.js';
import { redactText } from '../agent/redaction.js';
const reads = new Map<string, string>();
let sandbox: CommandSandboxSelection | undefined;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const readKey = (path: string, options: ToolExecutionOptions) => `${options.requestContext?.get('seudailyThreadId') ?? ''}:${path}`;
const processes = new Map<string, {
    child: ChildProcess;
    output: string;
    exitCode: number | null;
    timer: NodeJS.Timeout;
    done: Promise<void>;
}>();
const result = (summary: string, data?: any) => ({ status: 'completed', taskId: `task-${randomUUID()}`, summary, data, artifacts: [], citations: [], warnings: [], metrics: {} });
const contained = (root: string, path: string) => { const diff = relative(root, path); return diff !== '..' && !diff.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(diff); };
export async function workspaceTarget(path: string, allowMissing = false): Promise<string> {
    if (isAbsolute(path))
        throw new Error('文件工具仅接受项目相对路径');
    const root = await realpath(projectRoot);
    const target = resolve(root, path);
    if (!contained(root, target))
        throw new Error('文件路径超出项目目录');
    let current = target;
    while (true) {
        try {
            const actual = await realpath(current);
            if (!contained(root, actual))
                throw new Error('符号链接超出项目目录');
            break;
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !allowMissing)
                throw error;
            const parent = dirname(current);
            if (parent === current)
                throw error;
            current = parent;
        }
    }
    return target;
}
function kill(child: ChildProcess) { if (!child.pid)
    return; if (process.platform === 'win32')
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
else {
    try {
        process.kill(-child.pid, 'SIGKILL');
    }
    catch {
        child.kill('SIGKILL');
    }
} }
export function closeWorkspace() { for (const process of processes.values()) {
    clearTimeout(process.timer);
    kill(process.child);
} processes.clear(); }
async function unchanged(path: string, options: ToolExecutionOptions) { const current = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT')
    return null; throw error; }); if (current !== null && reads.get(readKey(path, options)) !== digest(current))
    throw new Error('请先读取当前文件再编辑；文件可能已变化'); }
export async function getWorkspaceTools(): Promise<Record<string, ToolDefinition>> {
    await mkdir(sandboxWorkspaceRoot, { recursive: true });
    sandbox ??= createCommandSandbox({ projectRoot, workingDirectory: sandboxWorkspaceRoot });
    const pathSchema = z.object({ path: z.string().default('.') });
    const wrap = (name: string, description: string, inputSchema: z.ZodType, execute: any, write = false) => defineTool({ id: `mastra_workspace_${name}`, description, inputSchema, requireApproval: () => write && !isUnapprovedAccessEnabled(), execute: async (input, options) => { if (!isFullAccessExtraEnabled())
            throw new Error('当前未开启工作区权限'); options.abortSignal?.throwIfAborted(); return execute(input, options); }, toModelOutput: output => ({ type: 'text', value: JSON.stringify(output).slice(0, 16000) }) });
    const tools: ToolDefinition[] = [
        wrap('read_file', '读取项目相对路径的文件；编辑前必须先读。', z.object({ path: z.string(), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }), async (input: any, options: ToolExecutionOptions) => { const target = await workspaceTarget(input.path); const info = await stat(target); if (info.size > 5 * 1024 * 1024)
            throw new Error('文件超过读取限制'); const text = await readFile(target, 'utf8'); reads.set(readKey(target, options), digest(text)); const lines = text.split('\n'); return result('文件已读取', { path: input.path, text: lines.slice((input.startLine ?? 1) - 1, input.endLine).join('\n').slice(0, 12000), totalLines: lines.length }); }),
        wrap('file_stat', '查看项目文件元信息。', pathSchema, async (input: any) => { const info = await stat(await workspaceTarget(input.path)); return result('文件信息', { size: info.size, isDirectory: info.isDirectory(), modifiedAt: info.mtime.toISOString() }); }),
        wrap('list_files', '列出项目目录的直接子项。', pathSchema, async (input: any) => result('目录内容', { entries: (await readdir(await workspaceTarget(input.path), { withFileTypes: true })).slice(0, 200).map(entry => ({ name: entry.name, isDirectory: entry.isDirectory() })) })),
        wrap('write_file', '写入项目文件；已有文件必须先读取。', z.object({ path: z.string(), content: z.string().max(1000000) }), async (input: any, options: ToolExecutionOptions) => { const target = await workspaceTarget(input.path, true); await unchanged(target, options); options.abortSignal?.throwIfAborted(); await mkdir(dirname(target), { recursive: true }); await writeFile(target, input.content); reads.set(readKey(target, options), digest(input.content)); return result('文件已写入', { path: input.path }); }, true),
        wrap('edit_file', '精确替换项目文件中的一处文本；必须先读取。', z.object({ path: z.string(), oldText: z.string().min(1), newText: z.string() }), async (input: any, options: ToolExecutionOptions) => { const target = await workspaceTarget(input.path); await unchanged(target, options); const text = await readFile(target, 'utf8'); if (text.split(input.oldText).length !== 2)
            throw new Error('待替换文本必须唯一匹配'); options.abortSignal?.throwIfAborted(); const next = text.replace(input.oldText, () => input.newText); await writeFile(target, next); reads.set(readKey(target, options), digest(next)); return result('文件已修改', { path: input.path }); }, true),
        wrap('mkdir', '创建项目目录。', pathSchema, async (input: any) => { await mkdir(await workspaceTarget(input.path, true), { recursive: true }); return result('目录已创建'); }, true),
        wrap('delete', '删除明确指定的项目文件或空目录。', pathSchema, async (input: any) => { const target = await workspaceTarget(input.path); if (target === await realpath(projectRoot))
            throw new Error('不能删除项目根目录'); await rm(target); return result('文件已删除'); }, true),
        wrap('grep', '在项目目录中按字面文本搜索，跳过依赖和运行数据。', z.object({ path: z.string().default('.'), pattern: z.string().min(1) }), async (input: any) => { const hits: any[] = []; let visited = 0; const walk = async (directory: string) => { if (visited++ > 1000 || hits.length >= 100)
            return; for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (entry.isSymbolicLink() || ['node_modules', '.git', '.seudaily', '.venv'].includes(entry.name))
                continue;
            const target = resolve(directory, entry.name);
            if (entry.isDirectory())
                await walk(target);
            else if (entry.isFile() && (await stat(target)).size < 1024 * 1024) {
                const lines = (await readFile(target, 'utf8')).split('\n');
                lines.forEach((line, index) => { if (hits.length < 100 && line.includes(input.pattern))
                    hits.push({ path: relative(projectRoot, target), line: index + 1, text: line.slice(0, 300) }); });
            }
        } }; const target = await workspaceTarget(input.path); if (!(await stat(target)).isDirectory())
            throw new Error('搜索路径必须为目录'); await walk(target); return result('搜索完成', { hits }); }),
        wrap('execute_command', `执行命令：${sandbox.detail}。默认超时120秒，可启动后台进程。`, z.object({ command: z.string().min(1), background: z.boolean().default(false), timeout: z.number().int().positive().max(600000).optional() }), async (input: any, options: ToolExecutionOptions) => { const launch = sandbox!.wrap(input.command); const environment = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'LANG', 'TMPDIR', 'TEMP', 'TMP'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])); const child = spawn(launch.command, launch.args, { cwd: sandboxWorkspaceRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true }); const id = `process-${randomUUID()}`; let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; }); const timer = setTimeout(() => kill(child), input.timeout ?? (Number(envValue('SEUDAILY_WORKSPACE_COMMAND_TIMEOUT_MS')) || 120000)); const commandProcess = { child, output: '', exitCode: null as number | null, timer, done }; processes.set(id, commandProcess); const capture = (chunk: Buffer) => { commandProcess.output = (commandProcess.output + redactText(chunk.toString())).slice(-64000); }; child.stdout?.on('data', capture); child.stderr?.on('data', capture); const abort = () => kill(child); options.abortSignal?.addEventListener('abort', abort, { once: true }); child.on('error', error => { capture(Buffer.from(error.message)); commandProcess.exitCode = -1; clearTimeout(timer); finish(); }); child.on('close', code => { commandProcess.exitCode = code ?? -1; clearTimeout(timer); options.abortSignal?.removeEventListener('abort', abort); finish(); }); if (!input.background)
            await done; return result(input.background ? '后台命令已启动' : '命令已结束', { processId: id, exitCode: commandProcess.exitCode, output: commandProcess.output.slice(-10000), sandboxMode: sandbox!.mode, sandboxDetail: sandbox!.detail, workingDirectory: sandbox!.mode === 'wsl-bwrap' ? '/workspace' : sandboxWorkspaceRoot, projectDirectory: sandbox!.mode === 'wsl-bwrap' ? '/project' : projectRoot }); }, true),
        wrap('get_process_output', '查看本运行时启动的命令输出。', z.object({ processId: z.string() }), async (input: any) => { const commandProcess = processes.get(input.processId); if (!commandProcess)
            throw new Error('进程不存在'); return result('进程输出', { exitCode: commandProcess.exitCode, output: commandProcess.output.slice(-8000) }); }),
        wrap('kill_process', '停止本运行时启动的命令及子进程。', z.object({ processId: z.string() }), async (input: any) => { const commandProcess = processes.get(input.processId); if (!commandProcess)
            throw new Error('进程不存在'); kill(commandProcess.child); await commandProcess.done; return result('进程已停止'); }, true),
    ];
    return Object.fromEntries(tools.map(tool => [tool.id, tool]));
}
