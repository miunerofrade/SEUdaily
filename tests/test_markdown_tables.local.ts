import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {messageLines} from '../src/terminal/markdown.js';
import {tableCells} from '../src/terminal/markdown-table.js';
const text=(lines:any[])=>lines.map(row=>row.map((s:any)=>s.text).join(''));
const source='于是有两套地址体系：\n\n| 类型 | 例子 | 说明 |\n|---|---|---|\n| 公网 IP（全球唯一） | 202.119.x.x | 在互联网上可以直接被路由到 |\n| 私有 IP（内网复用） | 10.0.0.0/8、172.16.0.0/12、192.168.0.0/16 | 只在局域网内有效，全世界有无数的 192.168.1.2 |\n\n表格之后';
test('Chinese markdown tables wrap cells, align borders and preserve all content',()=>{
 const lines=text(messageLines({role:'SEUdaily',text:source},70));assert.ok(lines.some(line=>line.startsWith('┌')));assert.ok(lines.some(line=>line.startsWith('└')));assert.ok(lines.every(line=>stringWidth(line)<=70));
 const table=lines.filter(line=>line.startsWith('│'));assert.ok(table.length>3);const edges=table.map(line=>Array.from(line).reduce((acc:any[],char)=>{const size=stringWidth(char);if(char==='│')acc.push(acc.width);acc.width+=size;return acc;},Object.assign([],{width:0})));assert.ok(edges.every(edge=>JSON.stringify(edge)===JSON.stringify(edges[0])));
 const words=lines.join('').replace(/[│─┌┐└┘├┤┼┬┴\s]/g,'');assert.match(words,/192.168.0.0\/16/);assert.match(words,/只在局域网内有效/);assert.ok(lines.includes('表格之后'));
});
test('inline styles, alignment, escaped pipes, missing cells and emoji survive rendering',()=>{
 assert.deepEqual(tableCells('| **中文** | a\\|b | `x|y` |'),['**中文**','a|b','`x|y`']);
 const lines=messageLines({role:'SEUdaily',text:'| 中文 | 数量 |\n|:---|---:|\n| **👨‍👩‍👧‍👦家庭** | `42` |\n| 空 |'},35);
 assert.ok(lines.flat().some(s=>s.text.includes('家庭')&&s.bold));assert.ok(lines.flat().some(s=>s.text==='42'&&s.code));assert.ok(text(lines).every(line=>stringWidth(line)<=35));assert.ok(text(lines).some(line=>line.includes('👨‍👩‍👧‍👦')));
});
test('code fences and ordinary pipes are not converted to tables',()=>{
 for(const fence of ['```','~~~','````']){const lines=text(messageLines({role:'SEUdaily',text:fence+'text\n| A | B |\n|---|---|\n| X | Y |\n'+fence},60));assert.ok(!lines.some(line=>line.startsWith('┌')));assert.ok(lines.some(line=>line.includes('|---|---|')));}
 assert.ok(!text(messageLines({role:'你',text:'A | B\nplain text'},40)).some(line=>line.startsWith('┌')));
});
test('streamed partial tables update, resize, cache, and narrow layouts retain values',()=>{
 const message={role:'SEUdaily',text:'| A | B |\n|---|---|\n| one |'};const first=messageLines(message,50);assert.equal(messageLines(message,50),first);
 message.text+=' two |';assert.ok(text(messageLines(message,50)).some(line=>line.includes('two')));const narrow=text(messageLines(message,10));assert.ok(narrow.every(line=>stringWidth(line)<=10));assert.match(narrow.join('\n'),/B: two/);
});

test('long descriptions do not squeeze short Chinese labels into single-character columns',()=>{
 const markdown='| 问题 | 为什么会发生 |\n|---|---|\n| 端口转发要逐层配 | '+ '每层 NAT 都得开一条规则才通。'.repeat(40)+' |\n| 打洞成功率暴跌 | STUN 只能看到最外层映射。 |';
 for(const width of [60,100,150]){
  const lines=text(messageLines({role:'SEUdaily',text:markdown},width));const row=lines.find(line=>line.startsWith('│ ')&&line.includes('问题'))!;
  assert.ok(row.includes('问题'),'header remains horizontal');assert.ok(lines.some(line=>line.includes('端口转发要逐层配')),'short labels retain their natural width');assert.ok(lines.every(line=>stringWidth(line)<=width));
 }
});
test('user message tint covers wrapped rows but leaves message spacing and assistant unchanged',()=>{
 const lines=messageLines({role:'你',text:'中文输入消息。'.repeat(10)},25);
 assert.ok(lines.slice(0,-1).every(row=>row.every(span=>span.user)&&stringWidth(row.map(s=>s.text).join(''))===25));
 assert.equal(lines.at(-1)![0].user,undefined);
 assert.ok(messageLines({role:'SEUdaily',text:'普通回答'},25).flat().every(span=>!span.user));
});
