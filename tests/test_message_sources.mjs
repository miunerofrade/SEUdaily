import test from 'node:test';
import assert from 'node:assert/strict';
import {messageSources} from '../apps/web/src/chat/sources.ts';

test('reply sources merge repeated files across tools while preserving all locations',()=>{
 const citation={id:'chunk1',type:'file',title:'规章.md',localPath:'/knowledge/a.md',locator:'片段 10'};
 const message={tools:[{result:{citations:[citation,{...citation,id:'chunk2',locator:'片段 2'}]}},{result:{citations:[{...citation,id:'chunk3',locator:'片段 2'},{...citation,id:'chunk4',locator:'第 3 页'}]}}]};
 const sources=messageSources(message);assert.equal(sources.length,1);
 assert.equal(sources[0].locator,'第 3 页；片段 2；片段 10');
 assert.equal(citation.locator,'片段 10','stored tool results remain unchanged');
});

test('same titles with different files remain separate and missing locations are omitted',()=>{
 const sources=messageSources({tools:[{result:{citations:[
  {id:'a',type:'file',title:'规章.md',localPath:'/a.md'},
  {id:'b',type:'file',title:'规章.md',localPath:'/b.md',locator:' '},
  {id:'c',type:'web',title:'通知',url:'https://example.org/notice',locator:'正文'},
  {id:'d',type:'web',title:'通知',url:'https://example.org/notice',locator:'附件'},
 ]}}]});
 assert.equal(sources.length,3);assert.equal(sources[0].locator,undefined);assert.equal(sources[1].locator,undefined);
 assert.equal(sources[2].locator,'附件；正文');assert.deepEqual(messageSources({}),[]);
});
