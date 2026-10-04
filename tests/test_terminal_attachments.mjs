import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Composer } from '../src/terminal/composer.ts';
import { pastedFilePaths } from '../src/terminal/attachments.ts';
import { Session } from '../src/terminal/session.ts';

test('file paste recognizes quoted paths and file URLs, while retaining ordinary text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seudaily-attachment-'));
  const file = join(root, '文件 with spaces.png');
  try {
    await writeFile(file, 'fixture');
    assert.deepEqual(await pastedFilePaths(`"${file}"`, root), [file]);
    assert.deepEqual(await pastedFilePaths(pathToFileURL(file).href, root), [file]);
    assert.deepEqual(await pastedFilePaths(file.replaceAll(' ', '\\ '), root), [file]);
    assert.equal(await pastedFilePaths('请查看这个图片，然后总结', root), null);
    assert.equal(await pastedFilePaths(`${file}\n请总结`, root), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('attachment tokens move and delete atomically, but submitting preserves pending uploads', () => {
  const editor = new Composer();
  const removed = [];
  editor.onAttachmentRemoved = id => removed.push(id);
  editor.attachment('image-one', '截图.png', '图片');
  const end = editor.cursor;
  editor.set(editor.text, end - 1);
  assert.equal(editor.cursor, 0);
  editor.set(editor.text, 1);
  assert.equal(editor.cursor, end);
  editor.set(editor.text.slice(0, end - 1), end - 1);
  assert.equal(editor.text, '');
  assert.deepEqual(removed, ['image-one']);
  editor.attachment('image-two', '截图.png', '图片');
  editor.paste('说明一下');
  assert.equal(editor.expanded(), '说明一下');
  editor.clearAfterSubmit();
  assert.deepEqual(removed, ['image-one']);
  assert.equal(editor.text, '');
});

test('terminal image paste uploads the file and sends an image reference alongside the prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seudaily-attachment-'));
  const file = join(root, '截图.png');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const session = new Session({ command: 'chat' }, root);
  let sent;
  session.save = async () => {};
  session.nameThread = () => {};
  session.client.json = async (route, method, body) => {
    assert.equal(route, '/app/images');
    assert.equal(body.dataUrl, `data:image/png;base64,${png.toString('base64')}`);
    return { ref: 'fixture.png', name: '截图.png', mediaType: 'image/png' };
  };
  session.client.stream = async function* (body) {
    sent = body;
    yield { type: 'text-delta', payload: { text: 'fixture answer' } };
  };
  try {
    await writeFile(file, png);
    const tokens = await session.attachPastedFiles(`"${file}"`);
    assert.equal(tokens[0].kind, '图片');
    assert.equal(session.images.length, 1);
    assert.equal(await session.turn('说明一下'), 0);
    assert.equal(sent.messages[0].content[0].text, '说明一下');
    assert.equal(sent.messages[0].content[1].data, 'seudaily-image-ref:fixture.png');
    assert.equal(session.images.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('terminal accepts ten mixed attachments and rejects an eleventh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seudaily-attachment-limit-'));
  const session = new Session({ command: 'chat' }, root);
  session.client.json = async () => ({ ref: 'image', name: 'image.png', mediaType: 'image/png' });
  session.client.request = async () => ({ json: async () => ({ contextRef: 'document', filename: 'document.pdf' }) });
  try {
    const image = join(root, 'image.png'), document = join(root, 'document.pdf');
    await writeFile(image, 'image'); await writeFile(document, 'document');
    for (let index = 0; index < 10; index++) await session.attachFile(index % 2 ? document : image);
    assert.equal(session.images.length + session.documents.length, 10);
    await assert.rejects(session.attachFile(image), /最多 10/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
