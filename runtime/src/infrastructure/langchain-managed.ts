import { coreInstructionPrompt } from "./core-instructions.js";
import { managedSkillsPrompt } from "./managed-skills.js";
import { approvalTools } from "./approval-tools.js";
import {pinnedCoreMcp} from "./pinned-core-mcp.js";
import { managedOutput, delegationPrompt } from "./delegation.js";
import { createManagedModel } from "./model-factory.js";
export { managedModel } from "./model-factory.js";
import { LocalPythonAgentWorker } from "./python-agent-worker.js";
import type { PythonAgentWorker } from "../domain/model-execution.js";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { publishedModelText } from "../domain/model-output.js";
import {modelUsageCallbacks} from "./langchain-model-usage.js";
import {modelInputSizes} from "../domain/model-input-size.js";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { z } from "zod";
import {
  Result,
  ManagedAgent,
  type ManagedAgentConfig,
  type McpConfig,
} from "@roster/contracts";
import type { AgentImplementation } from "../domain/agent.js";
import { managedParameterSchema, managedParameters } from './managed-parameters.js';

const pythonWorker = new LocalPythonAgentWorker();
export async function validateManagedConfiguration(config: ManagedAgentConfig) {
  if (config.kind === "echo") return;
  if (!config.model) throw new Error("Model ID required");
  if (config.engine && config.engine !== "langgraph-node")
    return pythonWorker.validate(config);
  await createManagedModel(config, "roster-constructor-validation");
}

