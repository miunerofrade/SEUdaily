import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectRoot } from './runtime-paths.js';
export async function campusProxy(): Promise<string | undefined> {
  try {
    const state = JSON.parse(await readFile(resolve(projectRoot, '.seudaily/vpn/status.json'), 'utf8'));
    if (state.state !== 'connected' || !Number.isInteger(state.ownerPid) || state.ownerPid <= 0) return;
    process.kill(state.ownerPid, 0);
    const url = new URL(state.httpProxy);
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && !url.username && !url.password) return url.origin;
  } catch { /* no active VPN */ }
}
