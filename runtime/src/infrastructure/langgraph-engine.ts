import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import {
  validateResult,
  type RunInput,
  type RunResult,
} from "@roster/contracts";
import type { AgentContext, AgentImplementation } from "../domain/agent.js";

// The graph controls one agent invocation. Organization routing belongs to core.
export async function executeAgent(
  agent: AgentImplementation,
  input: RunInput,
  context: AgentContext,
): Promise<RunResult> {
  const State = Annotation.Root({
    result: Annotation<RunResult | undefined>(),
  });
  const graph = new StateGraph(State)
    .addNode("invoke_agent", async () => {
      context.signal.throwIfAborted();
      context.log(`LangGraph · ${agent.spec.name} 시작`);
      return { result: await agent.execute(input, context) };
    })
    .addNode("validate_contract", (state) => {
      context.signal.throwIfAborted();
      return { result: validateResult(agent.spec, state.result) };
    })
    .addEdge(START, "invoke_agent")
    .addEdge("invoke_agent", "validate_contract")
    .addEdge("validate_contract", END)
    .compile();
  const state = await graph.invoke(
    {},
    { signal: context.signal, recursionLimit: 10 },
  );
  return state.result!;
}
