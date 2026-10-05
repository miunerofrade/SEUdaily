import { homedir } from 'node:os';
import { resolve } from 'node:path';
import metadata from '../../package.json' with { type: 'json' };
export const VERSION = process.env.SEUDAILY_BUILD_VERSION ?? metadata.version;
export const PROTOCOL = 1;
export function defaultDataRoot(platform = process.platform, environment = process.env): string {
  if (platform === 'win32') return resolve(environment.LOCALAPPDATA ?? resolve(homedir(), 'AppData', 'Local'), 'SEUdaily');
  if (platform === 'darwin') return resolve(homedir(), 'Library', 'Application Support', 'SEUdaily');
  return resolve(environment.XDG_DATA_HOME ?? resolve(homedir(), '.local', 'share'), 'seudaily');
}
export function defaultCacheRoot(): string {
  if (process.platform === 'win32') return resolve(process.env.LOCALAPPDATA ?? resolve(homedir(), 'AppData', 'Local'), 'SEUdaily', 'cache');
  if (process.platform === 'darwin') return resolve(homedir(), 'Library', 'Caches', 'SEUdaily');
  return resolve(process.env.XDG_CACHE_HOME ?? resolve(homedir(), '.cache'), 'seudaily');
}
