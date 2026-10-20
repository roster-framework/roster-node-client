const tokenVariable = 'ROSTER_CODEX_EXECUTION_MCP_TOKEN';
export const coreTools = Object.freeze(['roster_resource_connections', 'roster_invoke_resource', 'roster_resource_history', 'roster_list_resources', 'roster_get_resource', 'roster_publish_resource', 'roster_list_sessions', 'roster_get_session', 'roster_list_knowhow']);
export const collaborationTools = Object.freeze(['roster_agent_events', 'roster_call_agent', 'roster_get_delegated_result', 'roster_create_discussion', 'roster_read_discussion', 'roster_append_discussion', 'roster_list_discussions']);

// Only the invocation capability enters the child. Never inherit an admin or
// personal token, and never persist the token in config, arguments or prompt.
export function coreMcpConfiguration(capability, {agentCalls = false} = {}) {
  if (!capability) return {args: [], env: {}};
  const url = new URL(capability.url);
  if (url.username || url.password || url.hash || url.search || url.pathname !== '/mcp' ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)) ||
      typeof capability.token !== 'string' || capability.token.length < 32 || capability.token.length > 1024 || /[\r\n\0]/.test(capability.token)) throw Error('Invalid Core MCP execution capability');
  const enabledTools = agentCalls ? [...coreTools, ...collaborationTools] : coreTools;
  // These calls remain subject to Core's current execution authority. Avoid a
  // second client prompt in unattended runs; unknown tools are not approved.
  const approvals = enabledTools.flatMap(tool => ['-c', 'mcp_servers.roster.tools.'+tool+'.approval_mode="approve"']);
  return {env: {[tokenVariable]: capability.token}, args: [
    '-c', 'mcp_servers.roster.url='+JSON.stringify(url.href),
    '-c', 'mcp_servers.roster.bearer_token_env_var='+JSON.stringify(tokenVariable),
    '-c', 'mcp_servers.roster.enabled_tools='+JSON.stringify(enabledTools),
    ...approvals,
    '-c', 'mcp_servers.roster.required=true',
    '-c', 'shell_environment_policy.exclude='+JSON.stringify([tokenVariable])
  ]};
}
