import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

export function json(response,value,status=200){response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(value));}
export async function createSource({port=0,host='127.0.0.1'}={}){
  const state=JSON.parse(await readFile(new URL('../fixtures/source.json',import.meta.url),'utf8'));
  
  const pages={"/index.html": "index.html", "/": "index.html"};
  const server=http.createServer(async(request,response)=>{
    try{
      const url=new URL(request.url,'http://local.test');let text='';
      for await(const chunk of request){text+=chunk;if(text.length>8*1024*1024){json(response,{error:'控制请求过大'},413);return;}}
      let body={};if(text){try{body=JSON.parse(text);}catch{return json(response,{error:'JSON无效'},400);}}
      if(url.pathname==='/health')return json(response,{status:'ok'});
      if(url.pathname==='/state'||url.pathname==='/inventory')return json(response,state);
      if(url.pathname==='/control'&&request.method==='POST'){if (body.address) { state.profile.address=body.address; state.profile.version++; } if (body.revoke) state.consents[body.revoke]=null; if (body.restore) state.consents[body.restore]=(state.consents[body.restore]||0)+1; if ('lateResponse' in body) state.lateResponse=body.lateResponse; return json(response,state);}
      if(Object.hasOwn(pages,url.pathname)){response.setHeader('Content-Type','text/html; charset=utf-8');return response.end(await readFile(new URL('../public/'+pages[url.pathname],import.meta.url)));}
      
    if (url.pathname === '/receipts') return json(response, state.receipts);
    if (url.pathname.startsWith('/department/') && request.method === 'POST') {
      const department = url.pathname.split('/')[2];
      if (!state.requirements[department]) return json(response, {error:'未知部门'},404);
      const previous = state.receipts[body.dispatchId];
      if (previous) return json(response, previous.payload === JSON.stringify(body) ? previous : {error:'分发身份冲突'}, previous.payload === JSON.stringify(body) ? 200 : 409);
      if (!state.consents[department] || body.consentVersion !== state.consents[department]) return json(response,{error:'授权失效'},403);
      if (body.profileVersion !== state.profile.version) return json(response,{error:'资料版本失效'},409);
      const missing = state.requirements[department].filter(field => !body.fields?.[field]);
      if (missing.length) return json(response,{missing},422);
      const receipt = {id:`receipt-${Object.keys(state.receipts).length+1}`,department,profileVersion:body.profileVersion,fields:body.fields,payload:JSON.stringify(body),status:'受理'};
      state.receipts[body.dispatchId] = receipt;
      if (state.lateResponse) return response.destroy();
      return json(response,receipt);
    }

      return json(response,{error:'资源不存在'},404);
    }catch(error){if(!response.headersSent)json(response,{error:error.message},500);else response.destroy();}
  });
  await new Promise(resolve=>server.listen(port,host,resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,state,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
