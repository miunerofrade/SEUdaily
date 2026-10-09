import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAppInputHandler} from '../src/terminal/app-input.ts';
import {dialogOptions,selectDialogValue} from '../src/terminal/app-dialogs.ts';
import {Composer} from '../src/terminal/composer.ts';
import {InterruptHold,TerminalReplyFilter} from '../src/terminal/keyboard.ts';

function fixture(overrides={}) {
 const calls=[],state={modal:null,detail:null,offset:null,dayStart:0,field:0,filter:'',selected:0,tableTop:0,grid:true,suggestionIndex:0,input:'',caret:0};
 const editor=new Composer(),ref=current=>({current});
 const session={options:{},form:null,busy:false,queueActive:false,confirmation:null,images:[],documents:[],queueItems:[],inputHistory:[],changed:()=>calls.push(['changed']),show:(...args)=>calls.push(['show',...args])};
 const context={session,view:{page:'chat',modal:null,detail:null,decisions:null,term:'',schedule:{currentSemester:''},plan:{id:'plan'},height:20,width:70,field:0,selected:0,isGrid:false,suggestions:[],selectedSuggestion:'',...overrides},refs:{terminalReplies:ref(new TerminalReplyFilter()),interruptHold:ref(new InterruptHold()),selectionRef:ref(null),viMode:ref(false),editor:ref(editor),pendingPastes:ref(0),historyIndex:ref(-1),historyDraft:ref('')},actions:{}};
 for(const name of ['Modal','Detail','Offset','DayStart','Field','Filter','Selected','TableTop','Grid','SuggestionIndex','Input','Caret']) {
   const key=name[0].toLowerCase()+name.slice(1);
   context.actions['set'+name]=value=>{state[key]=typeof value==='function'?value(state[key]):value;calls.push(['set'+name,state[key]]);};
 }
 for(const name of ['cancel','exit','copyCurrent','clearSelection','pasteClipboard','toggleReasoning','changePage','wheel','newSelection','openCourseDetail','run'])context.actions[name]=(...args)=>{calls.push([name,...args]);return Promise.resolve();};
 context.actions.edit=(text,cursor)=>{editor.set(text,cursor);state.input=text;state.caret=cursor;};
 context.actions.insert=text=>{editor.paste(text);state.input=editor.text;state.caret=editor.cursor;};
 return {context,calls,state,editor,input:(value,key={})=>createAppInputHandler(context)(value,key)};
}

test('composer input preserves Unicode, history and attachment readiness',()=>{
 const f=fixture();f.input('中文😀');f.input('',{backspace:true});assert.equal(f.editor.text,'中文');
 f.context.refs.pendingPastes.current=1;f.input('',{return:true});assert.ok(f.calls.some(([name])=>name==='show'));assert.equal(f.editor.text,'中文');
 f.context.refs.pendingPastes.current=0;f.input('',{return:true});assert.ok(f.calls.some(([name,text])=>name==='run'&&text==='中文'));assert.equal(f.editor.text,'');
 f.context.session.inputHistory=['/help','旧消息'];f.input('',{upArrow:true});assert.equal(f.editor.text,'旧消息');f.input('',{downArrow:true});assert.equal(f.editor.text,'');
});

test('paste, scrolling and dialog escape retain their guards',()=>{
 const f=fixture();f.input('v',{ctrl:true});assert.deepEqual(f.calls.at(-1),['pasteClipboard']);
 f.input('',{pageUp:true});assert.deepEqual(f.calls.at(-1),['wheel',-19]);
 f.context.view.modal='week';f.input('v',{ctrl:true});assert.equal(f.calls.filter(([name])=>name==='pasteClipboard').length,1);
 f.input('',{escape:true});assert.deepEqual(f.calls.at(-1),['setModal',null]);
 f.context.view.modal=null;f.context.view.page='schedule';f.input('',{escape:true});assert.deepEqual(f.calls.at(-1),['changePage','chat']);
});

test('interrupt cancels once, suppresses repeats and exits only after sustained hold',()=>{
 const f=fixture();f.context.session.busy=true;const responses=['first','repeat','exit'];f.context.refs.interruptHold.current={press:()=>responses.shift(),reset:()=>{}};
 f.input('c',{ctrl:true});f.input('c',{ctrl:true});f.input('c',{ctrl:true});assert.equal(f.calls.filter(([name])=>name==='cancel').length,2);assert.equal(f.calls.filter(([name])=>name==='exit').length,1);
 const selection=fixture();selection.context.refs.selectionRef.current={moved:true};selection.input('c',{ctrl:true});assert.deepEqual(selection.calls,[['copyCurrent']]);
});

test('course navigation and modal selection preserve state changes',async()=>{
 const f=fixture({page:'schedule',isGrid:true,field:3});f.input('',{rightArrow:true});assert.equal(f.state.dayStart,1);f.input('',{upArrow:true});assert.deepEqual(f.calls.at(-1),['wheel',-1]);
 f.context.view.isGrid=false;f.input('',{return:true});assert.deepEqual(f.calls.at(-1),['openCourseDetail']);
 const values={},actions={gridOptions:{current:[{courseName:'课程'}]},run:async text=>{values.run=text;}};
 for(const name of ['Modal','Selected','TableTop','Detail','Week','CourseState','PlanIndex','ProgramSemester'])actions['set'+name]=value=>values[name]=value;
 await selectDialogValue('semester','2026-2027-1',actions);assert.equal(values.run,'/schedule --semester "2026-2027-1"');assert.equal(values.Modal,null);assert.equal(values.Selected,0);
 await selectDialogValue('grid-courses','0',actions);assert.equal(values.Detail.courseName,'课程');
 assert.deepEqual(dialogOptions('semester',{plan:{},schedule:{availableSemesters:[{label:'秋季',value:'2026-2027-1'}]},programs:{},gridOptions:{current:[]}}),[{label:'秋季',value:'2026-2027-1'}]);
});