export function mcpSettings(config: McpConfig, resolved?:{credential?:string}) {
  const token = resolved ? resolved.credential : config.token_env ? process.env[config.token_env] : undefined;
  if (config.token_env && !token)
    throw new Error(`환경변수 ${config.token_env}가 설정되지 않았습니다.`);
  const url = new URL(config.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("MCP에는 HTTP(S) URL만 사용할 수 있습니다.");
  return {
    transport: "http" as const,
    url: config.url,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  };
}
export async function inspectMcp(config: McpConfig) {
  const client = new MultiServerMCPClient({ [config.id]: mcpSettings(config) });
  try {
    return (await client.getTools()).map((t) => t.name);
  } finally {
    await client.close();
  }
}
export function managedImplementation(
  config: ManagedAgentConfig,
  connections: McpConfig[],
  worker: PythonAgentWorker = pythonWorker,
  credential: (reference: string) => string | undefined = (reference) => process.env[reference],
): AgentImplementation {
  config = ManagedAgent.parse(config);
  return {
    parameter_schema: managedParameterSchema,
    parameters: managedParameters(config),
    spec: {
      id: config.id,
      name: config.name,
      description: config.description,
      statuses: config.statuses,
      events: config.events,
      skills: config.skills,
      rules: config.rules,
      capabilities: [],
    },
    async execute(input, context) {
      if (config.kind === "echo") {
        context.log(
          "연결 검사용 에이전트: 입력을 그대로 반환합니다. LLM 호출은 없습니다.",
        );
        return Result.parse({
          status: config.statuses[0],
          summary: input.context.request,
          output: { received: input.input },
          metrics: { cost_usd: 0 },
        });
      }
      const apiKey = credential(config.credential_env);
      if ((config.credential_env && !apiKey) || !config.model)
        throw new Error(
          `LLM 설정 필요: ${config.credential_env}와 model을 확인하세요.`,
        );
      const isDelegation = input.input.delegation !== undefined;
      const skillPrompt = isDelegation
        ? ""
        : await managedSkillsPrompt(config.skills);
      const selected = (isDelegation ? [] : config.mcp_ids).map((id) => {
        const c = connections.find((c) => c.id === id);
        if (!c) throw new Error(`MCP 연결 없음: ${id}`);
        return c;
      });
      if (context.coreMcp && selected.some((c) => c.id === "roster-core"))
        throw new Error(
          "roster-core MCP ID is reserved during core executions",
        );
      const coreMcp = context.coreMcp
        ? {
            id: "roster-core",
            ...context.coreMcp,
          }
        : undefined;
      if (coreMcp) {
        await context.authorizeCoreConnection?.();
        const url = new URL(coreMcp.url);
        if (
          url.pathname !== "/mcp" ||
          url.username || url.password ||
          url.search ||
          url.hash ||
          !(
            url.protocol === "https:" ||
            (url.protocol === "http:" &&
              ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
          )
        )
          throw new Error("Invalid core MCP URL");
      }
      const configured: {id:string;revision?:string;settings:ReturnType<typeof mcpSettings>}[] = await Promise.all(selected.map(async c => {
        const bound=await context.bindMcpConnection?.(c);
        return {id:c.id,revision:bound?.revision,settings:bound?mcpSettings(bound.configuration,bound):mcpSettings(c)};
      }));
      if (coreMcp)
        configured.push({
          id: coreMcp.id,
          settings: {
            transport: "http" as const,
            url: coreMcp.url,
            headers: { Authorization: `Bearer ${coreMcp.token}` },
          },
        });
      const external = configured.filter(c=>c.id!=="roster-core");
      const mcp = external.length
        ? new MultiServerMCPClient(
            Object.fromEntries(external.map((c) => [c.id, c.settings])),
          )
        : undefined;
      let coreConnection: Awaited<ReturnType<typeof pinnedCoreMcp>> | undefined;
      try {
        if(coreMcp) coreConnection=await pinnedCoreMcp(coreMcp,context);
        const getTools=(id:string)=>id==="roster-core"?coreConnection!.getTools():mcp!.getTools(id);
        const tools = (
          await Promise.all(
            configured.map(async (c) => {
              if(c.id === "roster-core") await context.authorizeCoreConnection?.();
              let available = await getTools(c.id);
              if (c.id !== "roster-core" && context.visibleMcpTools) {
                const visible = new Set(await context.visibleMcpTools(c.id,available.map(t=>t.name),c.revision));
                available = available.filter(t=>visible.has(t.name));
              }
              return approvalTools(
                available,
                config.tool_approval,
                context,
                c.id,
                c.revision,
              );
            }),
          )
        ).flat();
        if (!isDelegation && config.tool_approval?.mode === "selected") {
          const available = new Set(
            (
              await Promise.all(
                configured.map(async (c) =>
                  (await getTools(c.id)).map(
                    (tool) => c.id + "/" + tool.name,
                  ),
                ),
              )
            ).flat(),
          );
          if (config.tool_approval.tools.some((key) => !available.has(key)))
            throw new Error(
              "승인 대상 도구가 변경되었습니다. 에이전트 승인 설정을 확인하세요.",
            );
        }
        context.log(`허용된 MCP 도구 ${tools.length}개 연결`);
        const prompt = `${isDelegation ? delegationPrompt : ""}\n${config.instructions}${coreInstructionPrompt(input)}\n조직 규칙:\n${input.context.culture}\n에이전트 규칙:\n${config.rules.join("\n")}${skillPrompt}`;
        const request = {
          request: input.context.request,
          input: input.input,
          history: input.context.history,
          knowledge: input.context.knowledge,
          resources: context.resources ?? [],
        };
        context.recordSession?.({
          kind:"note",
          text:"Model input bytes: "+JSON.stringify({
            version:1,engine:config.engine??"langgraph-node",provider:config.provider,model:config.model,
            components:modelInputSizes({
              runtime_instructions:config.instructions,runtime_rules:config.rules,
              skills:skillPrompt,core_instructions:coreInstructionPrompt(input),culture:input.context.culture,
              request:request.request,input:request.input,history:request.history,
              knowledge:request.knowledge,resources:request.resources,
              tool_schemas:tools.map(t=>({name:t.name,description:t.description,schema:toJsonSchema(t.schema)})),
            }),
          }),
        });
        if (config.engine && config.engine !== "langgraph-node") {
          const structured = await worker.execute(
            {
              config,
              prompt,
              request,
              workspace: context.workspace,
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description,
                schema: toJsonSchema(t.schema) as Record<string, unknown>,
              })),
            },
            context.signal,
            context.log,
            async (name, args) => {
              const tool = tools.find((t) => t.name === name);
              if (!tool) throw new Error("Unknown worker tool");
              return tool.invoke(args, { signal: context.signal });
            },
            context.suspendForReply,
            context.recordModelUsage,
          );
          if (context.toolAccessFailure) throw context.toolAccessFailure;
          return Result.parse({
            status: structured.status,
            summary: structured.summary,
            output: managedOutput(structured.output, input.input.delegation),
            events: structured.event
              ? [{ type: structured.event, data: { text: structured.output } }]
              : [],
          });
        }
        const model = await createManagedModel(config, apiKey);
        const schema = {
          type: "object",
          properties: {
            status: { type: "string", enum: config.statuses },
            summary: { type: "string" },
            output: { type: "string" },
            event: { type: "string", enum: ["", ...config.events] },
          },
          required: ["status", "summary", "output", "event"],
          additionalProperties: false,
        };
        const graph = createReactAgent({
          llm: model,
          tools,
          prompt,
          // LangGraph's final structured-output call is separate from the loop.
          // Carry Runtime and Core instructions through that call as well.
          responseFormat: { prompt, schema },
        });
        let response: unknown;
        const usage=modelUsageCallbacks(config.provider,config.model,record=>{
          if(context.recordModelUsage) context.recordModelUsage(record);
          else context.recordSession?.({kind:"note",text:"Model usage: "+JSON.stringify(record)});
        });
        for await (const state of await graph.stream(
          {
            messages: [
              {
                role: "user",
                content: JSON.stringify({
                  request: input.context.request,
                  input: input.input,
                  history: input.context.history,
                  knowledge: input.context.knowledge,
                  resources: context.resources ?? [],
                }),
              },
            ],
          },
          { streamMode: "values", signal: context.signal, recursionLimit: 30, callbacks:[usage] },
        )) {
          response = state.structuredResponse;
          const message = state.messages?.at(-1);
          if (message?.content && message.getType?.() === "ai") {
            const text = publishedModelText(message.content);
            if (text) context.log(text);
          }
        }
        if (context.toolAccessFailure) throw context.toolAccessFailure;
        const structured = z
          .object({
            status: z.string(),
            summary: z.string(),
            output: z.string(),
            event: z.string(),
          })
          .parse(response);
        return Result.parse({
          status: structured.status,
          summary: structured.summary,
          output: managedOutput(structured.output, input.input.delegation),
          events: structured.event
            ? [{ type: structured.event, data: { text: structured.output } }]
            : [],
        });
      } finally {
        try {await coreConnection?.close();} finally {await mcp?.close();}
      }
    },
  };
}
