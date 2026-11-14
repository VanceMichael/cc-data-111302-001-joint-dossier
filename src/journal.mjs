import {mkdir,readFile,writeFile,rename,unlink,open,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export class JournalBusyError extends Error {
  constructor(message){super(message);this.name='JournalBusyError';this.code='JOURNAL_BUSY';}
}

export class Journal {
  constructor({dir,caseId}){
    this.dir=dir;
    this.caseId=caseId;
    this.statePath=join(dir,`${caseId}.json`);
    this.lockPath=join(dir,`${caseId}.lock`);
  }

  async read(){
    try{return JSON.parse(await readFile(this.statePath,'utf8'));}
    catch(error){if(error.code==='ENOENT')return null;throw error;}
  }

  async write(state){
    await mkdir(this.dir,{recursive:true});
    state.updatedAt=new Date().toISOString();
    const temp=`${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp,JSON.stringify(state,null,2));
    await rename(temp,this.statePath);
    return state;
  }

  async withLock(callback,{timeoutMs=30000,staleMs=30000,waitMs=20}={}){
    await mkdir(this.dir,{recursive:true});
    const deadline=Date.now()+timeoutMs;
    let handle=null;
    while(!handle){
      try{
        handle=await open(this.lockPath,'wx');
        await handle.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString()}));
      }catch(error){
        if(error.code!=='EEXIST')throw error;
        let stale=false;
        try{const info=await stat(this.lockPath);stale=Date.now()-info.mtimeMs>staleMs;}catch{}
        if(stale){await unlink(this.lockPath).catch(()=>{});continue;}
        if(Date.now()>deadline)throw new JournalBusyError(`事项 ${this.caseId} 正由另一个窗口处理，本次未重复分发`);
        await new Promise(resolve=>setTimeout(resolve,waitMs));
      }
    }
    try{return await callback();}
    finally{
      await handle.close().catch(()=>{});
      await unlink(this.lockPath).catch(()=>{});
    }
  }
}
