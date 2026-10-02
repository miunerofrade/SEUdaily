import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('template', { recursive: true });
// npm deliberately omits the root package-lock.json from tarballs.
copyFileSync('package-lock.json', 'template/npm-lock.json');
