import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
/** Stop descendants before their parent, including children that changed process groups. */
export async function terminateProcessTree(pid: number) {
    if (process.platform === 'win32') {
        await execute('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(error => {
            if (error.code !== 128)
                throw error; // The process has already exited.
        });
        return;
    }
    const { stdout } = await execute('ps', ['-A', '-o', 'pid=,ppid=']);
    const parents = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    const owned = [pid];
    for (let index = 0; index < owned.length; index++)
        for (const [child, parent] of parents)
            if (parent === owned[index])
                owned.push(child);
    for (const processId of owned.reverse()) {
        try {
            process.kill(processId, 'SIGKILL');
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
                throw error;
        }
    }
}
