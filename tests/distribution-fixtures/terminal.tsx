/** Actual App/Session, with deterministic local API responses. */
import React from 'react';
import { render } from 'ink';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { App } from '../../src/terminal/app.js';
import { Session } from '../../src/terminal/session.js';
import { prepareTerminalInput, terminalKeyboard } from '../../src/terminal/keyboard.js';

export async function run() {
  const root = process.env.SEUDAILY_PROJECT_ROOT!;
  const record = (value: any) => appendFileSync(join(root, 'requests.jsonl'), JSON.stringify(value) + '\n');
  const observeInput = (bytes: unknown) => record({ input: String(bytes), at: Date.now() });
  const session = new Session({ command: 'chat' }, root);
  session.client.json = async (path: string, _method?: string, body?: any) => {
    if (path === '/app/agent-info') return { model: 'fixture-model', effort: 'high' };
    if (path === '/app/skills') return { skills: [] };
    if (path === '/app/images') { record({ image: body.name, uploaded: true }); return { ref: 'fixture.png', name: '截图.png', mediaType: 'image/png' }; }
    if (path.includes('/messages?')) return { messages: [] };
    if (path.includes('/run?')) return { pending: null };
    return { fields: [], status: 'completed' };
  };
  session.client.stream = async function* (body: any, signal: AbortSignal) {
    record({ messages: body.messages });
    if (body.messages === 'cancel-fixture') {
      yield { type: 'text-delta', payload: { text: '等待取消' } };
      await new Promise((_, reject) => signal.addEventListener('abort', () => { record({ cancelled: true }); reject(new Error('aborted')); }, { once: true }));
    } else {
      yield { type: 'text-delta', payload: { text: '流式中文' } };
      await new Promise(resolve => setTimeout(resolve, 100));
      yield { type: 'text-delta', payload: { text: '回答完成' } };
      yield { type: 'finish', payload: {} };
    }
  };
  await session.initialize();
  // ConPTY interprets/normalizes alternate-buffer sequences before forwarding output.
  // Observe the real writes without changing them, so Windows can verify teardown too.
  const originalWrite = process.stdout.write.bind(process.stdout);
  if (process.platform === 'win32') process.stdout.write = ((...args: any[]) => {
    const output = String(args[0]);
    if (output.includes('\x1b[?1049l')) writeFileSync(join(root, 'screen-restore-emitted'), 'true');
    // ConPTY may split/replace visible text with cursor updates in its VT stream.
    if (output.includes('fixture-model')) writeFileSync(join(root, 'model-rendered'), 'true');
    if (output.includes('回答完成')) writeFileSync(join(root, 'answer-rendered'), 'true');
    return (originalWrite as any)(...args);
  }) as typeof process.stdout.write;
  const initialRaw = process.stdin.isRaw ?? false;
  const restore = prepareTerminalInput(process.stdin);
  if (process.platform === 'win32') process.stdin.on('data', observeInput);
  try {
    const instance = render(<App session={session} />, { alternateScreen: true, exitOnCtrlC: false, maxFps: 60, kittyKeyboard: terminalKeyboard() });
    writeFileSync(join(root, 'ready'), JSON.stringify({ rss: process.memoryUsage().rss }));
    await instance.waitUntilExit(); await session.cancel();
    writeFileSync(join(root, 'clean-exit'), 'true');
  } finally {
    restore();
    process.stdin.off('data', observeInput);
    writeFileSync(join(root, 'input-restored'), String((process.stdin.isRaw ?? false) === initialRaw));
    process.stdout.write = originalWrite;
  }
}
