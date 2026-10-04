import {test} from 'node:test';import assert from 'node:assert/strict';import stringWidth from 'string-width';
import {welcomeLines} from '../src/terminal/welcome.js';
const prompt='输入消息或 / 查看命令。\n/schedule 与 /programs 打开交互表格。';
test('static squirrel welcome remains boxed, preserves Chinese hints, and fits resized terminals',()=>{
 for(const width of [20,40,44,64,70,80,100,150]){
  const lines=welcomeLines(prompt,width),strings=lines.map(row=>row.map(s=>s.text).join(''));
  assert.ok(strings.every(line=>stringWidth(line)<=width));assert.ok(strings[0].startsWith('╭'));assert.ok(strings.at(-2)!.startsWith('╰'));
  const text=strings.join('').replace(/[█▀▄│─╭╮╰╯\s]/g,'');assert.ok(text.includes('输入消息或/查看命令。'));assert.ok(text.includes('/schedule与/programs打开交互表格。'));
  if(width>=44)assert.ok(strings.some(line=>/[█▀▄]/.test(line)));
  if(width>=80)assert.ok(strings.some(line=>/[█▀▄]/.test(line)&&line.includes('SEUdaily')),'art and text share a row');
 }
});
