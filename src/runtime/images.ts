import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, resolve, extname } from 'node:path';
import { runtimeRoot } from './runtime-paths.js';
import type { ModelMessage, ContentPart } from '../agent/types.js';
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const root = resolve(runtimeRoot, 'uploads', 'images');
// Resolve once for both intake and model hydration; reject file symlinks and
// references outside the upload directory, while allowing a symlinked project.
async function imageTarget(name: string): Promise<string | null> {
  if (!name || basename(name) !== name) return null;
  const target = resolve(root, name);
  try {
    const [actual, canonicalRoot, info] = await Promise.all([realpath(target), realpath(root), stat(target)]);
    return actual === resolve(canonicalRoot, name) && info.isFile() && info.size > 0 && info.size <= MAX_IMAGE_BYTES
      ? target : null;
  } catch { return null; }
}

export async function persistImage(part: ContentPart): Promise<ContentPart> {
  const data = part.type === 'image' ? part.image : part.data;
  if (typeof data !== 'string') throw new Error('无效图片');
  if (/^(?:seudaily|cvstream)-image-ref:/.test(data)) {
    const name = data.replace(/^(?:seudaily|cvstream)-image-ref:/, '');
    if (!await imageTarget(name)) throw new Error('图片引用不存在、无效或超过 10MB');
    return { type: 'image_url', image_url: { url: data }, filename: part.filename, mediaType: part.mediaType };
  }
  const match = /^data:(image\/(png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(data);
  if (!match) throw new Error('图片必须为已上传的图片或支持的图片数据');
  const bytes = Buffer.from(match[3], 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('图片大小必须在 10MB 以内');
  const name = `${createHash('sha256').update(bytes).digest('hex')}.${match[2] === 'jpeg' ? 'jpg' : match[2]}`;
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, name), bytes, { mode: 0o600 });
  return { type: 'image_url', image_url: { url: `seudaily-image-ref:${name}` }, filename: name, mediaType: match[1] };
}
export async function hydrateImages(messages: ModelMessage[]): Promise<ModelMessage[]> {
  return Promise.all(messages.map(async message => {
    if (!Array.isArray(message.content)) return message;
    const content = await Promise.all(message.content.map(async part => {
      if (part.type !== 'image_url') return part;
      const url = part.image_url?.url;
      if (typeof url !== 'string') return null;
      if (url.startsWith('data:image/')) return { type: 'image_url', image_url: { url } };
      const name = url.replace(/^(?:seudaily|cvstream)-image-ref:/, '');
      if (name === url) return null;
      const target = await imageTarget(name);
      if (!target) return null;
      const mime = part.mediaType ?? (extname(name) === '.jpg' ? 'image/jpeg' : `image/${extname(name).slice(1)}`);
      return { type: 'image_url', image_url: { url: `data:${mime};base64,${(await readFile(target)).toString('base64')}` } };
    }));
    return { ...message, content: content.filter((part): part is ContentPart => part !== null) };
  }));
}
