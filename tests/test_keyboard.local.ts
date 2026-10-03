import test from 'node:test';import assert from 'node:assert/strict';
import {InterruptHold,isTerminalReply,TerminalReplyFilter,terminalKeyboard,prepareTerminalInput} from '../src/terminal/keyboard.js';
import {DeepSeekProvider} from '../src/agent/provider.js';
test('capability replies are suppressed without suppressing printable CSI-u keys',()=>{
 assert.ok(isTerminalReply('[?0u'));assert.ok(isTerminalReply('\x1b[?31u'));assert.ok(isTerminalReply('[?1;2c'));
 assert.equal(isTerminalReply('[99;9u'),false);assert.equal(isTerminalReply('hello'),false);
});
test('Ctrl+C needs continuous repeats; short presses, gaps and release never exit',()=>{
 const hold=new InterruptHold();assert.equal(hold.press(0),'first');assert.equal(hold.press(200),'repeat');hold.reset();
 assert.equal(hold.press(1000),'first');assert.equal(hold.press(1550),'repeat');assert.equal(hold.press(1850),'repeat');assert.equal(hold.press(1950),'exit');hold.reset();
 assert.equal(hold.press(2200),'first');assert.equal(hold.press(3100),'first');assert.equal(hold.press(3900),'first');
});
test('chat sends high effort; summary keeps thinking disabled',async()=>{
 const original=globalThis.fetch;const bodies:any[]=[];
 try{globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));bodies.push(body);return body.stream?new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'):Response.json({choices:[{finish_reason:'stop',message:{content:'{"goals":[]}'}}]});};
 const provider=new DeepSeekProvider({apiKey:'test-key'});for await(const _ of provider.stream([{role:'user',content:'question'}],[])){}
 await provider.summarize([{role:'user',content:'summarize'}]);assert.equal(bodies[0].reasoning_effort,'high');assert.equal(bodies[1].thinking.type,'disabled');assert.equal(bodies[1].reasoning_effort,undefined);
 }finally{globalThis.fetch=original;}
});

test('delayed capability reply fragments survive Ink escape timeout',()=>{const filter=new TerminalReplyFilter();assert.equal(filter.consume('[?',0),true);assert.equal(filter.consume('0u',120),true);assert.equal(filter.consume('正文',121),false);assert.equal(filter.consume('[?',130),true);assert.equal(filter.consume('normal',140),false);});

test('Terminal.app skips probing and raw mode is prepared then restored',()=>{assert.deepEqual(terminalKeyboard({TERM_PROGRAM:'Apple_Terminal'}),{mode:'disabled'});assert.equal(terminalKeyboard({TERM_PROGRAM:'WezTerm'}).mode,'auto');const changes:boolean[]=[];const stdin={isRaw:false,destroyed:false,setRawMode:(value:boolean)=>{changes.push(value);}};const restore=prepareTerminalInput(stdin as any);assert.deepEqual(changes,[true]);restore();assert.deepEqual(changes,[true,false]);});
