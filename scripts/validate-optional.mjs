// Real private Python installation and platform-default browser; only local fixture traffic.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensurePython } from '../src/distribution/components.ts';
import { browserComponent } from '../src/distribution/browser-engine.ts';
const root = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(join(tmpdir(), 'seudaily-optional-validation-'));
const exec = promisify(execFile);
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
  // A fresh campus runtime must work without any browser/document/model SDK.
  await exec(python, ['-c', `import importlib.util; from seudaily.cli import dispatch
assert dispatch({'action':'health','payload':{}})['version']
assert all(importlib.util.find_spec(name) is None for name in ('playwright','docx','pptx','openpyxl','pypdfium2','openai','dashscope'))`], { env: process.env, cwd: directory });
  // CI supplies uv and a compatible Python: optional setup must reuse them.
  assert.ok(!existsSync(join(directory, 'cache', 'uv')), 'existing uv was not reused');
  assert.ok(!existsSync(join(directory, 'cache', 'python-runtime')), 'existing Python was not reused');
  const documents = await exec(python, ['-c', `import importlib.util, zipfile
from pathlib import Path
from seudaily.document_parser import parse_document
source = Path('fixture.docx')
with zipfile.ZipFile(source, 'w') as archive:
    archive.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    archive.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>document fixture</w:t></w:r></w:p></w:body></w:document>')
assert 'document fixture' in parse_document(str(source))['markdown']
assert 'document fixture' in parse_document(str(source))['markdown']
assert all(importlib.util.find_spec(name) is None for name in ('playwright','openai','dashscope'))`], { env: process.env, cwd: directory, timeout: 600_000 });
  assert.equal(documents.stderr.split('正在下载并安装文档解析依赖').length - 1, 1);
  assert.ok(!existsSync(join(directory, 'cache', 'browsers')), 'document parsing installed a browser');
  const component = await browserComponent();
  const config = join(directory, 'browser.json');
  const engine = process.platform === 'darwin' ? 'webkit' : process.platform === 'win32' ? 'chromium' : 'firefox';
  await writeFile(config, JSON.stringify({ outputDir: join(directory, 'browser-output'), browser: { browserName: engine, launchOptions: { headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) } } }));
  process.env.PROBE_CHILD_COMMAND = JSON.stringify([process.execPath, component, config]);
  await (await import(pathToFileURL(join(root, 'build/validation/browser-client.mjs')))).run();
  const fallback = await exec(python, ['-c', `from seudaily.browser_runtime import browser_runtime
with browser_runtime().page('fixture', visible=False, context_options={}) as page:
    page.set_content('<title>Python browser fixture</title>')
    assert page.title() == 'Python browser fixture'
browser_runtime().close()`], { env: process.env, cwd: directory, timeout: 600_000 });
  assert.ok(fallback.stderr.includes('浏览器驱动依赖已就绪'));
  assert.ok(!fallback.stderr.includes('浏览器…'), 'Python did not reuse the Node browser cache');
  await mkdir(join(root, 'build/validation'), { recursive: true });
  const report = { platform: process.platform, pythonInstallation: true, pythonWorker: true, baseExcludesOptionalDependencies: true, documentsInstalledOnDemand: true, pythonBrowserInstalledOnDemand: true, browserCacheShared: true, browserEngine: engine, browser: { navigate: true, click: true, snapshot: true, close: true } };
  await writeFile(join(root, 'build/validation/optional-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await rm(directory, { recursive: true, force: true }); }
