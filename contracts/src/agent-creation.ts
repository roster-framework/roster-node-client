import {z} from 'zod';
import {Agent} from './index.js';

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
const CommandId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const JsonObject = z.record(z.string(), z.json()).superRefine((value, ctx) => {
  const visit = (item: unknown, depth: number): boolean => {
    if (depth > 32) return false;
    if (!item || typeof item !== 'object') return true;
    return Object.entries(item).every(([key, child]) => !['__proto__','constructor','prototype'].includes(key) && visit(child, depth + 1));
  };
  if (!visit(value, 0) || new TextEncoder().encode(JSON.stringify(value)).length > 100_000)
    ctx.addIssue({code:'custom', message:'Agent creation declaration or values exceed limits'});
});
export const AgentCreationSource = z.object({kind:z.enum(['template','preset']),id:Id,revision:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const AgentCreationDeclaration = AgentCreationSource.extend({
  name:z.string().trim().min(1).max(100), description:z.string().max(2000),
  parameter_schema:JsonObject, credential_parameters:z.array(Id).max(20),
}).superRefine((value, ctx) => {
  const schema=value.parameter_schema, properties=schema.properties;
  const declared=properties && !Array.isArray(properties) && typeof properties==='object' ? Object.keys(properties) : [];
  const required=schema.required ?? [];
  if(schema.type!=='object' || schema.additionalProperties!==false || !properties || Array.isArray(properties) || typeof properties!=='object' || declared.length>100 ||
    !Array.isArray(required) || required.some(key=>typeof key!=='string'||!declared.includes(key)) || new Set(required).size!==required.length ||
    new Set(value.credential_parameters).size!==value.credential_parameters.length || value.credential_parameters.some(key=>!declared.includes(key)))
    ctx.addIssue({code:'custom',message:'Invalid author parameter declaration'});
});
export const AgentCreationCatalogue = z.object({
  protocol:z.literal('roster-agent-catalogue/1'),runtime_id:Id,
  existing:z.array(z.lazy(()=>Agent)).max(1000),creatable:z.array(AgentCreationDeclaration).max(200),
}).strict();
export const AgentCreationRequest = z.object({
  protocol:z.literal('roster-agent-creation/1'),id:CommandId,source:AgentCreationSource,
  name:z.string().trim().min(1).max(100),parameters:JsonObject,
}).strict();
export const AgentCreationReceipt = z.object({
  protocol:z.literal('roster-agent-creation/1'),request_id:CommandId,source:AgentCreationSource,
  agent:z.lazy(()=>Agent),accepted_at:z.iso.datetime({offset:true}),replayed:z.boolean().optional(),
}).strict();
export type AgentCreationSourceSpec=z.infer<typeof AgentCreationSource>;
export type AgentCreationDeclarationSpec=z.infer<typeof AgentCreationDeclaration>;
export type AgentCreationCatalogueSpec=z.infer<typeof AgentCreationCatalogue>;
export type AgentCreationRequestSpec=z.infer<typeof AgentCreationRequest>;
export type AgentCreationReceiptSpec=z.infer<typeof AgentCreationReceipt>;

function declarationIsUnique(agent:z.infer<typeof Agent>) {
  if(new Set(agent.statuses).size!==agent.statuses.length || new Set(agent.events).size!==agent.events.length)
    throw Error('Duplicate agent status/event declaration');
}
export function validateAgentCreationCatalogue(value:unknown, runtimeId:string) {
  const catalogue=AgentCreationCatalogue.parse(value);
  if(catalogue.runtime_id!==runtimeId || new Set(catalogue.existing.map(a=>a.id)).size!==catalogue.existing.length ||
    new Set(catalogue.creatable.map(a=>a.kind+':'+a.id)).size!==catalogue.creatable.length)
    throw Error('Foreign or duplicate agent catalogue');
  catalogue.existing.forEach(declarationIsUnique);
  return catalogue;
}
export function validateAgentCreationReceipt(value:unknown, input:AgentCreationRequestSpec) {
  const request=AgentCreationRequest.parse(input),receipt=AgentCreationReceipt.parse(value);
  if(receipt.request_id!==request.id || receipt.agent.name!==request.name ||
    receipt.source.kind!==request.source.kind || receipt.source.id!==request.source.id || receipt.source.revision!==request.source.revision)
    throw Error('Foreign agent creation receipt');
  declarationIsUnique(receipt.agent);
  return receipt;
}
