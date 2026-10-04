import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/terminal/session.ts';
import { focusForm } from '../src/terminal/management.ts';

test('CLI focus creation immediately streams into its saved conversation; editing does not rerun', async () => {
 const session = new Session({command:'chat'}, '/tmp');
 const item = {id:'focus-test',threadId:'focus-test',resourceId:'seudaily-focus-local',description:'关注通知',enabled:true};
 const claims = []; let streams = 0;
 session.save = async () => {}; session.history = async () => {}; session.nameThread = () => {};
 session.client.json = async (path, method, body) => {
  if (path === '/app/focus') return {status:'completed',data:method === 'POST' ? {item} : {items:[item]}};
  if (/\/run(?:\?|$)/.test(path)) return {pending:null};
  if (path.endsWith('/run/claim')) { claims.push(body); return {status:'completed',data:{claimed:true,runId:'run-test'}}; }
  if (path.endsWith('/run/record')) return {status:'completed'};
  throw new Error(path);
 };
 session.client.stream = async function* (body) {
  streams++;
  assert.equal(session.form, null); assert.equal(session.busy, true);
  assert.equal(body.memory.thread, item.threadId);
  assert.equal(body.memory.resource, item.resourceId);
  assert.equal(body.messages, item.description);
  yield {type:'text-delta',payload:{text:'已检查'}};
 };
 const values = {title:'通知',kind:'notice',description:'关注通知',enabled:'true'};
 const form = focusForm(session); session.form = form;
 await form.save(values);
 assert.equal(streams,1);
 assert.deepEqual(claims,[{force:true,respectInterval:true}]);
 assert.equal(session.busy,false);
 await focusForm(session,item).save(values);
 assert.equal(streams,1);
});

test('switching to Focus clears ordinary chat state and uses only the target approval', async () => {
 const session = new Session({command:'chat'}, '/tmp');
 session.history = async () => {}; session.save = async () => {}; session.nameThread = () => {};
 const item = {id:'isolated-focus',description:'检查通知'};
 session.documents = [{contextRef:'old-document'}];
 session.images = [{ref:'old-image',name:'old.png',mediaType:'image/png'}];
 session.skills = ['old-skill']; session.pending = {toolName:'old-approval'};
 session.auth.set('old-auth',{}); session.actions.set('old-action',{});
 session.confirmation = {kind:'old',payload:{},text:'old'};
 session.client.json = async path => {
  if(/\/run(?:\?|$)/.test(path)) return {pending:null};
  if(path.endsWith('/run/claim')) return {data:{claimed:true,runId:'mock'}};
  return {};
 };
 let body;
 session.client.stream = async function*(request) {body=request;yield {type:'text-delta',payload:{text:'已检查'}};};
 await session.runCreatedFocus(item);
 assert.equal(body.messages,item.description);
 assert.deepEqual(body.requestContext.seudailySkills,[]);
 assert.deepEqual(body.requestContext.seudailyDocumentRefs,[]);
 assert.equal(session.auth.size,0); assert.equal(session.actions.size,0);
 assert.equal(session.confirmation,null);
 const targetApproval = {toolName:'focus-approval',runToken:'focus-run'};
 session.client.json = async () => ({pending:targetApproval});
 await session.openFocus(item);
 assert.equal(session.pending,targetApproval);
});
