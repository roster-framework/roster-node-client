import { DynamicStructuredTool } from "@langchain/core/tools";
import type { ToolApprovalPolicySpec } from "@roster/contracts";
import type { AgentContext } from "../domain/agent.js";
export function approvalTools(
  tools: DynamicStructuredTool[],
  policy: ToolApprovalPolicySpec | undefined,
  context: AgentContext,
  serverId = "",
  revision?: string,
) {
  return tools.map((original) => {
    const key = serverId ? serverId + "/" + original.name : original.name;
    const required =
      policy?.mode === "all" ||
      (policy?.mode === "selected" && policy.tools.includes(key));
    if (!required && !serverId) return original;
    return new DynamicStructuredTool({
      name: serverId ? serverId + "__" + original.name : original.name,
      description: original.description,
      schema: original.schema,
      responseFormat: original.responseFormat,
      func: async (args, _manager, config) => {
        context.signal.throwIfAborted();
        if (required && !context.approveTool)
          throw new Error("Tool approval service unavailable");
        const checkAccess = async () => {
          if (!serverId) return;
          if (context.toolAccessFailure) throw context.toolAccessFailure;
          try {
            if(serverId === "roster-core") {await context.authorizeCoreConnection?.();return;}
            if (!context.authorizeMcpTool) throw new Error("Core MCP access check unavailable");
            await context.authorizeMcpTool(serverId, original.name, revision);
          } catch (error) {
            context.toolAccessFailure = error instanceof Error ? error : new Error(String(error));
            throw context.toolAccessFailure;
          }
        };
        const snapshot = JSON.parse(JSON.stringify(args));
        if (required) {
          await checkAccess();
          await context.approveTool!(key, snapshot);
        }
        context.signal.throwIfAborted();
        await checkAccess();
        context.signal.throwIfAborted();
        if (serverId === "roster-core" && original.name === "roster_invoke_resource" && context.invokeResource) {
          try {
            const result = await context.invokeResource(snapshot);
            return original.responseFormat === "content_and_artifact" ? [JSON.stringify(result), result] : JSON.stringify(result);
          } catch (error) {
            context.toolAccessFailure = error instanceof Error ? error : new Error(String(error));
            throw context.toolAccessFailure;
          }
        }
        const result=await original.func(snapshot, _manager, config);
        if(serverId) await checkAccess();
        return result;
      },
    });
  });
}
