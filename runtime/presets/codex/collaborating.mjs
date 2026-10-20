import {createAgentTemplates as baseTemplates} from './agent.mjs';

export function createAgentTemplates(options = {}) {
  return baseTemplates({...options, agentCalls:true, continuations:true}).map(template => ({
    ...template, id:'codex-cli-collaborating', version:'2', name:'Codex CLI · Collaboration',
    description:'Core-authorized delegation and shared questions with durable reply or child-completion waiting and checkpoint resumption.'
  }));
}
