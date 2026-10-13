import {z} from 'zod';
const Id=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
export const ParallelMemberStep=z.object({member_id:Id,accept:z.array(Id).min(1).max(100),instruction:z.string().max(10000).optional(),timeout_seconds:z.number().int().min(0).max(600).optional()}).strict();
export const ParallelDefinition=z.object({mode:z.enum(['all','any']),members:z.array(ParallelMemberStep).min(2).max(8)}).strict();
export function validateParallelDefinition(value:unknown) {
 const result=ParallelDefinition.parse(value);
 if(new Set(result.members.map(m=>m.member_id)).size!==result.members.length||result.members.some(m=>new Set(m.accept).size!==m.accept.length))throw Error('Invalid parallel definition');return result;
}
export type ParallelDefinitionSpec=z.infer<typeof ParallelDefinition>;
export type ParallelAcceptance={branch:number;execution_id:string};
export type ParallelCheckpoint=({version:1;mode?:never}|{version:2;mode:'any'}) & {cursor:number;size:number;accepted:ParallelAcceptance[]};
export type ParallelAnyJoin={version:1;cursor:number;size:number;winner:ParallelAcceptance;retired:{branch:number;execution_id:string;started_at?:string}[]};
