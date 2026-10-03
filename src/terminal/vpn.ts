import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { config } from 'dotenv';

export async function runVpn(port: number, root: string): Promise<number> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('--vpn 端口应为 1024–65535');
  config({ path: resolve(root, '.env') });
  const value = (key: string) => process.env[`SEUDAILY_${key}`] ?? process.env[`CVSTREAM_${key}`];
  if (!value('USERNAME')?.trim() || !value('PASSWORD')?.trim())
    throw new Error('缺少校园账号或密码；请在项目 .env 或环境变量中配置 SEUDAILY_USERNAME 和 SEUDAILY_PASSWORD');
  const child = spawn('uv', ['run', 'python', '-m', 'seudaily.vpn', String(port)], {
    cwd: root, stdio: 'inherit', env: { ...process.env, SEUDAILY_PROJECT_ROOT: root },
  });
  const stop = () => child.kill('SIGTERM');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolve(code ?? 130));
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

if (process.argv[1]?.endsWith('/vpn.ts') || process.argv[1]?.endsWith('\\vpn.ts')) {
  runVpn(Number(process.argv[2]), resolve(process.env.SEUDAILY_PROJECT_ROOT ?? process.cwd()))
    .then(code => { process.exitCode = code; })
    .catch(error => { console.error(`SEUdaily：${error.message}`); process.exitCode = 1; });
}
