import React,{useState,useRef} from 'react';
import {Box,Text,useInput,usePaste,useApp} from 'ink';
import type {Form} from './management.js';
import {committedInput} from './keyboard.js';
export function ManagementForm({form,width,height,onClose}:{form:Form;width:number;height:number;onClose:()=>void}) {
 const {exit}=useApp();
 const [values,setValues]=useState(Object.fromEntries(form.fields.map(f=>[f.key,f.value])));
 const [index,setIndex]=useState(0),[error,setError]=useState(''),[saving,setSaving]=useState(false);
 const ref=useRef({values,index,saving});ref.current={values,index,saving};
 const save=async()=>{setSaving(true);setError('');try{await form.save(ref.current.values);onClose();}catch(e){setError((e as Error).message);}finally{setSaving(false);}};
 const input=(value:string,key:any)=>{const current=ref.current;if(current.saving||key.eventType==='release')return;
 if(key.ctrl&&value==='d'){exit();return;}
 if(key.escape||(key.ctrl&&value==='c')){onClose();return;}
 if(key.ctrl&&value==='s'){void save();return;}
 if(key.tab||key.upArrow||key.downArrow){setIndex(i=>(i+(key.upArrow||key.shift?-1:1)+form.fields.length+1)%(form.fields.length+1));return;}
 const f=form.fields[current.index];if(!f){if(key.return)void save();return;}
 if(f.choices && (key.leftArrow||key.rightArrow||key.return)){const at=f.choices.findIndex(o=>o.value===current.values[f.key]);const next=f.choices[(at+(key.leftArrow?-1:1)+f.choices.length)%f.choices.length];setValues(v=>({...v,[f.key]:next.value}));return;}
 if(key.return&&!key.meta){setIndex(i=>i+1);return;}
 if(key.backspace||key.delete){setValues(v=>({...v,[f.key]:[...v[f.key]].slice(0,-1).join('')}));return;}
 if(key.ctrl&&value==='u'){setValues(v=>({...v,[f.key]:''}));return;}
 if(key.ctrl||key.super||f.choices)return;
 const text=key.return&&key.meta&&f.multiline?'\n':committedInput(value);if(text)setValues(v=>({...v,[f.key]:v[f.key]+text}));
 };
 useInput(input);usePaste(text=>{const f=form.fields[ref.current.index];if(f&&!f.choices&&!ref.current.saving)setValues(v=>({...v,[f.key]:v[f.key]+text}));});
 const capacity=Math.max(1,Math.floor((height-8)/3)),top=Math.max(0,Math.min(index-1,form.fields.length-capacity));
 return <Box width={width} height={height} flexDirection="column" paddingX={2}>
 <Text bold color="#80cbc4">{form.title}</Text><Text color="#8993a4">Tab / ↑↓ 选字段 · ←→ 选项 · Ctrl+U 清空 · Alt+Enter 换行 · Ctrl+S 保存 · Esc 返回</Text>
 <Box flexDirection="column" flexGrow={1} marginTop={1}>{form.fields.slice(top,top+capacity).map((f,i)=><Box key={f.key} flexDirection="column" marginBottom={1}><Text color={top+i===index?'#80cbc4':'#8993a4'}>{top+i===index?'› ':'  '}{f.label}</Text><Text wrap="truncate">  {f.secret?'•'.repeat(values[f.key].length):f.choices?.find(o=>o.value===values[f.key])?.label||values[f.key].replace(/\n/g,' ↵ ')}{top+i===index?'▏':''}</Text></Box>)}</Box>
 {error&&<Text color="red">{error}</Text>}<Text color="#80cbc4">{index===form.fields.length?'› ':'  '}{saving?'正在保存…':form.saveLabel || '保存'}</Text>
 </Box>;
}
