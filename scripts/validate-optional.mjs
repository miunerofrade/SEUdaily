// Real private Python installation and platform-default browser; only local fixture traffic.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensurePython } from '../src/distribution/components.ts';
import { browserComponent } from '../src/distribution/browser-engine.ts';
const root = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(join(tmpdir(), 'seudaily-optional-validation-'));
async function health(python) {
  const child = spawn(python, ['-m', 'seudaily.worker'], { env: process.env, cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = '', errors = '';
  child.stdout.on('data', bytes => output += bytes);
  child.stderr.on('data', bytes => errors += bytes);
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(errors))); });
    child.stdin.end(JSON.stringify({ requestId: 'health-fixture', action: 'health', payload: {} }) + '\n');
    await exited;
    const response = JSON.parse(output.trim());
    assert.equal(response.result.status, 'completed');
  } finally { clearTimeout(timer); }
}
try {
  process.env.SEUDAILY_INSTALL_ROOT = root;
  process.env.SEUDAILY_PROJECT_ROOT = directory;
  process.env.SEUDAILY_CACHE_DIR = join(directory, 'cache');
  process.env.PYTHONUTF8 = '1';
  process.env.PYTHONIOENCODING = 'utf-8';
  const python = await ensurePython();
  await health(python);
  // CI supplies uv and a compatible Python: optional setup must reuse them.
  assert.ok(!existsSync(join(directory, 'cache', 'uv')), 'existing uv was not reused');
  assert.ok(!existsSync(join(directory, 'cache', 'python-runtime')), 'existing Python was not reused');
  const component = await browserComponent();
  const config = join(directory, 'browser.json');
  const engine = process.platform === 'darwin' ? 'webkit' : process.platform === 'win32' ? 'chromium' : 'firefox';
  await writeFile(config, JSON.stringify({ outputDir: join(directory, 'browser-output'), browser: { browserName: engine, launchOptions: { headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) } } }));
  process.env.PROBE_CHILD_COMMAND = JSON.stringify([process.execPath, component, config]);
  await (await import(pathToFileURL(join(root, 'build/validation/browser-client.mjs')))).run();
  await mkdir(join(root, 'build/validation'), { recursive: true });
  const report = { platform: process.platform, pythonInstallation: true, pythonWorker: true, browserEngine: engine, browser: { navigate: true, click: true, snapshot: true, close: true } };
  await writeFile(join(root, 'build/validation/optional-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await rm(directory, { recursive: true, force: true }); }
