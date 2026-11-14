import {chromium} from 'playwright';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {Journal} from './journal.mjs';
import {observePortal,renderDepartment,fillDepartment,readReceipt,dispatchDepartment} from './portal.mjs';

export const DEPARTMENTS=['registry','medical','housing'];
const LABELS={registry:'登记',medical:'医保',housing:'公积金'};
const PROFILE_FIELDS=new Set(['name','address']);
const FIELD_LABELS={name:'企业名称',address:'迁入地址',paymentProof:'付款凭证'};

export class AssistError extends Error {
  constructor(message,status=400){super(message);this.name='AssistError';this.status=status;}
}

function now(){return new Date().toISOString();}
function signature(value){return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,16);}
function requirementName(requirement){return typeof requirement==='string'?requirement:requirement.name;}
function requirementLabel(requirement){
  const name=requirementName(requirement);
  return (typeof requirement==='object'&&requirement.label)||FIELD_LABELS[name]||name;
}
function requirementKind(requirement){return (typeof requirement==='object'&&requirement.kind)||'field';}

function emptyState(caseId){
  return {
    caseId,
    revision:0,
    createdAt:now(),
    updatedAt:null,
    observedAt:null,
    portal:{caseId,profileVersion:null,profile:{},consents:{},labels:{}},
    observations:{departments:{}},
    departments:{},
    supplied:{},
    materials:[],
    attempts:[],
    corrections:[],
    events:[],
    seq:1
  };
}

export class AssistService {
  constructor({sourceUrl,dir,caseId='move-17',browser=null,headless=true,lockTimeoutMs=60000,departments=DEPARTMENTS}){
    if(!sourceUrl)throw new AssistError('缺少来源地址');
    if(!dir)throw new AssistError('缺少业务状态目录');
    this.sourceUrl=sourceUrl.replace(/\/$/,'');
    this.caseId=caseId;
    this.dir=dir;
    this.browser=browser;
    this.ownsBrowser=false;
    this.headless=headless;
    this.departments=[...departments];
    this.journal=new Journal({dir,caseId});
    this.lockTimeoutMs=lockTimeoutMs;
    this.page=null;
    this.context=null;
  }

  async start(){
    await mkdir(this.dir,{recursive:true});
    if(!this.browser){
      this.browser=await chromium.launch({headless:this.headless,args:['--no-sandbox']});
      this.ownsBrowser=true;
    }
    this.context=await this.browser.newContext();
    this.page=await this.context.newPage();
    this.page.__portalUrl=`${this.sourceUrl}/index.html`;
    return this;
  }

  async close(){
    if(this.context)await this.context.close().catch(()=>{});
    if(this.ownsBrowser&&this.browser)await this.browser.close().catch(()=>{});
    this.context=null;this.page=null;
  }

  _event(state,type,detail={}){
    state.events.push({seq:state.seq++,at:now(),type,...detail});
    if(state.events.length>500)state.events=state.events.slice(-500);
  }

  async _load(){
    return (await this.journal.read())??emptyState(this.caseId);
  }

  async _save(state){
    state.revision=(state.revision||0)+1;
    return this.journal.write(state);
  }

  _withLock(callback){
    return this.journal.withLock(callback,{timeoutMs:this.lockTimeoutMs});
  }

  async _readPortal(){
    if(!this.page)throw new AssistError('浏览器尚未启动，无法回读门户',503);
    return observePortal(this.page,{departments:this.departments});
  }

  _applyObservation(state,observation){
    const at=now();
    const previousVersion=state.portal.profileVersion;
    state.observedAt=at;
    state.portal={
      caseId:observation.caseId,
      profileVersion:observation.profile.version,
      profile:observation.profile,
      consents:observation.consents,
      labels:observation.labels??{},
      observedAt:at
    };
    state.observations={departments:observation.departments};
    if(previousVersion===null){
      this._event(state,'portal-read',{caseId:observation.caseId,profileVersion:observation.profile.version,consents:observation.consents});
    }else if(previousVersion!==observation.profile.version){
      this._event(state,'profile-version-changed',{from:previousVersion,to:observation.profile.version,profile:observation.profile});
    }
    for(const department of this.departments){
      const observed=observation.departments[department];
      const record=state.departments[department]??={authorization:{version:null,state:'unknown'},requirements:[],requirementSignature:null,needs:[]};
      const previousRequirements=record.requirementSignature;
      record.requirements=observed.requirements;
      record.requirementSignature=signature(observed.requirements);
      if(previousRequirements&&previousRequirements!==record.requirementSignature){
        this._event(state,'requirements-changed',{department,requirements:observed.requirements});
      }
      const previousConsent=record.authorization?.version??null;
      const consent=observation.consents[department]??null;
      record.authorization={version:consent,state:consent===null?'revoked':'active',observedAt:at};
      if(previousConsent!==consent){
        this._event(state,consent===null?'authorization-revoked':'authorization-active',{department,from:previousConsent,to:consent});
      }
    }
  }

