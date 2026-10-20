import {createAgentTemplates as baseTemplates} from './agent.mjs';

// Separate author contract: existing codex-cli v2 instances retain their tools.
// Delegation is optional; neither a PM role nor an organization flow is imposed.
export function createAgentTemplates(options = {}) {
  return baseTemplates({...options, agentCalls:true}).map(template => ({
    ...template, id:'codex-cli-delegating', version:'1', name:'Codex CLI · Delegation',
    description:'Codex CLI with Core-authorized asynchronous task/conversation delegation. A receipt does not imply result completion.'
  }));
}
