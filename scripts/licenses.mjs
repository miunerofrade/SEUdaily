import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
export async function thirdPartyNotices(inputs) {
  const packages = new Map();
  for (const input of inputs) {
    if (!input.includes(`${sep}node_modules${sep}`) && !input.includes('node_modules/')) continue;
    let directory = dirname(resolve(input.split('?')[0]));
    while (directory !== dirname(directory)) {
      const path = resolve(directory, 'package.json');
      const metadata = await readFile(path, 'utf8').then(JSON.parse).catch(() => undefined);
      if (metadata?.name && metadata.version) { packages.set(directory, metadata); break; }
      directory = dirname(directory);
    }
  }
  const sections = [];
  for (const [directory, metadata] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const files = (await readdir(directory)).filter(name => /^(license|licence|copying)(?:\.|$)/i.test(name));
    const texts = await Promise.all(files.map(name => readFile(resolve(directory, name), 'utf8').catch(() => '')));
    const supplemental = ['yoga-layout@3.2.1', 'rehype-katex@7.0.1', 'remark-math@6.0.0'];
    if (!texts.some(Boolean) && supplemental.includes(`${metadata.name}@${metadata.version}`)) texts.push(await readFile(new URL(`./licenses/${metadata.name}-${metadata.version}.txt`, import.meta.url), 'utf8'));
    if (!texts.some(Boolean)) throw new Error(`缺少打包依赖的许可证文本：${metadata.name}@${metadata.version}`);
    sections.push(`${metadata.name}@${metadata.version}\nLicense: ${metadata.license ?? 'see text'}\n\n${texts.filter(Boolean).join('\n')}`);
  }
  return sections.join('\n\n' + '='.repeat(72) + '\n\n') + '\n';
}
export function webLicensePlugin() {
  return { name: 'third-party-notices', async generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.txt', source: await thirdPartyNotices([...this.getModuleIds()].filter(id => !id.startsWith('\0'))) });
  } };
}