  _latestSupplied(state,department,field){
    return state.supplied?.[department]?.[field]??null;
  }

  _planMaterials(state,department){
    const observed=state.observations.departments[department];
    const profile=state.portal.profile||{};
    const version=state.portal.profileVersion;
    const consent=state.portal.consents?.[department]??null;
    if(!observed)return {department,requirements:[],values:{},missing:[],versions:{},profileVersion:version,consentVersion:consent};
    const values={};const versions={};const missing=[];
    for(const requirement of observed.requirements){
      const field=requirementName(requirement);
      const kind=requirementKind(requirement);
      let value;let scope='shared';let materialVersion=version;let source='portal';
      if(PROFILE_FIELDS.has(field)&&Object.hasOwn(profile,field)){
        // 共用字段只认门户修订后的企业资料版本，不能采信部门页输入框里的手改值。
        value=profile[field];scope='shared';materialVersion=version;source='profile';
      }else{
        const pageValue=observed.values?.[field];
        const supplied=this._latestSupplied(state,department,field);
        if(pageValue!==undefined&&pageValue!==null&&String(pageValue).length){
          value=pageValue;
          if(supplied&&supplied.value===pageValue){scope='department';materialVersion=supplied.version;source='supplied';}
          else {scope='department';materialVersion=0;source='page';}
        }else if(supplied){
          value=supplied.value;scope='department';materialVersion=supplied.version;source='supplied';
        }
      }
      if(value===undefined||value===null||String(value).length===0){
        missing.push({field,kind,label:requirementLabel(requirement),reason:'missing'});
      }else{
        values[field]=value;
        versions[field]={scope,materialVersion,source,kind,label:requirementLabel(requirement)};
      }
    }
    return {department,requirements:observed.requirements,values,versions,missing,profileVersion:version,consentVersion:consent};
  }

  _receiptFor(state,dispatchId){
    for(const department of this.departments){
      const accepted=state.departments[department]?.accepted;
      if(accepted?.dispatchId===dispatchId)return {department,accepted};
    }
    return null;
  }

  _accept(state,department,receipt,{source,attempt}){
    const record=state.departments[department];
    record.accepted={
      receiptId:receipt.id,
      status:receipt.status??'受理',
      profileVersion:receipt.profileVersion,
      consentVersion:receipt.consentVersion??attempt?.consentVersion??state.portal.consents[department],
      fields:{...(receipt.fields||{})},
      acceptedAt:attempt?.at??now(),
      dispatchId:attempt?.dispatchId??receipt.dispatchId??null,
      materialVersions:attempt?.materialVersions??{},
      source
    };
    if(attempt){attempt.status='accepted';attempt.receiptId=receipt.id;attempt.receiptSource=source;attempt.finishedAt=now();}
    for(const need of record.needs??[]){
      if(need.status!=='satisfied'){need.status='satisfied';need.satisfiedAt=now();}
    }
    this._recordMaterialUses(state,department,attempt?.values??record.accepted.fields,attempt?.materialVersions??{},{
      dispatchId:attempt?.dispatchId??null,profileVersion:record.accepted.profileVersion,consentVersion:record.accepted.consentVersion,outcome:'accepted'
    });
    this._syncCorrections(state,department);
    this._event(state,'branch-accepted',{department,receiptId:receipt.id,profileVersion:record.accepted.profileVersion,consentVersion:record.accepted.consentVersion,source});
  }

  _recordMaterialUses(state,department,values,versions,context){
    for(const [field,value] of Object.entries(values||{})){
      const versionInfo=versions?.[field]??{scope:PROFILE_FIELDS.has(field)?'shared':'department',materialVersion:context.profileVersion,source:'unknown',kind:'field'};
      const key=versionInfo.scope==='shared'
        ? `shared:${field}:${versionInfo.materialVersion}`
        : `department:${department}:${field}:${versionInfo.materialVersion}`;
      let material=state.materials.find(item=>item.key===key);
      if(versionInfo.scope==='shared'){
        if(!material){material={key,field,scope:'shared',department:null,version:versionInfo.materialVersion,kind:versionInfo.kind??'field',value,firstUsedAt:now(),uses:[]};state.materials.push(material);}
      }else if(!material){
        material={key,field,scope:'department',department,version:versionInfo.materialVersion,kind:versionInfo.kind??'field',value,firstUsedAt:now(),uses:[]};
        state.materials.push(material);
      }
      if(!material.uses.some(use=>use.dispatchId===context.dispatchId&&use.department===department)){
        material.uses.push({department,dispatchId:context.dispatchId,profileVersion:context.profileVersion,consentVersion:context.consentVersion,outcome:context.outcome,at:now()});
      }
    }
  }

