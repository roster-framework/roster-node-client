import {record,id,ids,bytes} from './value.mjs';
export function validateParallel(definition) {
 record(definition,['mode','members'],'parallel definition');
 if(!['all','any'].includes(definition.mode)||!Array.isArray(definition.members)||definition.members.length<2||definition.members.length>8)throw Error('Invalid parallel definition');
 const seen=new Set();
 for(const member of definition.members) {
  record(member,['member_id','accept','instruction','timeout_seconds'],'parallel member');id(member.member_id,'parallel member',true);
  if(seen.has(member.member_id))throw Error('Duplicate parallel member');seen.add(member.member_id);
  ids(member.accept,'parallel accepted statuses',100);if(!member.accept.length)throw Error('Missing parallel accepted status');
  if(member.instruction!==undefined&&(typeof member.instruction!=='string'||bytes(member.instruction)>10000))throw Error('Invalid parallel instruction');
  if(member.timeout_seconds!==undefined&&(!Number.isInteger(member.timeout_seconds)||member.timeout_seconds<0||member.timeout_seconds>600))throw Error('Invalid parallel timeout');
 }
}
