import {createAgents as originals} from './session-agent.js';

// Same deterministic SDK behavior in a second, independently bound team member.
export function createAgents() {
  const first = originals()[0]!;
  return [first, {...first, spec: {...first.spec, id: 'session-guest', name: 'Strategy guest'}}];
}