  _syncCorrections(state,department){
    const record=state.departments[department];
    const accepted=record.accepted;
    if(!accepted)return;
    const profile=state.portal.profile||{};
    for(const requirement of record.requirements){
      const field=requirementName(requirement);
      if(!PROFILE_FIELDS.has(field)||!Object.hasOwn(profile,field))continue;
      const acceptedValue=accepted.fields[field];
      const currentValue=profile[field];
      const existing=state.corrections.filter(item=>item.department===department&&item.field===field);
      const open=existing.find(item=>item.status==='待登记');
      if(acceptedValue===currentValue){
        if(open){
          open.status='已消解';
          open.updatedAt=now();
          this._event(state,'correction-resolved',{correctionId:open.id,department,field,toVersion:state.portal.profileVersion});
        }
        continue;
      }
      if(open){
        if(open.toValue!==currentValue||open.toVersion!==state.portal.profileVersion){
          open.toValue=currentValue;
          open.toVersion=state.portal.profileVersion;
          open.updatedAt=now();
          this._event(state,'correction-updated',{correctionId:open.id,department,field,toVersion:open.toVersion});
        }
        continue;
      }
      // 已登记或已消解的更正覆盖当前版本时，不得在每次回读时重复开单。
      const covered=existing.some(item=>
        item.fromVersion===accepted.profileVersion
        && item.toVersion===state.portal.profileVersion
        && item.toValue===currentValue
        && ['已登记','已消解'].includes(item.status));
      if(covered)continue;
      const correction={
        id:`correction-${state.seq++}`,
        department,
        field,
        fromValue:acceptedValue,
        toValue:currentValue,
        fromVersion:accepted.profileVersion,
        toVersion:state.portal.profileVersion,
        receiptId:accepted.receiptId,
        status:'待登记',
        openedAt:now()
      };
      state.corrections.push(correction);
      this._event(state,'correction-required',{correctionId:correction.id,department,field,fromVersion:correction.fromVersion,toVersion:correction.toVersion});
    }
  }

  _syncNeeds(state,department){
    const record=state.departments[department];
    if(record.accepted)return;
    if((record.authorization?.version??null)===null)return;
    const plan=this._planMaterials(state,department);
    for(const missing of plan.missing){
      let need=(record.needs??[]).find(item=>item.field===missing.field&&item.status!=='satisfied');
      if(!need){
        need={field:missing.field,kind:missing.kind,label:missing.label,status:'open',openedAt:now()};
        record.needs??=[];
        record.needs.push(need);
        this._event(state,'supplement-required',{department,field:missing.field,kind:missing.kind});
      }
    }
    for(const need of record.needs??[]){
      const supplied=this._latestSupplied(state,department,need.field);
      if(supplied&&need.status==='open'){need.status='provided';need.providedAt=now();}
    }
  }

  _syncDerived(state){
    for(const department of this.departments)this._syncCorrections(state,department);
    for(const department of this.departments)this._syncNeeds(state,department);
  }

  async _readReceipts(){
    const response=await fetch(`${this.sourceUrl}/receipts`,{signal:AbortSignal.timeout(4000)});
    if(!response.ok)throw new Error(`回执查询失败: ${response.status}`);
    return response.json();
  }

  async _reconcile(state){
    const pending=state.attempts.filter(attempt=>['in-flight','pending','unknown'].includes(attempt.status));
    if(!pending.length)return;
    let receipts;
    try{receipts=await this._readReceipts();}
    catch(error){
      this._event(state,'receipt-lookup-failed',{detail:String(error?.message||error)});
      return;
    }
    for(const attempt of pending){
      const receipt=this._matchReceipt(state,receipts,attempt);
      if(receipt){
        const record=state.departments[attempt.department];
        if(!record.accepted)this._accept(state,attempt.department,receipt,{source:'receipt-query',attempt});
      }else{
        const consent=state.portal.consents?.[attempt.department]??null;
        attempt.status=consent===null?'undelivered-revoked':'undelivered';
        attempt.resolvedAt=now();
        this._event(state,attempt.status==='undelivered-revoked'?'attempt-blocked-by-revocation':'attempt-undelivered',{department:attempt.department,dispatchId:attempt.dispatchId});
      }
    }
  }

