import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {AssistService,AssistError} from './assist.mjs';
import {JournalBusyError} from './journal.mjs';

export function json(response,value,status=200){
  response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  response.end(JSON.stringify(value));
}

async function body(request){
  let text='';
  for await(const chunk of request){text+=chunk;if(text.length>1024*1024)throw new AssistError('请求过大',413);}
  if(!text)return {};
  try{return JSON.parse(text);}catch{throw new AssistError('JSON无效',400);}
}

export async function createServer({sourceUrl,dir,caseId='move-17',browser=null,headless=true,departments,port=0,host='127.0.0.1'}={}){
  const assist=await new AssistService({sourceUrl,dir,caseId,browser,headless,departments}).start();
  const server=http.createServer(async(request,response)=>{
    try{
      const url=new URL(request.url,'http://local.test');
      if(request.method==='GET'&&(url.pathname==='/'||url.pathname==='/workbench.html')){
        const html=await readFile(new URL('../public/workbench.html',import.meta.url));
        response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return response.end(html);
      }
      if(request.method==='GET'&&url.pathname==='/health')return json(response,{status:'ok'});
      if(request.method==='GET'&&url.pathname==='/api/snapshot')return json(response,await assist.getSnapshot());
      if((request.method==='GET'||request.method==='POST')&&url.pathname==='/api/refresh'){
        if(request.method==='POST')await body(request);
        return json(response,await assist.refresh());
      }
      if(request.method==='POST'&&url.pathname==='/api/revise-address')return json(response,await assist.reviseAddress((await body(request)).address));
      if(request.method==='POST'&&url.pathname==='/api/supply'){
        const input=await body(request);
        return json(response,await assist.supply({department:input.department,field:input.field,value:input.value}));
      }
      if(request.method==='POST'&&url.pathname==='/api/corrections/acknowledge'){
        const input=await body(request);
        return json(response,await assist.acknowledgeCorrection(input.correctionId,{note:input.note??''}));
      }
      let match;
      if(request.method==='POST'&&(match=url.pathname.match(/^\/api\/dispatch\/([a-z]+)$/))){
        return json(response,await assist.dispatch(match[1]));
      }
      if(request.method==='POST'&&(match=url.pathname.match(/^\/api\/revoke\/([a-z]+)$/))){
        return json(response,await assist.revokeConsent(match[1]));
      }
      return json(response,{error:'资源不存在'},404);
    }catch(error){
      if(error instanceof JournalBusyError)return json(response,{error:error.message,code:error.code},409);
      if(error instanceof AssistError)return json(response,{error:error.message},error.status);
      return json(response,{error:error.message},500);
    }
  });
  await new Promise(resolve=>server.listen(port,host,resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  return {url,assist,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await assist.close();}};
}
