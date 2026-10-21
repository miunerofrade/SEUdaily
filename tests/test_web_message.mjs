import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {tsImport} from 'tsx/esm/api';
import {fileURLToPath} from 'node:url';
const options={parentURL:import.meta.url,tsconfig:fileURLToPath(new URL('../apps/web/tsconfig.json',import.meta.url))};
const {Message}=await tsImport('../apps/web/src/chat/message.tsx',options);
const {SourcesSidebar}=await tsImport('../apps/web/src/chat/sources-sidebar.tsx',options);
const {sidebarWidth}=await tsImport('../apps/web/src/sidebar-resize.tsx',options);
const render=(component,props)=>renderToStaticMarkup(createElement(component,props));
test('extracted message rendering keeps Markdown, errors, sources and prompt actions',()=>{
 const citation={id:'file-1',type:'file',title:'指南.pdf',localPath:'/tmp/guide.pdf',locator:'第 2 页'};
 const message={id:'reply',role:'assistant',createdAt:Date.now(),content:'**结论**\n\n```js\nconst x = 1;\n```',tools:[{id:'call',name:'search-knowledge',state:'failed',result:{status:'failed',summary:'检索失败',citations:[citation]}}]};
 const html=render(Message,{message,onSources:()=>{},onBranch:()=>{},canRegenerate:true});
 assert.match(html,/<strong>结论<\/strong>/);assert.match(html,/class="hljs"/);assert.match(html,/已思考/);assert.doesNotMatch(html,/项操作失败|lucide-circle-alert|error-icon/);assert.match(html,/aria-label="工具调用信息"/);
 assert.match(html,/aria-label="来源"/);assert.match(html,/aria-label="分支为新会话"/);assert.match(html,/aria-label="复制回答"/);assert.match(html,/<time /);
 assert.doesNotMatch(html,/message-sources-list/);
 assert.doesNotMatch(render(Message,{message:{...message,createdAt:Date.now()-25*3600_000}}),/<time /);
 const user=render(Message,{message:{id:'user',role:'user',createdAt:Date.now(),content:'提问'},onEdit:()=>{}});
 assert.match(user,/提问/);assert.match(user,/编辑提示词/);
 const sidebar=render(SourcesSidebar,{sources:[citation,{id:'web',type:'web',title:'通知',url:'https://jwc.seu.edu.cn/notice'}],onClose:()=>{}});
 assert.match(sidebar,/第 2 页/);assert.match(sidebar,/jwc.seu.edu.cn/);assert.match(sidebar,/关闭来源/);assert.match(sidebar,/library\/preview/);
});

test('saved timing and supplemental input remain visible outside the folded process',()=>{
 const html=render(Message,{message:{id:'reply',role:'assistant',createdAt:Date.now(),content:'最终回答',timing:{elapsedMs:68000,finishedAt:Date.now()},process:[{id:'supplement',type:'user-input',text:'按新的时间安排'}],tools:[]}});
 assert.match(html,/已思考 /);assert.match(html,/68 秒/);assert.match(html,/补充要求/);assert.match(html,/按新的时间安排/);
 assert.equal((html.match(/thought-duration/g)??[]).length,1);assert.doesNotMatch(html,/lucide-bot|run-timing|已完成思考/);
 assert.equal(sidebarWidth(100,1400),220);assert.equal(sidebarWidth(900,1400),480);assert.equal(sidebarWidth(480,800),440);
});

test('stopping keeps partial body text and a plain stop notice with footer actions',()=>{
 const message={id:'stopped',role:'assistant',createdAt:Date.now(),content:'',error:'已停止本次回答。',process:[{id:'partial',type:'narration',text:'已经生成的部分正文'}],tools:[{id:'call',name:'web-search',state:'failed',result:{status:'failed',summary:'没有配置搜索服务'}}]};
 const html=render(Message,{message,onBranch:()=>{},canRegenerate:true});
 assert.match(html,/class="markdown"[^]*已经生成的部分正文/);assert.match(html,/<p class="message-stopped">已停止本次回答<\/p>/);
 assert.doesNotMatch(html,/message-error|error-icon|项操作失败/);
 assert.match(html,/aria-label="复制回答"/);assert.match(html,/aria-label="分支为新会话"/);assert.match(html,/aria-label="工具调用信息"/);
});

test('tool errors in an expanded live process use neutral information icons',()=>{
 const message={id:'running',role:'assistant',createdAt:Date.now(),content:'',streaming:true,reasoningDone:true,tools:[{id:'call',name:'web-search',state:'failed',result:{status:'failed',summary:'搜索服务未配置'}}]};
 const html=render(Message,{message});assert.match(html,/搜索服务未配置/);assert.match(html,/lucide-info/);assert.doesNotMatch(html,/error-icon|lucide-circle-alert|项操作失败/);
});

test('a whole-turn failure remains visible and clean answers have no diagnostics button',()=>{
 const message={id:'reply',role:'assistant',createdAt:Date.now(),content:''};
 assert.match(render(Message,{message:{...message,error:'模型服务连接失败'}}),/class="message-error"/);
 assert.doesNotMatch(render(Message,{message:{...message,content:'正常回答'}}),/aria-label="工具调用信息"/);
});

test('tool results start collapsed while keeping status and timing together',()=>{
 const message={id:'running',role:'assistant',createdAt:Date.now(),content:'',streaming:true,tools:[{id:'call',name:'searchCapabilitiesTool',state:'completed',startedAt:1000,finishedAt:3000,result:{status:'completed',summary:'已找到可用能力',results:[{name:'search-knowledge',description:'检索资料',ticket:'secret-ticket'},{name:'read-web-page',description:'读取网页'}]}}]};
 const html=render(Message,{message});
 assert.match(html,/class="tool-activity-heading"[^>]*aria-expanded="false"[^>]*><strong>已找到可用能力<\/strong><span class="elapsed-time">2 秒<\/span>/);
 assert.doesNotMatch(html,/tool-result-feedback|search-knowledge|read-web-page|secret-ticket/);
});
