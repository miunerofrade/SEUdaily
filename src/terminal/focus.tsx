import React,{useState,useRef} from 'react';
import {Box,Text,useInput,useApp} from 'ink';
import type {Session} from './session.js';
import {focusForm} from './management.js';
export function FocusManager({session,width,height}:{session:Session;width:number;height:number}) {
 const {exit}=useApp();
 const [index,setIndex]=useState(0),[error,setError]=useState(''),[busy,setBusy]=useState(false),[remove,setRemove]=useState(false);
 const ref=useRef(index);ref.current=index;
 const action=async(fn:()=>Promise<void>)=>{setBusy(true);setError('');try{await fn();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 useInput((value,key)=>{if(key.ctrl&&value==='d'){exit();return;}if(session.form||busy||key.eventType==='release')return;const item=session.focusItems[ref.current];
 if(key.escape){if(remove){setRemove(false);return;}session.page='chat';session.changed();return;}
 if(remove){if(key.return&&item)void action(async()=>{session.result(await session.client.json(`/app/focus/${encodeURIComponent(item.id)}`,'DELETE'));setRemove(false);await session.loadFocus();});return;}
 if(key.upArrow||key.downArrow){setIndex(i=>(i+(key.upArrow?-1:1)+Math.max(1,session.focusItems.length))%Math.max(1,session.focusItems.length));return;}
 if(value==='a'){session.openForm(focusForm(session));return;}
 if(value==='r'){void action(async()=>{session.result(await session.client.json('/app/focus/run','POST'));await session.loadFocus();});return;}
 if(!item)return;
 if(key.return)void action(()=>session.openFocus(item));
 if(value==='e')session.openForm(focusForm(session,item));
 if(value===' ' )void action(async()=>{session.result(await session.client.json('/app/focus','POST',{...item,enabled:!item.enabled}));await session.loadFocus();});
 if(value==='d')setRemove(true);
 });
 const capacity=Math.max(1,Math.floor((height-7)/3)),top=Math.max(0,index-capacity+1);
 return <Box width={width} height={height} flexDirection="column" paddingX={2}><Text bold color="#80cbc4">关注</Text><Text color="#8993a4">↑↓ 选择 · Enter 对话/历史 · a 添加 · e 编辑 · 空格 启停 · d 删除 · r 立即检查 · Esc 返回</Text><Box flexDirection="column" flexGrow={1} marginTop={1}>{session.focusItems.slice(top,top+capacity).map((item,i)=><Box key={item.id} flexDirection="column" marginBottom={1}><Text color={top+i===index?'#20242c':'#dce1ea'} backgroundColor={top+i===index?'#80cbc4':undefined}>{item.title} · {item.enabled?'启用':'暂停'}</Text><Text color="#8993a4">{item.lastCheckedAt || '尚未执行'} · {item.description}</Text></Box>)}</Box>{!session.focusItems.length&&<Text>暂无关注；按 a 添加。</Text>}{remove&&<Text color="yellow">删除当前关注？Enter 确认，Esc 返回。</Text>}{error&&<Text color="red">{error}</Text>}{busy&&<Text>处理中…</Text>}</Box>;
}