  _dispatchId(department,profileVersion,consentVersion,values){
    return `bot-${signature({caseId:this.caseId,department,profileVersion,consentVersion,values})}`;
  }

  /**
   * 回执按内容核对，不依赖某个进程生成的 dispatchId：
   * 部门、资料版本、授权版本与全部字段一致才算同一份分发。
   */
  _matchReceipt(state,receipts,attempt){
    for(const receipt of Object.values(receipts||{})){
      if(receipt.department!==attempt.department)continue;
      if(receipt.profileVersion!==attempt.profileVersion)continue;
      if(receipt.consentVersion!==undefined&&receipt.consentVersion!==attempt.consentVersion)continue;
      if(signature(receipt.fields??{})!==signature(attempt.values??{}))continue;
      return receipt;
    }
    return null;
  }

  async _observeAndApply(state){
    const observation=await this._readPortal();
    this._applyObservation(state,observation);
    await this._reconcile(state);
    this._syncDerived(state);
    return observation;
  }

  async refresh(){
    return this._withLock(async()=>{
      const state=await this._load();
      await this._observeAndApply(state);
      this._event(state,'workbench-refreshed',{profileVersion:state.portal.profileVersion});
      await this._save(state);
      return this.snapshot(state);
    });
  }

  async dispatch(department){
    if(!this.departments.includes(department))throw new AssistError(`未知部门: ${department}`,404);
    return this._withLock(async()=>{
      const state=await this._load();
      await this._observeAndApply(state);
      const record=state.departments[department];
      const consent=state.portal.consents?.[department]??null;

      if(record.accepted){
        const correction=state.corrections.find(item=>item.department===department&&item.status==='待登记');
        const action=correction?'correction-only':'already-accepted';
        this._event(state,'dispatch-skipped',{department,reason:action});
        await this._save(state);
        return {department,action,message:correction?'该分支已受理，只能登记更正需求，不能重送新版本':'该分支已受理，不重复分发',snapshot:this.snapshot(state)};
      }
      if(consent===null){
        this._event(state,'dispatch-blocked',{department,reason:'authorization-revoked'});
        await this._save(state);
        return {department,action:'blocked-authorization',message:'授权已撤回，不向该部门送出任何新材料',snapshot:this.snapshot(state)};
      }

      const plan=this._planMaterials(state,department);
      const dispatchId=this._dispatchId(department,plan.profileVersion,plan.consentVersion,plan.values);
      const known=state.attempts.find(attempt=>
        attempt.department===department
        && attempt.profileVersion===plan.profileVersion
        && attempt.consentVersion===plan.consentVersion
        && signature(attempt.values??{})===signature(plan.values)
        && ['in-flight','pending','accepted'].includes(attempt.status));
      if(known){
        this._event(state,'duplicate-prevented',{department,dispatchId:known.dispatchId,status:known.status});
        await this._save(state);
        return {department,action:known.status==='accepted'?'duplicate-prevented':'indeterminate',message:'同一份材料已有分发记录，未重复送出; 如回执未确认，先回读核对',snapshot:this.snapshot(state)};
      }

      const attempt={
        id:`attempt-${state.seq++}`,
        at:now(),
        department,
        dispatchId,
        profileVersion:plan.profileVersion,
        consentVersion:plan.consentVersion,
        values:{...plan.values},
        materialVersions:{...plan.versions},
        missing:[...plan.missing],
        status:'in-flight'
      };
      state.attempts.push(attempt);
      if(plan.missing.length){
        for(const missing of plan.missing){
          if(!(record.needs??[]).some(need=>need.field===missing.field&&need.status!=='satisfied')){
            record.needs??=[];
            record.needs.push({field:missing.field,kind:missing.kind,label:missing.label,status:'open',openedAt:now()});
          }
        }
      }
      state.departments[department]=record;
      await this._save(state);

      let result;
      try{
        result=await dispatchDepartment(this.page,department,plan.values);
      }catch(error){
        attempt.status='pending';
        attempt.error=String(error?.message||error);
        this._event(state,'dispatch-network-uncertain',{department,dispatchId,detail:attempt.error});
        await this._save(state);
        return {department,action:'indeterminate',message:'回执未收到，下一次回读会先向来源核对，不会盲目重送',snapshot:this.snapshot(state)};
      }

      const status=Number(result.status);
      const body=result.body;
      if(status===200&&body?.id){
        this._accept(state,department,body,{source:'page',attempt});
        await this._save(state);
        return {department,action:'accepted',message:`${LABELS[department]??department}已受理，回执 ${body.id}`,receipt:body,snapshot:this.snapshot(state)};
      }
      if(status===422){
        attempt.status='rejected';
        attempt.finishedAt=now();
        attempt.missing=body?.missing??plan.missing.map(item=>item.field);
        for(const field of attempt.missing){
          let need=(record.needs??[]).find(item=>item.field===field&&item.status!=='satisfied');
          if(!need){
            const requirement=plan.requirements.find(item=>requirementName(item)===field);
            record.needs??=[];
            need={field,kind:requirementKind(requirement??field),label:requirementLabel(requirement??field),status:'open',openedAt:now()};
            record.needs.push(need);
          }
          need.attemptedAt=now();
        }
        this._event(state,'supplement-required',{department,missing:attempt.missing});
        await this._save(state);
        return {department,action:'needs-supplement',message:`${LABELS[department]??department}要求补件: ${attempt.missing.join(', ')}`,missing:attempt.missing,snapshot:this.snapshot(state)};
      }
      if(status===403){
        attempt.status='rejected';
        attempt.finishedAt=now();
        attempt.error=body?.error??'授权失效';
        this._event(state,'authorization-rejected-by-source',{department,detail:attempt.error});
        await this._save(state);
        return {department,action:'blocked-authorization',message:'来源拒绝：授权失效，未受理任何材料',snapshot:this.snapshot(state)};
      }
      if(status===409){
        attempt.status='rejected';
        attempt.finishedAt=now();
        attempt.error=body?.error??'资料版本失效';
        this._event(state,'version-conflict',{department,detail:attempt.error,profileVersion:plan.profileVersion});
        await this._save(state);
        return {department,action:'stale-version',message:'资料版本已变化，本次未受理；请回读后按新版本续办',snapshot:this.snapshot(state)};
      }
      if(status===503){
        attempt.status='pending';
        attempt.error=body?.error??'部门接收暂不可用';
        this._event(state,'department-unavailable',{department});
        await this._save(state);
        return {department,action:'indeterminate',message:'部门接收暂不可用，未确认受理；将继续核对回执',snapshot:this.snapshot(state)};
      }
      attempt.status='pending';
      attempt.error=`HTTP ${result.status}: ${result.text}`;
      this._event(state,'dispatch-unknown-response',{department,status:result.status,detail:result.text});
      await this._save(state);
      return {department,action:'indeterminate',message:'收到未知响应，未确认受理；将继续核对回执',snapshot:this.snapshot(state)};
    });
  }

