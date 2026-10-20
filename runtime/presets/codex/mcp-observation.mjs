import {coreTools, collaborationTools} from './core-mcp.mjs';

// Record only known Core tool names and transport outcomes, never arguments,
// responses, provider endpoints or hidden reasoning. This is observation, not
// proof that the requested business operation succeeded.
const knownTools = new Set([...coreTools, ...collaborationTools]);
export function coreToolObservation(event, seen) {
  const item = event?.item;
  if (event?.type !== 'item.completed' || item?.type !== 'mcp_tool_call' || item.server !== 'roster' || !knownTools.has(item.tool) || typeof item.id !== 'string' || !item.id || item.id.length > 200 || seen.has(item.id)) return;
  if (!['completed', 'failed'].includes(item.status)) return;
  seen.add(item.id);
  return `Core MCP tool ${item.status === 'completed' && !item.error ? 'completed' : 'failed'}: ${item.tool}`;
}
