import type { AgentImplementation } from "../../src/agent.js";

// Deterministic scheduling probe; no provider call or external side effect.
export function createAgents(): AgentImplementation[] {
  const attempts = new Map<string, number>();
  return ["cooperative", "stubborn"].map(id => ({
    spec: { id, name: id, description: "Step deadline fixture", statuses: ["ok"], events: [], skills: [], rules: [], capabilities: [] },
    async execute(input, context) {
      const key = id + ":" + input.work_id, attempt = (attempts.get(key) || 0) + 1;
      attempts.set(key, attempt);
      context.log("Attempt " + attempt);
      if (attempt === 1) {
        if (id === "stubborn") await new Promise(r => setTimeout(r, 4000));
        else await new Promise<void>((_resolve, reject) => {
          const stop = () => reject(context.signal.reason);
          if (context.signal.aborted) stop();
          else context.signal.addEventListener("abort", stop, { once: true });
        });
      }
      return { status: "ok", summary: "Completed attempt " + attempt, output: { attempt }, events: [], artifacts: [], metrics: {} };
    },
  }));
}
