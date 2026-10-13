import type { RunInput, RunResult } from "@roster/contracts";
import type { AgentContext, AgentImplementation } from "../domain/agent.js";
import type { EnginePhase } from '../domain/engine-observation.js';
import type { AgentEngine } from "./ports.js";

// An engine may reject on abort before its agent node has actually stopped.
// Keep admission and the running receipt until every invoked node has settled.
export async function executeTrackedAgent(
  engine: AgentEngine, agent: AgentImplementation, input: RunInput, context: AgentContext,
  observe?: (phase: EnginePhase, durationMS: number) => void,
): Promise<RunResult> {
  const pending: Promise<RunResult>[] = [];
  let sealed = false;
  const tracked: AgentImplementation = {
    ...agent,
    execute(invocation, agentContext) {
      if (sealed) throw new Error("Agent invocation is no longer active");
      context.signal.throwIfAborted();
      const task = Promise.resolve().then(() => agent.execute(invocation, agentContext));
      void task.catch(() => {}); // Observe even engines that discard a node promise.
      pending.push(task);
      return task;
    },
  };
  const started=performance.now();
  observe?.('started',0);
  let returned=false;
  try {
    const result=await engine.execute(tracked, input, context);
    returned=true;
    return result;
  } finally {
    sealed = true;
    await Promise.allSettled(pending);
    observe?.(returned ? 'returned' : 'interrupted',Math.round(performance.now()-started));
  }
}
