import {redactText} from '../agent/redaction.js';
import type {AgentEvent} from '../agent/types.js';

/** The server drains the task; losing its HTTP observer never cancels execution. */
export function agentEventStream(events:AsyncIterable<AgentEvent>,requestSignal:AbortSignal) {
  let detached=false;
  const encoder=new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const detach=()=>{if(detached)return;detached=true;try{controller.close();}catch{}};
      const send=(data:string)=>{
        if(detached)return;
        // A slow observer must not retain an unbounded transcript or stall tools.
        const bytes=encoder.encode(data);
        if(bytes.byteLength>(controller.desiredSize ?? 0)){detach();return;}
        try{controller.enqueue(bytes);}catch{detach();}
      };
      requestSignal.addEventListener('abort',detach,{once:true});
      if(requestSignal.aborted)detach();
      const keepAlive=setInterval(()=>send(': keep-alive\n\n'),15000);
      keepAlive.unref();
      void (async()=>{
        try {
          for await(const event of events) if(!detached)send(`data: ${JSON.stringify(event)}\n\n`);
          send('data: [DONE]\n\n');
        } catch(error) {
          const message=redactText(error instanceof Error ? error.message : 'Agent 流处理失败');
          send(`data: ${JSON.stringify({type:'error',payload:{error:{message}}})}\n\n`);
          console.error('Agent 流处理失败：',message);
        } finally {
          clearInterval(keepAlive);
          requestSignal.removeEventListener('abort',detach);
          detach();
        }
      })();
    },
    cancel(){detached=true;},
  },{highWaterMark:1024*1024,size:chunk=>chunk.byteLength});
}
