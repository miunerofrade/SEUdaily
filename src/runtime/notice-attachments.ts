import {readFile,readdir,realpath} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';

/** Cached articles are the durable queue: completed URLs reuse saved originals, failures back off. */
export class NoticeAttachments {
  private running?:Promise<void>;
  private timer?:NodeJS.Timeout;
  private abort=new AbortController();
  private retryAfter=new Map<string,number>();
  private registered=new Set<string>();
  constructor(private root:string,private python:(action:string,payload:Record<string,unknown>,signal?:AbortSignal)=>Promise<any>,private knowledge:{enqueue:(name:string,bytes:Buffer,threadId?:string,path?:string)=>Promise<any>}) {}
  start(){void this.tick();this.timer=setInterval(()=>void this.tick(),10_000);this.timer.unref();}
  async stop(){if(this.timer)clearInterval(this.timer);this.abort.abort();await this.running;}
  tick(){if(this.abort.signal.aborted)return Promise.resolve();return this.running ??= this.work().catch(error=>{if(!this.abort.signal.aborted)console.error('通知 PDF 同步失败，将自动重试',error.message);}).finally(()=>{this.running=undefined;});}
  private async work(){
    for(const site of ['jwc','cse']) {
      const directory=join(this.root,site,'articles');
      const files=await readdir(directory).catch(()=>[]);
      for(const file of files.sort().reverse()) {
        if(!file.endsWith('.json') || this.abort.signal.aborted)continue;
        let article:any;try{article=JSON.parse(await readFile(join(directory,file),'utf8'));}catch{continue;}
        for(const [index,attachment] of (article.attachments || []).entries()) {
          if(this.abort.signal.aborted)return;
          if(typeof attachment.url!=='string' || !/\.pdf(?:$|[?#])/i.test(attachment.url) && !/\.pdf$/i.test(attachment.name || ''))continue;
          const url=attachment.url;
          if(this.registered.has(url) || (this.retryAfter.get(url)||0)>Date.now())continue;
          try{
            const metadata=join(this.root,'web-files','metadata',createHash('sha256').update(url).digest('hex')+'.json');
            let item:any;try{item=JSON.parse(await readFile(metadata,'utf8'));}catch{}
            let bytes:Buffer|undefined;
            if(item?.path){const path=await realpath(item.path).catch(()=>undefined);if(path){const child=relative(await realpath(join(this.root,'web-files','files')),path);if(child && child!=='..' && !child.startsWith('../') && !child.startsWith('..\\') && !isAbsolute(child))bytes=await readFile(path).catch(()=>undefined);}}
            if(!bytes || createHash('sha256').update(bytes).digest('hex')!==item.sha256) {
              const result=await this.python('sync-notice-pdf',{site,articleId:article.id,attachmentNumber:index+1},this.abort.signal);
              if(result.status!=='completed')throw new Error(result.summary || '附件下载失败');
              item=JSON.parse(await readFile(metadata,'utf8'));bytes=await readFile(item.path);
            }
            if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw new Error('附件不是 PDF');
            await this.knowledge.enqueue(item.name,bytes,undefined,item.path);
            this.registered.add(url);this.retryAfter.delete(url);
          }catch(error:any){if(this.abort.signal.aborted)return;this.retryAfter.set(url,Date.now()+5*60_000);console.error(`通知 PDF 暂未完成：${attachment.name}，5 分钟后重试`,error.message);}
        }
      }
    }
  }
}