  async supply({department,field,value}){
    if(!this.departments.includes(department))throw new AssistError(`未知部门: ${department}`,404);
    if(value===undefined||value===null||String(value).trim()==='')throw new AssistError('补件内容不能为空');
    return this._withLock(async()=>{
      const state=await this._load();
      const record=state.departments[department];
      if(!record)throw new AssistError('请先回读门户，确认该部门要求');
      const requirement=record.requirements.find(item=>requirementName(item)===field);
      if(!requirement)throw new AssistError(`字段 ${field} 不属于${LABELS[department]??department}的要求`);
      if(PROFILE_FIELDS.has(field))throw new AssistError('企业共用字段只能在门户修订，不能作为部门补件替换');
      if(record.accepted)throw new AssistError('该分支已受理，只能登记更正需求，不能替换已冻结资料',409);
      state.supplied[department]??={};
      const previous=state.supplied[department][field];
      state.supplied[department][field]={value:String(value),version:(previous?.version??0)+1,providedAt:now()};
      const need=(record.needs??[]).find(item=>item.field===field&&item.status!=='satisfied');
      if(need){need.status='provided';need.providedAt=now();}
      this._event(state,'supplement-provided',{department,field,version:state.supplied[department][field].version});
      await this._save(state);
      return {department,field,action:'supplied',message:`已登记${LABELS[department]??department}补件 ${field}（第 ${state.supplied[department][field].version} 版），尚未分发`,snapshot:this.snapshot(state)};
    });
  }

