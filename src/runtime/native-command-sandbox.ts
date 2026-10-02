import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { envValue } from './runtime-paths.js';
export type CommandSandboxMode = 'wsl-bwrap' | 'host-fallback' | 'native';
export type CommandSandboxSelection = {
    mode: CommandSandboxMode;
    detail: string;
    wrap(command: string): {
        command: string;
        args: string[];
    };
};
const available = (name: string) => spawnSync(name, ['--help'], { stdio: 'ignore', timeout: 3000 }).error === undefined;
const wslPath = (path: string) => { const match = /^([A-Za-z]):[\\/](.*)$/.exec(path); if (!match)
    throw new Error('WSL 需要盘符路径'); return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`; };
export function createCommandSandbox(options: {
    projectRoot: string;
    workingDirectory: string;
}): CommandSandboxSelection {
    const allowNetwork = /^(1|true|yes|on)$/i.test(envValue('SEUDAILY_SANDBOX_NETWORK') ?? 'false');
    if (process.platform === 'win32') {
        const distro = envValue('SEUDAILY_WSL_DISTRO')?.trim() || 'Ubuntu-24.04';
        const enabled = !/^(0|false|no|off)$/i.test(envValue('SEUDAILY_WSL_SANDBOX') ?? 'true');
        const found = enabled && spawnSync('wsl.exe', ['-d', distro, '--exec', 'sh', '-lc', 'command -v bwrap >/dev/null 2>&1'], { stdio: 'ignore', timeout: 5000, windowsHide: true }).status === 0;
        if (found)
            return { mode: 'wsl-bwrap', detail: 'WSL2 + Bubblewrap；项目只读 /project，可写 /workspace', wrap: command => ({ command: 'wsl.exe', args: ['-d', distro, '--exec', 'bwrap', '--die-with-parent', '--new-session', '--unshare-all', ...(allowNetwork ? ['--share-net'] : []), '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--ro-bind', '/etc', '/etc', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--dir', '/tmp/home', '--ro-bind', wslPath(options.projectRoot), '/project', '--bind', wslPath(options.workingDirectory), '/workspace', '--chdir', '/workspace', '--clearenv', '--setenv', 'HOME', '/tmp/home', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8', '--', 'bash', '-lc', command] }) };
    }
    else if (process.platform === 'darwin' && available('/usr/bin/sandbox-exec')) {
        const writable = JSON.stringify(realpathSync(options.workingDirectory));
        const readonlyProject = JSON.stringify(realpathSync(options.projectRoot));
        const profile = `(version 1)(deny default)(allow process-exec)(allow process-fork)(allow process-info* (target same-sandbox))(allow signal (target same-sandbox))(allow mach-lookup)(allow ipc-posix-shm)(allow ipc-posix-sem)(allow user-preference-read)(allow sysctl-read)(allow file-read*)(allow file-ioctl)(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty"))(deny file-write* (require-all (subpath ${readonlyProject}) (require-not (subpath ${writable}))))(allow file-write* (subpath ${writable}) (require-all (subpath "/private/tmp") (require-not (subpath ${readonlyProject}))) (require-all (subpath "/var/folders") (require-not (subpath ${readonlyProject}))) (require-all (subpath "/private/var/folders") (require-not (subpath ${readonlyProject}))))${allowNetwork ? '(allow network*)' : '(deny network*)'}`;
        return { mode: 'native', detail: `macOS Seatbelt；项目只读，暂存区可写，网络${allowNetwork ? '允许' : '禁止'}`, wrap: command => ({ command: '/usr/bin/sandbox-exec', args: ['-p', profile, '/bin/sh', '-c', command] }) };
    }
    else if (process.platform === 'linux' && available('bwrap')) {
        return { mode: 'native', detail: `Linux Bubblewrap；项目只读，暂存区可写，网络${allowNetwork ? '允许' : '禁止'}`, wrap: command => ({ command: 'bwrap', args: ['--die-with-parent', '--new-session', '--unshare-all', ...(allowNetwork ? ['--share-net'] : []), '--ro-bind', '/', '/', '--bind', options.workingDirectory, options.workingDirectory, '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--chdir', options.workingDirectory, '--', '/bin/sh', '-c', command] }) };
    }
    return { mode: 'host-fallback', detail: '宿主机兼容执行，仅约束工作目录、环境、超时与进程管理；没有系统级文件或网络隔离', wrap: command => ({ command: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', args: process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command] }) };
}
