import {createHash} from 'node:crypto';

export function fingerprint(requirement,version,consent){
  return createHash('sha256')
    .update(JSON.stringify({requirement,version,consent}))
    .digest('hex')
    .slice(0,16);
}

export function sourceValue(source,field){
  return source.profile?.[field];
}

/**
 * 回读门户当前实际展示的部门要求。页面是唯一的业务入口，
 * 不在服务端从 requirements 配置反推，而是读取页面呈现后的 DOM。
 */
export async function observePortal(page,{departments}){
  await page.goto(page.__portalUrl,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('#profile')?.textContent?.includes('"version"'));
  const base=await page.evaluate(()=>({
    caseId:document.querySelector('#case').textContent,
    profile:JSON.parse(document.querySelector('#profile').textContent),
    consents:JSON.parse(document.querySelector('#consents').textContent),
    labels:Object.fromEntries([...document.querySelectorAll('[data-dept]')].map(button=>[button.dataset.dept,button.textContent.trim()]))
  }));
  const observation={...base,departments:{}};
  for(const department of departments){
    await page.locator(`[data-dept="${department}"]`).click();
    await page.waitForFunction(name=>{
      const section=document.querySelector('#department');
      return section?.dataset.department===name&&section.dataset.renderId&&document.querySelector('#send');
    },department);
    observation.departments[department]=await page.evaluate(()=>({
      requirements:[...document.querySelectorAll('#department input[data-field]')].map(input=>({
        name:input.dataset.field,kind:input.dataset.kind
      })),
      values:Object.fromEntries([...document.querySelectorAll('#department input[data-field]')].map(input=>[input.dataset.field,input.value])),
      sendId:document.querySelector('#send')?.id??null
    }));
  }
  return observation;
}

export async function openPortal(page,{url,departments,locator='#department input[data-field]'}){
  page.__portalUrl=url;
  page.__departments=departments;
  page.__fieldLocator=locator;
  return page;
}

export async function renderDepartment(page,department){
  await page.locator(`[data-dept="${department}"]`).click();
  await page.waitForFunction(name=>{
    const section=document.querySelector('#department');
    return section?.dataset.department===name&&section.dataset.renderId&&document.querySelector('#send');
  },department);
  return page.evaluate(()=>({
    department:document.querySelector('#department').dataset.department,
    requirements:[...document.querySelectorAll('#department input[data-field]')].map(input=>({name:input.dataset.field,kind:input.dataset.kind})),
    values:Object.fromEntries([...document.querySelectorAll('#department input[data-field]')].map(input=>[input.dataset.field,input.value]))
  }));
}

export async function fillDepartment(page,department,values){
  await renderDepartment(page,department);
  for(const [name,value] of Object.entries(values)){
    const input=page.locator(`#department input[data-field="${name}"]`);
    if(await input.count())await input.fill(String(value));
  }
}

export async function readReceipt(page){
  return page.evaluate(()=>({
    text:document.querySelector('#receipt').textContent,
    status:document.querySelector('#receipt').dataset.status,
    dispatchId:document.querySelector('#receipt').dataset.dispatchId
  }));
}

export async function dispatchDepartment(page,department,values){
  await fillDepartment(page,department,values);
  await page.locator('#send').click();
  await page.waitForFunction(()=>{
    const status=document.querySelector('#receipt').dataset.status;
    return status&&status!=='pending';
  },null,{timeout:5000});
  const receipt=await readReceipt(page);
  let parsed=null;
  try{parsed=JSON.parse(receipt.text);}catch{}
  return {...receipt,body:parsed};
}
