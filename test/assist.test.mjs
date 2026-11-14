import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {createSource} from '../src/source.mjs';
import {createServer} from '../src/app.mjs';
import {AssistService} from '../src/assist.mjs';

async function withHarness(callback,{browser}={}){
  const source=await createSource();
  const dir=await mkdtemp(join(tmpdir(),'joint-dossier-'));
  const sharedBrowser=browser??await chromium.launch({headless:true,args:['--no-sandbox']});
  const servers=[];
  const make=async(options={})=>{
    const server=await createServer({sourceUrl:source.url,dir,browser:sharedBrowser,...options});
    servers.push(server);
    return server;
  };
  try{return await callback({source,dir,make,browser:sharedBrowser});}
  finally{
    for(const server of servers)await server.close().catch(()=>{});
    if(!browser)await sharedBrowser.close().catch(()=>{});
    await source.close();
  }
}

async function call(server,path,body){
  const response=await fetch(server.url+path,{
    method:body===undefined?'GET':'POST',
    headers:body===undefined?{}:{'Content-Type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body)
  });
  return {status:response.status,value:await response.json()};
}

function department(snapshot,name){return snapshot.departments.find(item=>item.department===name);}

test('交错事件后工作台给出真实下一步：补件、更正登记与授权撤回',{timeout:60000},()=>withHarness(async ({make})=>{
  const server=await make();
  let snapshot=(await call(server,'/api/refresh',{})).value;
  assert.equal(snapshot.overall.status,'待补件');
  assert.equal(snapshot.nextStep.action,'supply');
  assert.match(snapshot.nextStep.label,/公积金.*付款凭证/);
  assert.equal(department(snapshot,'housing').pendingMaterials[0].kind,'file');

  let result=await call(server,'/api/dispatch/registry',{});
  assert.equal(result.value.action,'accepted');
  result=await call(server,'/api/dispatch/housing',{});
  assert.equal(result.value.action,'needs-supplement');
  assert.deepEqual(result.value.missing,['paymentProof']);

  result=await call(server,'/api/revise-address',{address:'迁入路三号'});
  snapshot=result.value.snapshot;
  assert.equal(snapshot.profile.version,2);
  assert.equal(department(snapshot,'registry').status,'accepted-outdated');
  assert.equal(department(snapshot,'registry').receipt.profileVersion,1);
  assert.equal(department(snapshot,'registry').receipt.fields.address,'迁入路一号');
  assert.equal(department(snapshot,'registry').corrections.at(-1).status,'待登记');
  assert.equal(snapshot.nextSteps.find(step=>step.action==='register-correction').department,'registry');

  result=await call(server,'/api/dispatch/registry',{});
  assert.equal(result.value.action,'correction-only','已受理分支不得重送新版');
  assert.equal(department(result.value.snapshot,'registry').receipt.profileVersion,1,'回执必须仍是旧版冻结事实');

  result=await call(server,'/api/revoke/medical',{});
  assert.equal(department(result.value.snapshot,'medical').status,'blocked-authorization');
  assert.equal(department(result.value.snapshot,'medical').receipt,null);
  result=await call(server,'/api/dispatch/medical',{});
  assert.equal(result.value.action,'blocked-authorization');

  result=await call(server,'/api/supply',{department:'housing',field:'paymentProof',value:'凭证-回单-8812'});
  assert.equal(result.value.action,'supplied');
  result=await call(server,'/api/dispatch/housing',{});
  assert.equal(result.value.action,'accepted');
  assert.equal(department(result.value.snapshot,'housing').receipt.profileVersion,2,'未送出的分支应使用修订后的新值');
  assert.equal(department(result.value.snapshot,'housing').receipt.fields.paymentProof,'凭证-回单-8812');

  snapshot=result.value.snapshot;
  assert.equal(snapshot.overall.complete,false);
  assert.notEqual(snapshot.overall.status,'已办结');
  assert.match(snapshot.overall.summary,/医保授权已撤回/);

  result=await call(server,'/api/corrections/acknowledge',{correctionId:department(snapshot,'registry').openCorrections[0].id});
  assert.equal(result.value.action,'registered');
  assert.equal(result.value.snapshot.overall.status,'部分受理，待授权');
  assert.ok(result.value.snapshot.nextSteps.some(step=>step.action==='reauthorize'));

  const sourceReceipts=await (await fetch(`${server.assist.sourceUrl}/receipts`)).json();
  const receipts=Object.values(sourceReceipts);
  assert.equal(receipts.length,2,'只应有登记与公积金两份真实回执');
  assert.ok(!receipts.some(item=>item.department==='medical'),'授权撤回后不得向医保送出任何材料');
}));

test('共用材料按版本记录使用去向，分支间不串用专用资料',{timeout:60000},()=>withHarness(async ({make})=>{
  const server=await make();
  await call(server,'/api/refresh',{});
  await call(server,'/api/dispatch/registry',{});
  await call(server,'/api/supply',{department:'housing',field:'paymentProof',value:'公积金专属凭证'});
  await call(server,'/api/revise-address',{address:'迁入路三号'});
  const result=await call(server,'/api/dispatch/housing',{});
  assert.equal(result.value.action,'accepted');
  const snapshot=result.value.snapshot;

  const housingReceipt=department(snapshot,'housing').receipt;
  assert.equal(housingReceipt.fields.paymentProof,'公积金专属凭证');
  assert.equal(housingReceipt.fields.address,'迁入路三号','未送出的分支应使用修订后的新值');
  assert.equal(housingReceipt.profileVersion,2);
  const registryReceipt=department(snapshot,'registry').receipt;
  assert.equal(registryReceipt.fields.paymentProof,undefined,'登记回执不应出现公积金专用文件');
  assert.equal(registryReceipt.fields.address,'迁入路一号','已受理分支保持冻结的旧值');

  const paymentMaterial=snapshot.materials.find(item=>item.field==='paymentProof');
  assert.equal(paymentMaterial.scope,'department');
  assert.equal(paymentMaterial.department,'housing');
  assert.deepEqual(paymentMaterial.uses.map(item=>item.department),['housing'],'专用文件不得被其他分支使用');

  const addressMaterials=snapshot.materials.filter(item=>item.field==='address');
  assert.ok(addressMaterials.every(item=>item.scope==='shared'));
  const v1=addressMaterials.find(item=>item.version===1);
  assert.deepEqual(v1.uses.map(item=>item.department),['registry']);
  const v2=addressMaterials.find(item=>item.version===2);
  assert.deepEqual(v2.uses.map(item=>item.department),['housing']);
  assert.ok(!v1.uses.some(item=>item.department==='housing'),'公积金不得被记录为使用过旧版地址');
}));

test('两个窗口并发分发同一份材料只产生一个真实回执',{timeout:60000},()=>withHarness(async ({make})=>{
  const first=await make();
  const second=await make();
  await call(first,'/api/refresh',{});
  const results=await Promise.all([
    call(first,'/api/dispatch/registry',{}),
    call(second,'/api/dispatch/registry',{})
  ]);
  const actions=results.map(item=>item.value.action).sort();
  assert.deepEqual(actions,['accepted','already-accepted'].sort());
  const receipts=await (await fetch(`${first.assist.sourceUrl}/receipts`)).json();
  assert.equal(Object.values(receipts).filter(item=>item.department==='registry').length,1,'两个窗口不能重复分发同一份材料');
}));

test('重启后继续同一事项且不重送已受理材料',{timeout:60000},()=>withHarness(async ({make})=>{
  const first=await make();
  await call(first,'/api/refresh',{});
  const accepted=(await call(first,'/api/dispatch/registry',{})).value;
  assert.equal(accepted.action,'accepted');
  const receiptId=department(accepted.snapshot,'registry').receipt.id;
  const revision=accepted.snapshot.revision;
  await first.close();

  const second=await make();
  const refreshed=(await call(second,'/api/refresh',{})).value;
  assert.ok(refreshed.revision>=revision,'重启后应读取同一事项文件');
  assert.equal(department(refreshed,'registry').receipt.id,receiptId);
  const retry=(await call(second,'/api/dispatch/registry',{})).value;
  assert.equal(retry.action,'already-accepted');
  const receipts=await (await fetch(`${second.assist.sourceUrl}/receipts`)).json();
  assert.equal(Object.values(receipts).filter(item=>item.department==='registry').length,1,'重启后不得重复分发');
}));

test('工作台页面按部门展示真实回执、授权依据与资料版本',{timeout:60000},()=>withHarness(async ({make,browser})=>{
  const server=await make({browser});
  await call(server,'/api/refresh',{});
  await call(server,'/api/dispatch/registry',{});
  const context=await browser.newContext();
  try{
    const page=await context.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(server.url+'/');
    await page.waitForFunction(()=>document.querySelector('#departments')?.children.length===3);
    const registryRow=page.locator('tr[data-department=registry]');
    assert.equal(await registryRow.getAttribute('data-status'),'accepted');
    assert.match(await registryRow.locator('td[data-receipt]').textContent(),/receipt-1/);
    assert.match(await registryRow.locator('td[data-authorization]').textContent(),/授权版本 1/);
    assert.match(await registryRow.locator('td[data-frozen]').textContent(),/企业资料 v1/);
    const housingRow=page.locator('tr[data-department=housing]');
    assert.equal(await housingRow.getAttribute('data-status'),'needs-supplement');
    assert.match(await page.locator('#nextStep').textContent(),/补交.*付款凭证/);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
}));

test('无法确定结果的分发先回读回执，不重复送出',{timeout:60000},()=>withHarness(async ({make,source})=>{
  const server=await make();
  await call(server,'/api/refresh',{});
  await fetch(`${source.url}/control`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({failureMode:'truncate'})});
  const first=(await call(server,'/api/dispatch/registry',{})).value;
  assert.equal(first.action,'indeterminate','响应被截断时不能当作已受理');
  assert.equal(department(first.snapshot,'registry').receipt,null);
  const pendingState=await readFile(join(server.assist.dir,'move-17.json'),'utf8');
  assert.match(pendingState,/"status": "pending"/);

  const sourceReceipts=await (await fetch(`${source.url}/receipts`)).json();
  assert.equal(Object.keys(sourceReceipts).length,1,'来源实际已记下回执，只是窗口没收到响应');
  const retry=(await call(server,'/api/dispatch/registry',{})).value;
  assert.equal(retry.action,'already-accepted','核对到已有回执后不得重送');
  assert.equal(department(retry.snapshot,'registry').receipt.profileVersion,1);
  assert.equal(department(retry.snapshot,'registry').receipt.source,'receipt-query','结论来自回读核对，而不是页面响应');
  const receipts=await (await fetch(`${source.url}/receipts`)).json();
  assert.equal(Object.values(receipts).filter(item=>item.department==='registry').length,1);
}));

test('共用字段在部门页被手改时仍以门户资料版本为准',{timeout:60000},()=>withHarness(async ({make})=>{
  const server=await make();
  await call(server,'/api/refresh',{});
  await server.assist.page.goto(`${server.assist.sourceUrl}/index.html`);
  await server.assist.page.locator('[data-dept=medical]').click();
  await server.assist.page.waitForFunction(()=>document.querySelector('#department')?.dataset.renderId);
  const result=await call(server,'/api/dispatch/medical',{});
  assert.equal(result.value.action,'accepted');
  assert.equal(department(result.value.snapshot,'medical').receipt.fields.address,'迁入路一号');
  assert.equal(department(result.value.snapshot,'medical').receipt.profileVersion,1);
}));

test('未回读前不得给出办结或可续办结论',{timeout:60000},()=>withHarness(async ({make})=>{
  const server=await make();
  const snapshot=(await call(server,'/api/snapshot')).value;
  assert.equal(snapshot.overall.status,'未回读');
  assert.equal(snapshot.overall.complete,false);
  assert.equal(snapshot.nextStep.action,'refresh');
  const dispatch=await call(server,'/api/dispatch/registry',{});
  assert.equal(dispatch.status,200,'分发会先回读，不应绕过页面状态');
  assert.equal(dispatch.value.action,'accepted');
}));

test('更正后已受理分支保持旧版、其余分支取新值，且不重复开更正单',{timeout:60000},()=>withHarness(async ({make})=>{
  const server=await make();
  await call(server,'/api/refresh',{});
  await call(server,'/api/dispatch/registry',{});
  const revised=(await call(server,'/api/revise-address',{address:'迁入路五号'})).value;
  assert.equal(revised.snapshot.corrections.filter(item=>item.status==='待登记').length,1);

  const retry=(await call(server,'/api/dispatch/registry',{})).value;
  assert.equal(retry.action,'correction-only');
  assert.equal(department(retry.snapshot,'registry').receipt.profileVersion,1);

  const medical=(await call(server,'/api/dispatch/medical',{})).value;
  assert.equal(medical.action,'accepted');
  assert.equal(department(medical.snapshot,'medical').receipt.fields.address,'迁入路五号');
  assert.equal(department(medical.snapshot,'medical').receipt.profileVersion,2);

  const firstCorrection=department(medical.snapshot,'registry').openCorrections[0];
  await call(server,'/api/corrections/acknowledge',{correctionId:firstCorrection.id});
  await call(server,'/api/supply',{department:'housing',field:'paymentProof',value:'凭证-回单-9901'});
  await call(server,'/api/dispatch/housing',{});
  const refreshed=(await call(server,'/api/refresh',{})).value;
  assert.equal(refreshed.corrections.filter(item=>item.department==='registry'&&item.status==='待登记').length,0,'已登记的更正不得在每次回读时重复生成');
  assert.equal(refreshed.overall.status,'待部门更正');
  assert.equal(refreshed.overall.complete,false);
  assert.ok(refreshed.nextSteps.some(step=>step.action==='await-department-correction'));
}));
