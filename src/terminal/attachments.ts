import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const imageMediaTypes: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
};

/** Recognize a paste containing only local file paths, leaving prose intact. */
export async function pastedFilePaths(text: string, root: string): Promise<string[] | null> {
  const tokens = text.trim().match(/"[^"]*"|'[^']*'|(?:\\ |[^\s])+/g);
  if (!tokens?.length) return null;
  const paths = tokens.map(token => {
    const value = /^(["']).*\1$/.test(token) ? token.slice(1, -1) : token.replace(/\\ /g, ' ');
    if (value.startsWith('file://')) {
      try { return fileURLToPath(value); } catch { return ''; }
    }
    return value.replace(/^~(?=[\\/])/, homedir());
  });
  if (paths.some(path => !isAbsolute(path) && !/^\.\.?[\\/]/.test(path))) return null;
  const resolved = paths.map(path => resolve(root, path));
  const files = await Promise.all(resolved.map(path => stat(path).then(info => info.isFile()).catch(() => false)));
  return files.every(Boolean) ? resolved : null;
}
