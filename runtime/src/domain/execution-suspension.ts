// An agent requests a wait. Only Runtime can attest that execution has stopped.
export type SuspensionReceipt = import('@roster/contracts').ExecutionSuspensionSpec;
export type SuspensionCheckpoint = {
  version: 1; wait_id: string; execution_id: string; work_id: string;
  runtime_id: string; agent_id: string; state: Record<string, unknown>;
};

export class AgentSuspensionRequest extends Error {
  readonly state: Record<string, unknown>;
  constructor(readonly waitId: string, state: Record<string, unknown>) {
    super('Agent requested the registered reply wait');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(waitId) || !state || Array.isArray(state) || typeof state!=='object') throw new Error('Invalid suspension request');
    const raw=JSON.stringify(state);
    if (!raw || new TextEncoder().encode(raw).length>65536) throw new Error('Suspension checkpoint exceeds the limit');
    this.state=JSON.parse(raw);
  }
}
