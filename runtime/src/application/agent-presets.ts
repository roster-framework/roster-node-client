import {z} from 'zod';
import {Id,ManagedAgent} from '@roster/contracts';
import type {RegistryRepository} from './ports.js';
export const AgentPreset=z.object({id:Id,name:z.string().trim().min(1).max(100),agent:ManagedAgent}).strict();
export type AgentPresetConfig=z.infer<typeof AgentPreset>;
export async function saveAgentPreset(repository:RegistryRepository,input:unknown){
 const preset=AgentPreset.parse(input);
 preset.agent.version=0; // A template is not a bound agent revision.
 await repository.transact(r=>{
  const existing=r.agent_presets||[];
  if(existing.length>=100&&!existing.some(p=>p.id===preset.id))throw new Error('Agent preset limit reached');
  r.agent_presets=[...existing.filter(p=>p.id!==preset.id),structuredClone(preset)];
 });return preset;
}
