import {createSource} from '../src/source.mjs';
import {createServer} from '../src/app.mjs';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';

/**
 * 演示：在真实门户页面上依次发生
 * “登记已受理 → 迁入地址修订 → 医保授权撤回 → 公积金补件”，
 * 每一步都由真实点击触发，工作台与门户都按实际 DOM 回读。
 */
const source=await createSource();
const dir=await mkdtemp(join(tmpdir(),'demo-'));
const app=await createServer({sourceUrl:source.url,dir});
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const context=await browser.newContext();
const workbench=await context.newPage();
const portal=await context.newPage();
const log=(step,value)=>console.log(`\n## ${step}\n${JSON.stringify(value,null,2)}`);

async function workbenchClick(testId,{fill}={}){
  if(fill)await workbench.locator(`input[data-supply-for="${fill.field}"]`).fill(fill.value);
  const before=await workbench.locator('#output').textContent();
  await workbench.locator(`button[data-action="${testId}"]`).click();
  await workbench.waitForFunction(previous=>document.querySelector('#output').textContent!==previous,before);
  return workbench.evaluate(()=>({
    总述:document.querySelector('#headline').textContent,
    下一步:document.querySelector('#nextStep').textContent,
    完整:document.querySelector('#headline').dataset.complete
  }));
}
async function readWorkbench(){
  return workbench.evaluate(()=>({
    总述:document.querySelector('#summary').textContent,
    下一步:document.querySelector('#nextStep').textContent,
    待办:[...document.querySelectorAll('#steps li')].map(item=>item.textContent),
    部门:[...document.querySelectorAll('#departments tr')].map(row=>({
      部门:row.children[0].textContent,
      状态:row.children[1].textContent,
      待补材料:row.children[2].textContent,
      授权依据:row.children[3].textContent,
      使用的资料版本:row.children[4].textContent,
      真实回执:row.children[5].textContent
    })),
    更正:[...document.querySelectorAll('#corrections tr')].map(row=>[...row.children].slice(0,5).map(td=>td.textContent)),
    材料使用记录:[...document.querySelectorAll('#materials tr')].map(row=>[...row.children].map(td=>td.textContent))
  }));
}
async function portalAction(selector,{fill,field,wait}){
  if(fill)await portal.locator(field).fill(fill);
  await portal.locator(selector).click();
  await portal.waitForFunction(wait);
}

try{
  await workbench.goto(app.url+'/');
  await workbench.waitForFunction(()=>document.querySelector('#departments')?.children.length===3);
  log('① 初始回读：页面实际要求与授权',await readWorkbench());

  log('② 工作台点击“机器人续办·登记”',await workbenchClick('dispatch-registry'));

  await portal.goto(source.url+'/index.html');
  await portal.waitForFunction(()=>document.querySelector('#department')?.dataset.renderId);
  await portalAction('#revise',{
    fill:'迁入路三号',field:'#address',
    wait:()=>document.querySelector('#profile').textContent.includes('迁入路三号')
  });
  await workbench.locator('#refresh').click();
  await workbench.waitForFunction(()=>document.querySelector('tr[data-correction]'));
  log('③ 门户点击“修订地址”后回读：已受理分支冻结旧版并产生更正需求',await readWorkbench());

  log('④ 工作台点击“登记更正需求”',await workbenchClick('ack-registry-'+await workbench.evaluate(()=>document.querySelector('tr[data-correction]').dataset.correction)));

  await portalAction('[data-revoke=medical]',{wait:()=>document.querySelector('#consents').textContent.includes('"medical":null')});
  await workbench.locator('#refresh').click();
  await workbench.waitForFunction(()=>document.querySelector('tr[data-department=medical]')?.dataset.status==='blocked-authorization');
  log('⑥ 门户点击“撤回医保授权”后回读',await readWorkbench());

  log('⑦ 工作台登记公积金补件（付款凭证，文件类）',await workbenchClick('supply-housing',{fill:{field:'paymentProof',value:'凭证-回单-8812'}}));
  log('⑧ 工作台点击“机器人续办·公积金”',await workbenchClick('dispatch-housing'));
  log('⑨ 最终工作台',await readWorkbench());

  const receipts=Object.values(await (await fetch(source.url+'/receipts')).json());
  log('⑩ 来源真实回执（只应有登记与公积金，且版本不同）',receipts.map(item=>({
    id:item.id,部门:item.department,资料版本:item.profileVersion,授权版本:item.consentVersion,字段:item.fields
  })));
}finally{
  await context.close();await browser.close();await app.close();await source.close();
}
