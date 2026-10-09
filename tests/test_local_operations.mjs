import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {localActionProposalSchema} from '../src/runtime/local-action-schema.ts';

const cases=JSON.parse(readFileSync(new URL('./fixtures/local-operation-cases.json',import.meta.url),'utf8'));
test('both languages accept, reject and normalize the same operation cases',()=>{
 const script=`import json,sys\nfrom seudaily.local_operations import validate_proposal\nresults=[]\nfor case in json.load(sys.stdin):\n try: results.append({'accepted':True,'value':validate_proposal(case['input'])})\n except ValueError: results.append({'accepted':False})\nprint(json.dumps(results,ensure_ascii=False))`;
 const python=JSON.parse(execFileSync('uv',['run','--no-sync','python','-c',script],{input:JSON.stringify(cases),encoding:'utf8'}));
 cases.forEach((case_,index)=>{
   let result;try{result={accepted:true,value:localActionProposalSchema.parse(case_.input)};}catch{result={accepted:false};}
   assert.equal(result.accepted,case_.accepted,case_.name);
   assert.deepEqual(result,python[index],case_.name);
 });
});
