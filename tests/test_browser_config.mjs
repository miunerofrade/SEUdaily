import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';
const source = await readFile(new URL('../src/runtime/tools/browser-config.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { playwrightBrowserConfig, browserChildEnvironment } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
test('browser subprocess receives the same cache path as the installer',()=>{
 assert.deepEqual(browserChildEnvironment({PLAYWRIGHT_BROWSERS_PATH:'/custom/cache',DEEPSEEK_API_KEY:'private'}),{PLAYWRIGHT_BROWSERS_PATH:'/custom/cache'});
 assert.deepEqual(browserChildEnvironment({}),{});
});
test('MCP browser config selects the platform family without Chromium options on WebKit/Firefox', () => {
  for (const [platform, expected] of [['win32', 'chromium'], ['darwin', 'webkit'], ['linux', 'firefox']]) {
    const config = playwrightBrowserConfig(platform);
    assert.equal(config.browser.browserName, expected);
    assert.equal(config.browser.launchOptions.channel, platform === 'win32' ? 'msedge' : undefined);
  }
  assert.equal(playwrightBrowserConfig('darwin', 'safari').browser.browserName, 'webkit');
  assert.equal(playwrightBrowserConfig('linux', 'chromium').browser.launchOptions.channel, undefined);
  assert.equal(playwrightBrowserConfig('darwin', 'firefox').browser.browserName, 'firefox');
  assert.throws(() => playwrightBrowserConfig('darwin', 'not-a-browser'));
});

test('MCP campus proxy is scoped to browser contexts', () => {
  const config = playwrightBrowserConfig('darwin', 'auto', 'http://127.0.0.1:11081');
  assert.equal(config.browser.contextOptions.proxy.server, 'http://127.0.0.1:11081');
  assert.equal(playwrightBrowserConfig('darwin').browser.contextOptions.proxy, undefined);
});
