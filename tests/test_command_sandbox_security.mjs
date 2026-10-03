import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCommandSandbox } from '../src/runtime/native-command-sandbox.ts';
const shellQuote=value=>"'"+value.replaceAll("'","'\\''")+"'";
test('native sandbox permits project tools and workspace writes, blocks host/private reads', t=>{
 const root=mkdtempSync(join(tmpdir(),'seudaily-sandbox-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const project=join(root,'project'),workspace=join(project,'.seudaily','sandbox-workspace');mkdirSync(workspace,{recursive:true});
 const outside=join(root,'host-secret');writeFileSync(outside,'host private');writeFileSync(join(project,'.env'),'api-secret');writeFileSync(join(project,'.seudaily','agent.db'),'private history');writeFileSync(join(project,'public.txt'),'project public');
 const nested=join(project,'src');mkdirSync(nested);writeFileSync(join(nested,'PRIVATE.KEY'),'key private');writeFileSync(join(nested,'.env.local'),'nested private');
 const sandbox=createCommandSandbox({projectRoot:project,workingDirectory:workspace});
 if(sandbox.mode==='host-fallback'){t.skip('Native sandbox unavailable on this host');return;}
 const publicPath=sandbox.mode==='wsl-bwrap'?'/project/public.txt':join(project,'public.txt');const workspacePath=sandbox.mode==='wsl-bwrap'?'/workspace':workspace;
 const command=`cat ${shellQuote(publicPath)} && printf ok > ${shellQuote(join(workspacePath,'result'))}`;
 const launch=sandbox.wrap(command);const allowed=spawnSync(launch.command,launch.args,{cwd:workspace,env:{PATH:'/usr/local/bin:/usr/bin:/bin'},encoding:'utf8'});
 assert.equal(allowed.status,0,JSON.stringify({stderr:allowed.stderr,error:allowed.error,signal:allowed.signal}));assert.match(allowed.stdout,/project public/);
 const temp=sandbox.wrap('file=$(mktemp "${TMPDIR:-/tmp}/seudaily.XXXXXX"); printf temporary > "$file"; cat "$file"; rm "$file"');const tempResult=spawnSync(temp.command,temp.args,{cwd:workspace,env:{PATH:'/usr/bin:/bin'},encoding:'utf8'});assert.equal(tempResult.status,0,tempResult.stderr);assert.equal(tempResult.stdout,'temporary');
 for(const path of [outside,join(project,'.env'),join(project,'.seudaily','agent.db'),join(nested,'PRIVATE.KEY'),join(nested,'.env.local')]){
  const command=sandbox.wrap('cat '+shellQuote(path));const denied=spawnSync(command.command,command.args,{cwd:workspace,env:{PATH:'/usr/bin:/bin'},encoding:'utf8'});assert.notEqual(denied.status,0);assert.doesNotMatch(denied.stdout,/api-secret|private history|host private|key private|nested private/);
 }
 writeFileSync(join(project,'.env.new'),'new secret');const late=sandbox.wrap('cat '+shellQuote(join(project,'.env.new')));const denied=spawnSync(late.command,late.args,{cwd:workspace,env:{PATH:'/usr/bin:/bin'},encoding:'utf8'});assert.notEqual(denied.status,0);assert.doesNotMatch(denied.stdout,/new secret/);
});
