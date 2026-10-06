import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClipboard } from '../src/terminal/clipboard.ts';
import { isClipboardPaste } from '../src/terminal/keyboard.ts';
import { Session } from '../src/terminal/session.ts';

test('clipboard shortcuts and SSH keep native terminal paste available', async () => {
  for (const key of [{ctrl:true}, {meta:true}, {super:true}]) assert.equal(isClipboardPaste('v', key), true);
  assert.equal(isClipboardPaste('v', {}), false);
  assert.equal(isClipboardPaste('c', {ctrl:true}), false);
  await assert.rejects(readClipboard('linux', {SSH_TTY:'pts/1'}, async () => { throw new Error('must not read host clipboard'); }), /SSH/);
});
test('Windows clipboard image uploads and is retained as a conversation reference', async () => {
  const bytes = Buffer.from('clipboard-image');
  const content = await readClipboard('win32', {}, async (command, args) => {
    assert.equal(command, 'powershell.exe'); assert.ok(args.includes('-STA'));
    return Buffer.from(JSON.stringify({image:bytes.toString('base64')}));
  });
  const session = new Session({command:'chat'}, '/tmp');
  session.client.json = async (route, method, body) => {
    assert.equal(route, '/app/images'); assert.equal(body.dataUrl, 'data:image/png;base64,'+bytes.toString('base64'));
    return {ref:'clipboard.png',name:'clipboard.png',mediaType:'image/png'};
  };
  assert.deepEqual(await session.attachClipboardImage(content.image, content.mediaType), {id:'clipboard.png',name:'clipboard.png',kind:'图片'});
  assert.equal(session.images[0].ref, 'clipboard.png');
  session.images = Array(10).fill({ref:'fixture'});
  await assert.rejects(session.attachClipboardImage(bytes,'image/png'), /最多 10/);
});
test('Wayland falls back to text and reports missing clipboard utilities', async () => {
  const content = await readClipboard('linux', {WAYLAND_DISPLAY:'wayland-0'}, async (_command,args) => {
    if (args.includes('image/png') || args.includes('text/uri-list')) throw new Error('no image or files');
    return Buffer.from('多行\n文本');
  });
  assert.deepEqual(content, {text:'多行\n文本'});
  await assert.rejects(readClipboard('linux', {}, async () => Buffer.alloc(0)), /无法读取/);
  await assert.rejects(readClipboard('win32', {}, async () => Buffer.from(JSON.stringify({image:Buffer.alloc(10*1024*1024+1).toString('base64')}))), /10 MB/);
});
test('macOS falls back from image data to pbpaste without shell interpolation', async () => {
  const calls = [];
  const value = await readClipboard('darwin', {}, async (command,args) => {
    calls.push([command,args]);
    if (command === 'osascript') throw new Error('no image');
    return Buffer.from('$(do not execute)');
  });
  assert.deepEqual(value, {text:'$(do not execute)'});
  assert.equal(calls.at(-1)[0], 'pbpaste');
});

test('macOS image reader AppleScript compiles without accessing the live clipboard', {skip:process.platform!=='darwin'}, async t => {
  const {mkdtemp,rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const directory = await mkdtemp(join(tmpdir(),'seudaily-script-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  await readClipboard('darwin',{},async (command,args) => {
    if(command==='osascript' && args.at(-1).endsWith('clipboard.png')) {
      await promisify(execFile)('osacompile',['-o',join(directory,'reader.scpt'),'-e',args[1]]);
    }
    if(command==='osascript') throw new Error('do not read real clipboard');
    return Buffer.from('fixture');
  });
});
