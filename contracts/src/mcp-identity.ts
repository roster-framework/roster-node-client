import {z} from 'zod';
import {McpConnection} from './mcp-config.js';
const id=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
export const McpRevision=z.string().uuid();
export const McpToolName=z.string().min(1).max(128).regex(/^[^\s\x00-\x1f\x7f*?]+$/);
const tools=z.array(McpToolName).max(256).refine(v=>new Set(v).size===v.length,'Duplicate MCP tools');
export const McpToolUse=z.object({runtime_id:id,connection_id:id,revision:McpRevision,tool_name:McpToolName}).strict();
// Both request candidates and response selection use this exact tuple. A
// response may only remove names; it never introduces a different identity.
export const McpToolSelection=z.object({protocol:z.literal('roster-mcp-tool-selection/1'),runtime_id:id,connection_id:id,revision:McpRevision,tools}).strict();
export type McpToolSelectionSpec=z.infer<typeof McpToolSelection>;
export const McpDescriptor=z.object({connection_id:id,revision:McpRevision,state:z.enum(['active','removed']),tools}).strict().refine(v=>v.state==='active'||v.tools.length===0,'Removed connection has tools');
export const McpCatalogue=z.object({protocol:z.literal('roster-mcp-catalogue/1'),runtime_id:id,connections:z.array(McpDescriptor).max(1024)}).strict().refine(v=>new Set(v.connections.map(c=>c.connection_id)).size===v.connections.length,'Duplicate MCP connection');
const change={protocol:z.literal('roster-mcp-change/1'),request_id:id,connection_id:id,expected_revision:McpRevision.nullable()};
export const McpConnectionChange=z.discriminatedUnion('action',[
 z.object({...change,action:z.literal('upsert'),configuration:McpConnection}).strict(),
 z.object({...change,action:z.literal('remove')}).strict(),
]).refine(v=>v.action!=='upsert'||v.connection_id===v.configuration.id,'MCP identity mismatch');
export const McpChangeReceipt=z.object({protocol:z.literal('roster-mcp-change-receipt/1'),request_id:id,connection_id:id,action:z.enum(['upsert','remove']),revision:McpRevision,state:z.enum(['active','removed']),replayed:z.literal(true).optional()}).strict().refine(v=>(v.action==='upsert')===(v.state==='active'),'MCP receipt state mismatch');
export type McpDescriptorSpec=z.infer<typeof McpDescriptor>;
export type McpConnectionChangeSpec=z.infer<typeof McpConnectionChange>;
export type McpChangeReceiptSpec=z.infer<typeof McpChangeReceipt>;
