import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { envValue } from './runtime-paths.js';
export type CommandSandboxMode = 'wsl-bwrap' | 'host-fallback' | 'native';
export type CommandSandboxSelection = {
    mode: CommandSandboxMode;
    detail: string;
    wrap(command: string): { command: string; args: string[] };
};
const available = (name: string) => spawnSync(name, ['--help'], { stdio: 'ignore', timeout: 3000 }).error === undefined;
const wslPath = (path: string) => {
    const match = /^([A-Za-z]):[\\/](.*)$/.exec(path);
    if (!match) throw new Error('WSL 需要盘符路径');
    return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`;
};
const sensitivePattern = /^(?:\.env(?:\.[^/]*)?|\.git|\.seudaily|\.cvstream|\.ssh|\.aws|\.azure|\.config|credentials|secrets|[^/]*\.(?:[pP][eE][mM]|[kK][eE][yY]|[pP]12|[pP][fF][xX]))$/;
const sensitiveName = (name: string) => sensitivePattern.test(name);
function sensitivePaths(project: string) {
    const paths: Array<{ path: string; directory: boolean }> = [];
    const visit = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (sensitiveName(entry.name)) paths.push({ path, directory: entry.isDirectory() });
            else if (entry.isDirectory() && !['node_modules', '.venv', 'dist', '__pycache__'].includes(entry.name)) visit(path);
        }
    };
    visit(project);
    return paths;
}
const quote = (value: string) => JSON.stringify(value);
const regexEscape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createCommandSandbox(options: { projectRoot: string; workingDirectory: string }): CommandSandboxSelection {
    const allowNetwork = /^(1|true|yes|on)$/i.test(envValue('SEUDAILY_SANDBOX_NETWORK') ?? 'false');
    const project = realpathSync(options.projectRoot), workspace = realpathSync(options.workingDirectory);
    const networkDetail = `网络${allowNetwork ? '允许' : '禁止'}`;
    const bubblewrap = (projectTarget: string, workspaceTarget: string, windows = false) => {
        // A fresh filesystem exposes only executable/runtime libraries and selected public configuration.
        const systems = ['/usr/bin', '/usr/sbin', '/usr/lib', '/usr/lib64', '/usr/share', '/usr/local/bin', '/usr/local/lib', '/usr/local/lib64', '/bin', '/sbin', '/lib', '/lib64'];
        const configuration = ['/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d', '/etc/ssl/certs', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/localtime'];
        const bindings = [...systems, ...configuration].flatMap(path => ['--ro-bind-try', path, path]);
        const masks = sensitivePaths(project).flatMap(item => {
            const target = projectTarget + item.path.slice(project.length).replaceAll('\\', '/');
            return item.directory ? ['--tmpfs', target] : ['--ro-bind', '/dev/null', target];
        });
        return ['--die-with-parent', '--new-session', '--unshare-all', ...(allowNetwork ? ['--share-net'] : []), ...bindings,
            '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--dir', '/tmp/home',
            '--ro-bind', windows ? wslPath(project) : project, projectTarget, ...masks,
            '--bind', windows ? wslPath(workspace) : workspace, workspaceTarget,
            '--chdir', workspaceTarget, '--clearenv', '--setenv', 'HOME', '/tmp/home', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8', '--', '/bin/sh', '-c'];
    };
    if (process.platform === 'win32') {
        const distro = envValue('SEUDAILY_WSL_DISTRO')?.trim() || 'Ubuntu-24.04';
        const enabled = !/^(0|false|no|off)$/i.test(envValue('SEUDAILY_WSL_SANDBOX') ?? 'true');
        const found = enabled && spawnSync('wsl.exe', ['-d', distro, '--exec', 'sh', '-lc', 'command -v bwrap >/dev/null 2>&1'], { stdio: 'ignore', timeout: 5000, windowsHide: true }).status === 0;
        if (found) return { mode: 'wsl-bwrap', detail: `WSL2 + Bubblewrap；项目只读 /project，凭据隐藏，可写 /workspace，${networkDetail}`, wrap: command => ({ command: 'wsl.exe', args: ['-d', distro, '--exec', 'bwrap', ...bubblewrap('/project', '/workspace', true), command] }) };
    } else if (process.platform === 'darwin' && available('/usr/bin/sandbox-exec')) {
        const systemPaths = ['/bin', '/sbin', '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/share', '/usr/local/bin', '/usr/local/lib', '/usr/local/Cellar', '/usr/local/opt', '/opt/homebrew/bin', '/opt/homebrew/Cellar', '/opt/homebrew/opt', '/System/Library', '/System/Volumes/Preboot/Cryptexes/OS/usr/lib', '/System/Volumes/Preboot/Cryptexes/OS/System/Library', '/private/var/db/dyld', '/Library/Apple'];
        const publicFiles = ['/', '/dev/null', '/dev/zero', '/dev/tty', '/dev/random', '/dev/urandom', '/private/etc/localtime', '/private/etc/resolv.conf', '/private/etc/hosts'];
        const profile = `(version 1)(deny default)(allow process-exec)(allow process-fork)(allow process-info* (target same-sandbox))(allow signal (target same-sandbox))(allow mach-lookup)(allow ipc-posix-shm)(allow ipc-posix-sem)(allow sysctl-read)(allow file-read-metadata)(allow file-read* ${systemPaths.map(path => `(subpath ${quote(path)})`).join(' ')} ${publicFiles.map(path => `(literal ${quote(path)})`).join(' ')} (subpath ${quote(project)}) (subpath ${quote(workspace)}))(allow file-ioctl)(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty"))(allow file-write* (subpath ${quote(workspace)}))(deny file-read* (require-all (regex ${quote('^' + regexEscape(project) + '/(.*/)?' + sensitivePattern.source.slice(1, -1).replaceAll('(?:', '(') + '(/|$)')}) (require-not (subpath ${quote(workspace)}))))${allowNetwork ? '(allow network*)' : '(deny network*)'}`;
        return { mode: 'native', detail: `macOS Seatbelt；系统运行目录和项目只读，凭据隐藏，暂存区可写，${networkDetail}`, wrap: command => { const temporary = join(workspace, '.tmp'); mkdirSync(temporary, { recursive: true, mode: 0o700 }); return { command: '/usr/bin/sandbox-exec', args: ['-p', profile, '/usr/bin/env', `TMPDIR=${temporary}`, `TMP=${temporary}`, `TEMP=${temporary}`, `HOME=${workspace}`, '/bin/sh', '-c', command] }; } };
    } else if (process.platform === 'linux' && available('bwrap')) {
        return { mode: 'native', detail: `Linux Bubblewrap；系统运行目录和项目只读，凭据隐藏，暂存区可写，${networkDetail}`, wrap: command => ({ command: 'bwrap', args: [...bubblewrap(project, workspace), command] }) };
    }
    return { mode: 'host-fallback', detail: '宿主机兼容执行，仅约束工作目录、环境、超时与进程管理；没有系统级文件或网络隔离', wrap: command => ({ command: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', args: process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command] }) };
}
