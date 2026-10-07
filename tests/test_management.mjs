import test from 'node:test';
import assert from 'node:assert/strict';
import {settingsForm} from '../src/terminal/management.ts';

test('TUI edits embedding credentials separately from the chat model and submits them to shared settings', async () => {
  const requests = [];
  const session = {client:{json:async (...args)=>{
    requests.push(args);
    if (args.length === 1) return {fields:[
      {name:'DEEPSEEK_MODEL',value:'deepseek-flash',secret:false},
      {name:'DASHSCOPE_API_KEY',value:'',secret:true,configured:true},
      {name:'SEUDAILY_EMBEDDING_MODEL',value:'',secret:false},
      {name:'SEUDAILY_EMBEDDING_BASE_URL',value:'',secret:false},
    ],agentInstructions:'规则'};
    return {restartRequired:false};
  }},show:()=>{}};
  const form = await settingsForm(session);
  const key = form.fields.find(field=>field.key==='DASHSCOPE_API_KEY');
  assert.match(key.label,/阿里云百炼/);
  assert.equal(key.secret,true);
  assert.equal(key.value,'');
  const values = Object.fromEntries(form.fields.map(field=>[field.key,field.value]));
  values.DASHSCOPE_API_KEY='fixture-only-key';
  await form.save(values);
  assert.equal(requests.at(-1)[0],'/app/settings');
  assert.equal(requests.at(-1)[1],'POST');
  assert.equal(requests.at(-1)[2].values.DASHSCOPE_API_KEY,'fixture-only-key');
  assert.equal(requests.at(-1)[2].values.DEEPSEEK_MODEL,'deepseek-flash');
  assert.equal(requests.at(-1)[2].agentInstructions,'规则');
});