  async reviseAddress(address){
    if(!String(address??'').trim())throw new AssistError('迁入地址不能为空');
    return this._withLock(async()=>{
      if(!this.page)throw new AssistError('浏览器尚未启动',503);
      await this.page.goto(this.page.__portalUrl,{waitUntil:'domcontentloaded'});
      await this.page.getByLabel('迁入地址').fill(String(address));
      await this.page.locator('#revise').click();
      await this.page.waitForFunction(value=>document.querySelector('#profile')?.textContent?.includes(value),String(address));
      const state=await this._load();
      await this._observeAndApply(state);
      await this._save(state);
      return {action:'revised',address:String(address),message:`门户迁入地址已修订为 ${address}`,snapshot:this.snapshot(state)};
    });
  }

  async revokeConsent(department){
    if(!this.departments.includes(department))throw new AssistError(`未知部门: ${department}`,404);
    return this._withLock(async()=>{
      if(!this.page)throw new AssistError('浏览器尚未启动',503);
      await this.page.goto(this.page.__portalUrl,{waitUntil:'domcontentloaded'});
      const button=this.page.locator(`[data-revoke="${department}"]`);
      if(!(await button.count()))throw new AssistError(`门户没有${LABELS[department]??department}的撤回授权控件，请由窗口在门户操作`,409);
      await button.click();
      await this.page.waitForFunction(name=>document.querySelector('#consents')?.textContent?.includes(`"${name}":null`),department);
      const state=await this._load();
      await this._observeAndApply(state);
      await this._save(state);
      return {action:'revoked',department,message:`${LABELS[department]??department}授权已撤回，不再送出新材料`,snapshot:this.snapshot(state)};
    });
  }

  async acknowledgeCorrection(correctionId,{note=''}={}){
    return this._withLock(async()=>{
      const state=await this._load();
      const correction=state.corrections.find(item=>item.id===correctionId);
      if(!correction)throw new AssistError(`未知更正需求: ${correctionId}`,404);
      if(correction.status==='待登记'){
        correction.status='已登记';
        correction.acknowledgedAt=now();
        correction.note=String(note||'');
        this._event(state,'correction-registered',{correctionId,department:correction.department,field:correction.field,toVersion:correction.toVersion});
      }
      await this._save(state);
      return {correctionId,action:'registered',message:'已在窗口记录中登记更正需求；未向已受理分支重送资料',snapshot:this.snapshot(state)};
    });
  }

  async getSnapshot(){
    return this.snapshot(await this._load());
  }

  snapshot(state){
    const portal=state.portal??{};
    const observedVersion=portal.profileVersion;
    const departments=this.departments.map(department=>this._departmentView(state,department));
    const pendingSupplements=departments.filter(item=>item.status==='needs-supplement');
    const pendingRecovery=departments.filter(item=>item.status==='indeterminate');
    const blocked=departments.filter(item=>item.status==='blocked-authorization');
    const revokedAccepted=departments.filter(item=>item.status==='accepted-authorization-revoked');
    const openCorrections=state.corrections.filter(item=>item.status==='待登记');
    const registeredCorrections=state.corrections.filter(item=>item.status==='已登记');
    const acceptedOutdated=departments.filter(item=>item.receipt&&item.receipt.profileVersion!==observedVersion);
    const notAccepted=departments.filter(item=>!item.receipt);
    const allCurrent=departments.every(item=>item.receipt&&item.receipt.profileVersion===observedVersion&&item.receipt.consentVersion===item.authorization.version&&item.authorization.version!==null);
    const nextSteps=this._nextSteps(state,departments,openCorrections,registeredCorrections);

    let overall;
    if(observedVersion===null){
      overall={status:'未回读',label:'未回读门户',complete:false,summary:'机器人尚未回读门户，不能判断任何分支状态。'};
    }else if(pendingSupplements.length){
      const notes=[];
      if(blocked.length||revokedAccepted.length)notes.push(`${[...blocked,...revokedAccepted].map(item=>item.label).join('、')}授权已撤回，已受理回执保留但不得再送新材料`);
      if(openCorrections.length)notes.push(`另有 ${openCorrections.length} 条更正需求待登记`);
      overall={status:'待补件',label:'待补件',complete:false,summary:`${pendingSupplements.map(item=>item.label).join('、')}待补材料；其余已就绪分支仍可继续，但总事项不能报办结。${notes.length?' '+notes.join('；')+'。':''}`};
    }else if(pendingRecovery.length){
      overall={status:'待核对回执',label:'待核对回执',complete:false,summary:'存在结果未明的分发，下一次回读先核对来源回执，不能按已提交或已办结处理。'};
    }else if(blocked.length||revokedAccepted.length){
      const parts=[];
      if(openCorrections.length)parts.push(`另有 ${openCorrections.length} 条更正需求待登记`);
      if(acceptedOutdated.length)parts.push(`${acceptedOutdated.map(item=>item.label).join('、')}的回执仍冻结旧版资料`);
      overall={status:'部分受理，待授权',label:'部分受理，待授权',complete:false,summary:`${[...blocked,...revokedAccepted].map(item=>item.label).join('、')}授权已撤回；已合法受理的回执保留，但不得再送新材料，总事项未办结。${parts.length?parts.join('；')+'。':''}`};
    }else if(openCorrections.length){
      overall={status:'待登记更正',label:'待登记更正',complete:false,summary:`已受理分支冻结了旧版资料，存在 ${openCorrections.length} 条更正需求待窗口登记；不能伪装成已按新版办结。`};
    }else if(acceptedOutdated.length){
      overall={status:'待部门更正',label:'待部门更正',complete:false,summary:`${acceptedOutdated.map(item=>item.label).join('、')}已受理的是旧版资料，更正需求已登记但尚无部门更正回执；总事项未办结。`};
    }else if(allCurrent){
      overall={status:'已办结',label:'已办结',complete:true,summary:'所有部门均已按当前资料版本与有效授权受理。'};
    }else{
      overall={status:'可续办',label:'可续办',complete:false,summary:`尚无受理回执的分支: ${notAccepted.map(item=>item.label).join('、')||'无'}。`};
    }

    return {
      caseId:state.caseId,
      revision:state.revision,
      observedAt:state.observedAt,
      profile:{...portal.profile,version:observedVersion},
      labels:portal.labels??{},
      overall,
      nextStep:nextSteps[0]??null,
      nextSteps,
      departments,
      materials:state.materials,
      corrections:state.corrections,
      supplied:state.supplied,
      events:state.events.slice(-50),
      stats:{
        receipts:departments.filter(item=>item.receipt).length,
        pendingMaterials:departments.reduce((total,item)=>total+item.pendingMaterials.length,0),
        openCorrections:openCorrections.length
      },
      storage:{
        note:'状态保存在事项文件中；同一事项的并发操作通过文件锁串行化。',
        caseId:state.caseId
      }
    };
  }

