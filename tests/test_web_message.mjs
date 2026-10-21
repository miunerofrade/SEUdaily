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
 assert.match(html,/<strong>结论<\/strong>/);assert.match(html,/class="hljs"/);assert.match(html,/已完成思考，1 项操作失败/);assert.match(html,/lucide-circle-alert/);
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
 assert.match(html,/已思考 /);assert.match(html,/1 分 8 秒/);assert.match(html,/补充要求/);assert.match(html,/按新的时间安排/);
 assert.equal(sidebarWidth(100,1400),220);assert.equal(sidebarWidth(900,1400),480);assert.equal(sidebarWidth(480,800),440);
});
