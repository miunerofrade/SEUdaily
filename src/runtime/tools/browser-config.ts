export function browserChildEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: env.PLAYWRIGHT_BROWSERS_PATH } : {};
}
export function playwrightBrowserConfig(platform: NodeJS.Platform, configured = 'auto', proxy?: string) {
  let selected = configured.trim().toLowerCase() || 'auto';
  if (selected === 'auto') selected = platform === 'win32' ? 'msedge' : platform === 'darwin' ? 'webkit' : 'firefox';
  if (selected === 'safari') selected = 'webkit';
  if (!['msedge', 'webkit', 'firefox', 'chromium'].includes(selected)) {
    throw new Error('SEUDAILY_BROWSER 必须为 auto、msedge、webkit、safari、firefox 或 chromium');
  }
  return {
    browser: {
      browserName: selected === 'msedge' ? 'chromium' : selected,
      launchOptions: { headless: true, ...(selected === 'msedge' ? { channel: 'msedge' } : {}) },
      contextOptions: { ...(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1' } } : {}), viewport: { width: 1920, height: 1080 } },
    },
  };
}