  _departmentView(state,department){
    const record=state.departments[department]??{requirements:[],authorization:{version:null,state:'unknown'},needs:[]};
    const label=state.portal.labels?.[department]||LABELS[department]||department;
    const plan=this._planMaterials(state,department);
    const accepted=record.accepted??null;
    const consent=record.authorization?.version??null;
    const observed=Boolean(state.observedAt);
    const openCorrections=state.corrections.filter(item=>item.department===department&&item.status==='待登记');
    const attempts=state.attempts.filter(item=>item.department===department).slice(-10);
    const pendingAttempt=attempts.find(item=>['in-flight','pending','unknown'].includes(item.status));

    let status;let statusLabel;
    if(!observed){
      status='unobserved';statusLabel='未回读';
    }else if(accepted){
      if(consent===null){status='accepted-authorization-revoked';statusLabel='已受理，授权已撤回';}
      else if(openCorrections.length){status='accepted-outdated';statusLabel='已受理（冻结旧版），待登记更正';}
      else if(accepted.profileVersion!==state.portal.profileVersion){status='accepted-outdated';statusLabel=`已受理（资料冻结 v${accepted.profileVersion}），更正已登记`;}
      else {status='accepted';statusLabel='已受理';}
    }else if(consent===null){status='blocked-authorization';statusLabel='授权已撤回，禁止分发';}
    else if(plan.missing.length){status='needs-supplement';statusLabel='待补材料';}
    else if(pendingAttempt){status='indeterminate';statusLabel='回执未确认';}
    else {status='ready';statusLabel='可分发';}

    const blockedNow=!accepted&&consent===null;
    const usage=accepted?Object.entries(accepted.fields).map(([field,value])=>{
      const versionInfo=accepted.materialVersions?.[field];
      return {
        field,
        label:versionInfo?.label||FIELD_LABELS[field]||field,
        kind:versionInfo?.kind||'field',
        value,
        scope:versionInfo?.scope||(PROFILE_FIELDS.has(field)?'shared':'department'),
        materialVersion:versionInfo?.materialVersion??accepted.profileVersion,
        versionLabel:PROFILE_FIELDS.has(field)?`企业资料 v${accepted.profileVersion}`:`${label}材料 v${versionInfo?.materialVersion??'?'}`,
        frozen:true,
        note:'回执冻结值'
      };
    }):blockedNow?[]:Object.entries(plan.values).map(([field,value])=>{
      const versionInfo=plan.versions[field];
      return {
        field,
        label:versionInfo.label,
        kind:versionInfo.kind,
        value,
        scope:versionInfo.scope,
        materialVersion:versionInfo.materialVersion,
        versionLabel:versionInfo.scope==='shared'?`企业资料 v${versionInfo.materialVersion}`:`${label}材料 v${versionInfo.materialVersion}`,
        frozen:false,
        note:'拟分发值（未受理）'
      };
    });

    return {
      department,
      label,
      status,
      statusLabel,
      requirements:record.requirements.map(item=>({field:requirementName(item),label:requirementLabel(item),kind:requirementKind(item),kindLabel:requirementKind(item)==='file'?'文件':'字段'})),
      pendingMaterials:accepted||blockedNow?[]:plan.missing.map(item=>({...item,pending:true})),
      authorization:{
        version:consent,
        state:!observed?'unobserved':consent===null?'revoked':'active',
        label:!observed?'尚未回读':consent===null?'已撤回，不得再送新材料':`授权版本 ${consent}，有效`,
        basis:accepted?`受理时授权版本 ${accepted.consentVersion}；当前 ${consent===null?'已撤回':`版本 ${consent}`}`:'尚未形成受理回执',
        observedAt:record.authorization?.observedAt??null
      },
      usage,
      receipt:accepted?{
        id:accepted.receiptId,
        status:accepted.status,
        profileVersion:accepted.profileVersion,
        consentVersion:accepted.consentVersion,
        fields:accepted.fields,
        acceptedAt:accepted.acceptedAt,
        source:accepted.source,
        dispatchId:accepted.dispatchId
      }:null,
      corrections:state.corrections.filter(item=>item.department===department).slice(-10),
      openCorrections,
      attempts:attempts.map(item=>({...item,values:undefined,materialVersions:undefined})),
      nextAction:null
    };
  }

