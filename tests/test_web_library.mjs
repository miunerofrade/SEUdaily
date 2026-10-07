import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {webLibraryNames} from '../src/runtime/web-library.ts';

test('old notice bodies appear as readable originals without recreating deleted files',async t=>{
 const root=await mkdtemp(join(tmpdir(),'seudaily-web-library-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const articles=join(root,'.seudaily/jwc/articles');await mkdir(articles,{recursive:true});
 await writeFile(join(articles,'notice.json'),JSON.stringify({title:'实践教学通知',url:'https://jwc.seu.edu.cn/notice',content:'报名截止星期五。'}));
 await writeFile(join(articles,'broken.json'),'{');
 const names=await webLibraryNames(root);
 assert.equal(names.size,1);
 const [path,name]=[...names][0];assert.equal(name,'实践教学通知.md');
 assert.match(await readFile(path,'utf8'),/来源：https:\/\/jwc.seu.edu.cn\/notice\n\n报名截止星期五/);
 await unlink(path);await webLibraryNames(root);
 await assert.rejects(readFile(path),{code:'ENOENT'});
});
