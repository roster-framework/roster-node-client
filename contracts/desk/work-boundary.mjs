import {record,version,id,equal,bytes} from './value.mjs';

export async function deskWorkMode(api) {
  const value=await api('/core/work-creation-capabilities');
  record(value,['version','mode'],'Work capability');
  if(value.version!==1||!['local','independent'].includes(value.mode))throw Error('Work capability unavailable');
  return value.mode;
}
const revision=v=>{version(v,'Work');if(v>=Number.MAX_SAFE_INTEGER)throw Error('Invalid Work revision');return v;};
function page(value,owner,mode,expected) {
  if(!value||value.owner?.id!==owner||value.workspace?.id!==owner||value.placement_space?.workspace_id!==owner||value.can_edit!==true||!Array.isArray(value.flows))throw Error('Invalid current workspace');
  if(mode==='independent') {
    revision(value.work_revision);
    if(expected!==undefined&&value.work_revision!==expected)throw Error('Work revision conflict; export current Desk first');
    if(!Array.isArray(value.works)||value.flows.length+value.works.length>20)throw Error('Invalid workspace page');
  }else if(value.work_revision!==undefined||value.next_cursor!==undefined)throw Error('Work mode changed');
  for(const f of value.flows){record(f,['id','name','version','default'],'flow summary');id(f.id,'flow');version(f.version,'flow');if(typeof f.name!=='string'||typeof f.default!=='boolean')throw Error('Invalid flow summary');}
  if(value.next_cursor!==undefined&&(!/^wqc1\.[A-Za-z0-9_-]{1,1019}$/.test(value.next_cursor)||mode!=='independent'))throw Error('Invalid workspace continuation');
  return value;
}
// Mixed overview keys sort flows before work. Do not scan an entire work ledger.
export async function deskWorkspaceOverview(api,owner,mode,expected) {
  id(owner,'workspace owner');const first=page(await api('/workspaces/'+owner),owner,mode,expected);
  if(mode==='local')return first;
  let selected=first;const flows=[...first.flows],seen=new Set();
  while(selected.next_cursor&&!selected.works.length){
    const token=selected.next_cursor;if(seen.has(token)||seen.size>=128)throw Error('Workspace overview scan limit');seen.add(token);
    selected=page(await api('/workspaces/'+owner+'?limit=20&cursor='+token),owner,mode,first.work_revision);
    if(selected.next_cursor&&seen.has(selected.next_cursor))throw Error('Workspace overview continuation cycle');
    if(!equal(first.workspace,selected.workspace)||!equal(first.placement_space,selected.placement_space))throw Error('Workspace changed during read');
    flows.push(...selected.flows);if(flows.length>64)throw Error('Workspace has more than 64 Desk flows');
  }
  if(flows.length>64||new Set(flows.map(f=>f.id)).size!==flows.length)throw Error('Invalid workspace flows');
  return {...first,flows};
}
export function pinnedDeskRevision(desk,mode,view) {
  if(mode==='local'){if(desk.work_revision!==undefined)throw Error('Independent Desk requires independent Work');return;}
  if(desk.flows?.length||desk.events||desk.work_revision!==undefined) {
    revision(desk.work_revision);
    if(view&&view.work_revision!==desk.work_revision)throw Error('Work revision conflict; export current Desk first');
  }
}
export async function deskFlowDefinition(api,owner,unit,summary,mode,expected) {
  const response=await api(mode==='independent'?'/core/workflows/'+summary.id:'/workspaces/'+owner+'/flows/'+summary.id);
  let flow=response;
  if(mode==='independent') {record(response,['version','work_revision','flow'],'workflow definition');if(response.version!==1||revision(response.work_revision)!==expected)throw Error('Work changed during definition read');flow=response.flow;}
  if(!flow||flow.id!==summary.id||flow.version!==summary.version||flow.workspace_id!==owner||flow.unit_id!==unit||!Array.isArray(flow.steps))throw Error('Workspace flow source changed');
  record(flow,['id','name','unit_id','workspace_id','version','default','steps'],'workflow');return flow;
}
export function deskWorkCommandID() {
  if(!globalThis.crypto?.randomUUID)throw Error('Work command identity unavailable');
  return 'desk-'+globalThis.crypto.randomUUID();
}
export function deskWorkSize(value) {
  if(bytes(JSON.stringify(value))>60*1024)throw Error('Desk Work definition exceeds command limit');
}
export async function deskWorkWrite(api,command,event=false) {
  if(bytes(JSON.stringify(command))>64*1024)throw Error('Desk Work command exceeds limit');
  const frozen=structuredClone(command),receipt=await api(event?'/core/event-flow-change':'/core/workflow-change','POST',structuredClone(frozen));
  record(receipt,event?['version','command_id','unit_id','workspace_id','workspace_version','work_revision','accepted_at','replayed']:
    ['version','command_id','flow_id','unit_id','workspace_id','flow_version','work_revision','accepted_at','replayed'],'Work receipt');
  const target=event?frozen:frozen.flow;
  if(receipt.version!==1||receipt.command_id!==frozen.id||receipt.unit_id!==target.unit_id||receipt.workspace_id!==target.workspace_id||
     receipt.work_revision!==frozen.expected_revision+1||typeof receipt.accepted_at!=='string'||!Number.isFinite(Date.parse(receipt.accepted_at))||typeof receipt.replayed!=='boolean'||
     (event?receipt.workspace_version!==frozen.expected_workspace_version+1:receipt.flow_id!==target.id||receipt.flow_version!==target.version+1))throw Error('Unconfirmed Desk Work receipt');
  revision(receipt.work_revision);return receipt;
}
