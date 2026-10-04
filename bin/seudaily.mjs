#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (!(major === 22 && minor >= 22 || major === 24 && minor >= 12 || major > 24)) {
  console.error('SEUdaily 需要 Node.js 22.22+（22.x）或 24.12+。');
  process.exit(2);
}
try { await import('../dist/launcher.mjs'); }
catch (error) { console.error(`SEUdaily：${error.message}`); process.exitCode = 1; }
