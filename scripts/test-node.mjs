import {spawnSync} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const files=(await readdir(new URL('../tests/',import.meta.url)))
  .filter(name=>name.endsWith('.mjs')).sort().map(name=>`tests/${name}`);
// Cache cleanup discovers host processes. Run its end-to-end update test only
// after other files have finished starting/stopping their fixture backends.
const isolated='tests/test_update_cli.mjs';
for (const group of [files.filter(name=>name!==isolated),[isolated]]) {
  const result=spawnSync(process.execPath,['--import','tsx','--test','--test-timeout=240000',...group],{cwd:root,env:process.env,stdio:'inherit'});
  if(result.error) throw result.error;
  if(result.status!==0){process.exitCode=result.status??1;break;}
}
