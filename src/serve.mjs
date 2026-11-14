import {createSource} from './source.mjs';
import {createServer} from './app.mjs';

const source=await createSource({port:Number(process.env.PORT??process.env.SOURCE_PORT??0),host:process.env.HOST??'127.0.0.1'});
console.log(JSON.stringify({source:source.url,status:'来源服务就绪'}));
const status=await createServer({
  sourceUrl:process.env.SOURCE_URL??source.url,
  dir:process.env.STATE_DIR??'.local',
  caseId:process.env.CASE_ID??'move-17',
  headless:process.env.HEADLESS!=='0',
  port:Number(process.env.WORKBENCH_PORT??0)
});
console.log(JSON.stringify({workbench:status.url,status:'工作台就绪'}));
let stopping=false;
async function stop(){
  if(stopping)return;stopping=true;
  await status.close().catch(()=>{});
  await source.close().catch(()=>{});
  process.exit(0);
}
process.on('SIGTERM',stop);
process.on('SIGINT',stop);