  _nextSteps(state,departments,openCorrections,registeredCorrections=[]){
    const steps=[];
    if(!state.observedAt)return [{priority:0,department:null,action:'refresh',label:'先回读门户',detail:'机器人尚未读取页面实际要求与授权，任何分发和结论都不可靠。'}];
    for(const department of departments){
      if(department.status==='indeterminate'){
        steps.push({priority:5,department:department.department,action:'reconcile',label:`${department.label}：先核对来源回执`,detail:'存在结果未明的分发，回读后按回执确认；未确认前不得当作已受理或已办结。'});
      }
      if(department.status==='needs-supplement'){
        steps.push({priority:10,department:department.department,action:'supply',label:`${department.label}：补交 ${department.pendingMaterials.map(item=>item.label).join('、')}`,detail:'补件只影响该分支；其他已就绪或已受理分支不受阻塞，但总事项保持未办结。'});
      }
      if(department.authorization.version===null){
        steps.push({priority:20,department:department.department,action:'reauthorize',label:`${department.label}：取得重新授权`,detail:department.receipt?'既往回执仍然有效，但重新授权前不得送出更正后的新材料。':'授权撤回期间不得送出任何材料；重新授权后再由机器人回读并分发。'});
      }
      const corrections=openCorrections.filter(item=>item.department===department.department);
      if(corrections.length){
        steps.push({priority:30,department:department.department,action:'register-correction',correctionIds:corrections.map(item=>item.id),label:`${department.label}：登记${corrections.map(item=>FIELD_LABELS[item.field]||item.field).join('、')}更正 ${corrections[0].fromVersion}→${corrections[0].toVersion}`,detail:'该分支已受理，机器人不会重送新版本；只登记更正需求，由窗口与部门办理。'});
      }
      const registered=registeredCorrections.filter(item=>item.department===department.department);
      if(registered.length&&department.receipt&&department.receipt.profileVersion!==state.portal.profileVersion){
        steps.push({priority:35,department:department.department,action:'await-department-correction',correctionIds:registered.map(item=>item.id),label:`${department.label}：等待部门按更正后资料重新确认`,detail:'更正需求已登记，但该分支回执仍冻结旧版；总事项不能报办结。'});
      }
      if(department.status==='ready'&&!corrections.length){
        steps.push({priority:15,department:department.department,action:'dispatch',label:`${department.label}：由机器人按当前版本续办`,detail:`将使用企业资料 v${state.portal.profileVersion} 和授权版本 ${department.authorization.version}。`});
      }
    }
    return steps.sort((left,right)=>left.priority-right.priority||String(left.department).localeCompare(String(right.department)));
  }
}
