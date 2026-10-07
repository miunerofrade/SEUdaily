import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec = promisify(execFile);

test('permission switching is durable, shared and atomic without replacing unrelated settings',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'seudaily-permissions-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  await writeFile(join(directory,'package.json'),'{"type":"module"}');await writeFile(join(directory,'pyproject.toml'),'[project]\nname="fixture"');
  await writeFile(join(directory,'.env'),'UNRELATED=preserve-me\nSEUDAILY_FULL_ACCESS=false\nSEUDAILY_FULL_ACCESS_EXTRA=false\n');
  const modeModule=pathToFileURL(resolve('src/runtime/permission-state.ts')).href;
  const envModule=pathToFileURL(resolve('src/runtime/environment-settings.ts')).href;
  const env={...process.env,SEUDAILY_PROJECT_ROOT:directory,SEUDAILY_FULL_ACCESS:'false',SEUDAILY_FULL_ACCESS_EXTRA:'false'};
  const code=`
    import assert from 'node:assert/strict';
    import {readFile,rm,mkdir} from 'node:fs/promises';
    import {getPermissionMode,setPermissionMode} from ${JSON.stringify(modeModule)};
    import {updateEnvFile,parseEnv} from ${JSON.stringify(envModule)};
    const file=${JSON.stringify(join(directory,'.env'))};
    assert.equal(getPermissionMode(),'normal');
    for(const mode of ['full','extra','normal']) {
      await setPermissionMode(mode);assert.equal(getPermissionMode(),mode);
      const saved=parseEnv(await readFile(file,'utf8'));
      assert.equal(saved.UNRELATED,'preserve-me');
      assert.equal(saved.SEUDAILY_FULL_ACCESS,String(mode !== 'normal'));
      assert.equal(saved.SEUDAILY_FULL_ACCESS_EXTRA,String(mode === 'extra'));
    }
    await Promise.all([setPermissionMode('full'),updateEnvFile({ANOTHER:'kept'}),setPermissionMode('extra')]);
    assert.equal(getPermissionMode(),'extra');assert.equal(parseEnv(await readFile(file,'utf8')).ANOTHER,'kept');
    await setPermissionMode('normal');
    await assert.rejects(setPermissionMode('unknown'));
    await rm(file);await mkdir(file);
    await assert.rejects(setPermissionMode('full'));assert.equal(getPermissionMode(),'normal');
    await rm(file,{recursive:true});await setPermissionMode('extra');
    console.log(getPermissionMode());
  `;
  assert.equal((await exec(process.execPath,['--import','tsx','--input-type=module','-e',code],{env})).stdout.trim(),'extra');
  const restartEnv={...process.env,SEUDAILY_PROJECT_ROOT:directory};
  for(const key of ['SEUDAILY_FULL_ACCESS','SEUDAILY_FULL_ACCESS_EXTRA','CVSTREAM_FULL_ACCESS','CVSTREAM_FULL_ACCESS_EXTRA']) delete restartEnv[key];
  assert.equal((await exec(process.execPath,['--import','tsx','--input-type=module','-e',`import {getPermissionMode} from ${JSON.stringify(modeModule)};console.log(getPermissionMode());`],{env:restartEnv})).stdout.trim(),'extra');
});
