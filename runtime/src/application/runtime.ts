import {engineObservation} from '../domain/engine-observation.js';
import type { RunInput } from "@roster/contracts";
import type { ModelCredentials } from '../domain/credentials.js';
import type { ResourceAccessSpec } from "../domain/resource.js";
import { executeTrackedAgent } from "./agent-execution.js";
type ResourceRunInput = RunInput & {context: RunInput["context"] & {resources?: ResourceAccessSpec[]}};
import { invokeCoreResource } from "../infrastructure/core-resource-access.js";
import type { ToolApprovals } from "./tool-approvals.js";
import { randomUUID, createHash } from "node:crypto";
import { AgentSuspensionRequest, type SuspensionCheckpoint, type SuspensionReceipt } from '../domain/execution-suspension.js';
import {SUSPENSION_NOTE, type SuspensionJournalCommit} from '../domain/suspension-journal.js';
import type { RuntimeFrame, SessionNote } from "../domain/session.js";
import type { SessionJournal } from "./session-journal.js";
import { SessionPublication } from "./session-publication.js";
import type { SessionRecord } from "../domain/session-delivery.js";
import {modelUsageRecord, type ModelUsage} from "../domain/model-usage.js";
import {localToolAllowed, localResourceSelection, localMcpToolSelection, validLocalToolPolicy, type LocalToolPolicySource, type LocalToolRequest} from "../domain/local-tool-policy.js";
import {ToolAccessRefusal} from "../domain/tool-access-refusal.js";
import {coreOriginTrusted, validCoreTrustPolicy, type CoreTrustSource} from "../domain/core-trust.js";
import type {CoreExecutionAuthority} from "../domain/core-execution-authority.js";
import type {McpConnections} from './mcp-connections.js';
import {McpClientBindingDenied} from './mcp-connections.js';
import {
  PROTOCOL,
  validateManifest,
  type ManagedAgentConfig,
  type McpConfig,
} from "@roster/contracts";
import type { AgentImplementation } from "../domain/agent.js";
import { snapshotAgentParameters, type AgentParameterValidator } from '../domain/agent-parameters.js';
import { snapshotAgentInvocation } from '../domain/agent-invocation.js';
import {loadExecutionContinuation} from './execution-continuation.js';
import type {RuntimeAgentCreation} from './agent-creation.js';
import {AgentCreationUnavailable} from './agent-creation.js';
import { authorizeCoreMcpTool, selectCoreMcpTools } from "../infrastructure/core-mcp-access.js";
import type {
  AgentEngine,
  ExecutionRepository,
  RegistryRepository,
  WorkspaceProvider,
  ManagedAgentFactory,
  McpInspector,
} from "./ports.js";
export class AdmissionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string,
    readonly scope: "runtime" | "agent" = "runtime") { super(message); }
}
export class AgentVersionConflict extends Error {
  constructor() { super("에이전트 설정이 바뀌었습니다. 새 설정을 읽고 다시 저장하세요."); }
}
export type RuntimeLimits = { maxConcurrent: number; maxPerAgent: number };
export class RosterRuntime {
  private active = new Map<string, AbortController>();
  // Count admission in progress too: repository/factory awaits must not oversubscribe.
  private slots = new Map<string, string>();
  private closing = false;
  private journalClosed = false;
  capacity() {
    return { active: this.slots.size, max_concurrent: this.limits.maxConcurrent,
      max_per_agent: this.limits.maxPerAgent, accepting: !this.closing };
  }
  constructor(
    readonly id: string,
    private registered: AgentImplementation[],
    readonly registry: RegistryRepository,
    readonly executions: ExecutionRepository,
    readonly workspaces: WorkspaceProvider,
    readonly engine: AgentEngine,
    readonly factory: ManagedAgentFactory,
    readonly mcp: McpInspector,
    readonly limits: RuntimeLimits = { maxConcurrent: 4, maxPerAgent: 1 },
    readonly approvals?: ToolApprovals,
    readonly journal?: SessionJournal,
    readonly credentials?: ModelCredentials,
    private readonly parameterValidator?: AgentParameterValidator,
    readonly creations?: RuntimeAgentCreation,
    private readonly localToolPolicy?: LocalToolPolicySource,
    private readonly coreTrust?: CoreTrustSource,
    private readonly coreAuthority?: CoreExecutionAuthority,
    readonly mcpConnections?: McpConnections,
  ) {
    for (const value of [limits.maxConcurrent, limits.maxPerAgent])
      if (!Number.isSafeInteger(value) || value < 1 || value > 1024)
        throw new Error("런타임 동시 실행 한도는 1~1024 정수여야 합니다.");
    this.limits = Object.freeze({ ...limits });
  }
  async initialize() {
    await this.mcpConnections?.initialize();
    this.registered = this.registered.map(agent => {
      if (agent.parameter_schema && !this.parameterValidator)
        throw new Error('Agent parameter validator required for declared parameters');
      return {...agent,
        parameter_schema: agent.parameter_schema ? snapshotAgentParameters(agent.parameter_schema) : undefined,
        parameters: agent.parameter_schema
          ? this.parameterValidator!.resolve(agent.parameter_schema, agent.parameters ?? {})
          : snapshotAgentParameters(agent.parameters ?? {}),
      };
    });
    await this.executions.recover();
    if(this.executions.suspensionJournals) {
      for await(const commit of this.executions.suspensionJournals()) {
        if(!this.journal?.commitSuspension)throw new Error('Suspension journal recovery unavailable');
        if(commit.receipt.runtime_id!==this.id)throw new Error('Foreign suspension Runtime');
        this.journal.commitSuspension(commit);
      }
    }
    this.journal?.recover();
    await this.registry.publish(await this.manifest());
  }
  private async agents() {
    const r = await this.registry.read();
    return [
      ...this.registered,
      ...(this.creations ? await this.creations.agents(r) : []),
      ...r.managed_agents.map((c) =>
        this.factory.create(
          c,
          r.mcp_connections.map((m) => m.config),
        ),
      ),
    ];
  }
  async manifest() {
    const r = await this.registry.read();
    const manifest = validateManifest({
      protocol: PROTOCOL,
      runtime_id: this.id,
      name: r.name,
      engine: "roster/node-python",
      isolation: "trusted-local-process",
      management: true,
      ...(this.executions.readSuspensionCheckpoint && this.coreAuthority?.bindsRequest===true ? {execution_continuation:'roster-execution-continuation/2'} : {}),
      agents: (await this.agents()).map((a) => a.spec),
    });
    return {...manifest,session_delivery:Boolean(this.journal)};
  }
  async parameterDeclarations() {
    return {
      protocol: 'roster-agent-parameters/1',
      agents: (await this.agents()).map(agent => ({agent_id: agent.spec.id,
        ...(agent.parameter_schema ? {parameter_schema: structuredClone(agent.parameter_schema)} : {}),
      })),
    };
  }
  async creationCatalogue() {
    if(!this.creations)throw new Error('Agent creation catalogue unavailable');
    return this.creations.catalogue((await this.agents()).map(a=>a.spec));
  }
  async createAgent(input:unknown) {
    if(!this.creations)throw new Error('Agent creation unavailable');
    const receipt=await this.creations.create(input,this.registered.map(a=>a.spec.id));
    try{await this.registry.publish(await this.manifest());}catch{throw new AgentCreationUnavailable();}
    return receipt;
  }
  async rename(name: string) {
    await this.registry.transact((r) => {
      r.name = name;
    });
    await this.registry.publish(await this.manifest());
  }
  async validateAgent(config: ManagedAgentConfig) {
    await this.factory.validate?.(config);
  }
  async upsertAgent(config: ManagedAgentConfig, preserveContract = false) {
    if (this.registered.some((a) => a.spec.id === config.id) ||
        (await this.registry.read()).agent_creations?.instances.some(a=>a.agent.id===config.id))
      throw new Error("외부 코드 에이전트는 해당 구성 저장소에서 수정하세요.");
    await this.validateAgent(config);
    await this.registry.transact((r) => {
      const previous = r.managed_agents.find((agent) => agent.id === config.id);
      if (preserveContract && (!previous || previous.kind !== config.kind ||
          JSON.stringify(previous.statuses) !== JSON.stringify(config.statuses) ||
          JSON.stringify(previous.events) !== JSON.stringify(config.events)))
        throw new AgentVersionConflict();
      if (config.version !== (previous?.version ?? 0))
        throw new AgentVersionConflict();
      if (
        config.mcp_ids.some(
          (id) => !r.mcp_connections.some((c) => c.config.id === id),
        )
      )
        throw new Error("등록되지 않은 MCP 연결");
      if(config.tool_approval?.mode === "selected") {
        const available = new Set(r.mcp_connections.filter(c=>config.mcp_ids.includes(c.config.id)).flatMap(c=>c.tools.map(tool=>c.config.id+"/"+tool)));
        if(config.tool_approval.tools.some(key=>!available.has(key))) throw new Error("승인 대상 MCP 도구를 확인하세요.");
      }
      r.managed_agents = r.managed_agents
        .filter((a) => a.id !== config.id)
        .concat({ ...config, version: config.version + 1 });
    });
    await this.registry.publish(await this.manifest());
  }
  async upsertMcp(config: McpConfig) {
    if(this.mcpConnections)return this.mcpConnections.legacyUpsert(config);
    const tools = await this.mcp.inspect(config);
    await this.registry.transact((r) => {
      r.mcp_connections = r.mcp_connections
        .filter((c) => c.config.id !== config.id)
        .concat({ config, tools, checked: new Date().toISOString() });
    });
    return tools;
  }
  async removeMcp(id: string) {
    if(this.mcpConnections)return this.mcpConnections.legacyRemove(id);
    await this.registry.transact((r) => {
      if (r.managed_agents.some((a) => a.mcp_ids.includes(id)))
        throw new Error("에이전트에서 연결을 먼저 해제하세요.");
      r.mcp_connections = r.mcp_connections.filter((c) => c.config.id !== id);
    });
  }
  cancel(id: string) {
    const controller = this.active.get(id);
    controller?.abort(new Error("운영자가 중단을 요청했습니다."));
    return Boolean(controller);
  }
  async run(input: ResourceRunInput, emit: (frame: RuntimeFrame) => void, accepted: () => void = () => {}, coreMcp?: {url: string; token: string}, sessionStream = false, consumer?: string, requestSha256?:string) {
    input = snapshotAgentInvocation(input);
    coreMcp = coreMcp ? Object.freeze({...coreMcp}) : undefined;
    if (consumer && !this.journal) throw new AdmissionError(503,"journal_unavailable","Session journal unavailable");
    if (this.closing) throw new AdmissionError(503, "runtime_draining", "런타임 종료 중입니다.");
    if (this.slots.has(input.execution_id))
      throw new AdmissionError(409, "execution_exists", "실행 ID가 이미 존재합니다.");
    if (this.slots.size >= this.limits.maxConcurrent)
      throw new AdmissionError(429, "runtime_busy", "런타임 실행 한도에 도달했습니다.");
    if ([...this.slots.values()].filter(id => id === input.agent_id).length >= this.limits.maxPerAgent)
      throw new AdmissionError(429, "runtime_busy", "에이전트 실행 한도에 도달했습니다.", "agent");
    this.slots.set(input.execution_id, input.agent_id);
    try {
    const agent = (await this.agents()).find(
      (a) => a.spec.id === input.agent_id,
    );
    if (!agent) throw new Error("에이전트 없음");
    if (!(await this.executions.reserve(input.execution_id)))
      throw new AdmissionError(409, "execution_exists", "실행 ID가 이미 존재합니다. 상태를 조회하세요.");
    if (consumer) {
      try { this.journal!.begin({execution_id:input.execution_id,work_id:input.work_id,agent_id:input.agent_id,consumer_id:consumer}); }
      catch(error) { await this.executions.save({id:input.execution_id,state:"attention",observation:"Session journal admission failed"}); throw error; }
    }
    const controller = new AbortController();
    this.active.set(input.execution_id, controller);
    if (this.closing) controller.abort(new Error("런타임 종료"));
    const timer = setTimeout(
      () => controller.abort(new Error("실행 제한 시간 10분 초과")),
      600000,
    );
    const start = performance.now();
    let suspensionRequest: AgentSuspensionRequest | undefined;
    let suspensionReceipt: SuspensionReceipt | undefined;
    let logging = true;
    const persist = (kind: SessionRecord["kind"], text: string): SessionRecord => {
      const entry: SessionRecord={id:randomUUID(),kind,text,at:new Date().toISOString()};
      if (consumer) {
        try { this.journal!.append(input.execution_id,entry); }
        catch(error) { controller.abort(error); throw error; }
      }
      return entry;
    };
    const terminalText = (text: string) => {
      const bytes=Buffer.from(text.trim() ? text : "No terminal detail"); let end=Math.min(bytes.length,20000);
      while(end<bytes.length && (bytes[end]! & 0xc0)===0x80) end--;
      return bytes.subarray(0,end).toString("utf8");
    };
    // Delivery failures must never overwrite an already persisted receipt.
    const deliver = (frame: RuntimeFrame) => {
      try {
        emit(frame);
      } catch {
        /* The receipt remains available for recovery. */
      }
    };
    const publication=new SessionPublication<RuntimeFrame>(consumer ? this.journal : undefined,input.execution_id,deliver,error=>controller.abort(error));
    const recordSession = (entry: SessionNote) => {
      if (!logging || controller.signal.aborted) return;
      if (!["log", "decision", "note", "knowhow"].includes(entry.kind) ||
          typeof entry.text !== "string" || !entry.text.trim())
        throw new Error("Invalid session note");
      const bytes = Buffer.from(entry.text);
      const prefix = !sessionStream && entry.kind !== "log" ? `[${entry.kind}] ` : "";
      // Preserve long records as individually bounded frames, including UTF-8.
      for (let start = 0; start < bytes.length;) {
        let end = Math.min(bytes.length, start + 20000 - Buffer.byteLength(prefix));
        while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
        const text = bytes.subarray(start, end).toString("utf8");
        const record:SessionRecord={id:randomUUID(),kind:entry.kind,text,at:new Date().toISOString()};
        publication.publish(record,sessionStream ? {type:"session",session:{...record,kind:entry.kind}} : {type:"log",text:prefix+text,at:record.at});
        start = end;
      }
    };
    const recordToolDenial = (protocol: "roster-local-tool-denial/1" | "roster-core-tool-denial/1", reason: string) => {
      if (!logging || controller.signal.aborted) return;
      const record:SessionRecord={id:"tool-denial."+randomUUID(),kind:"decision",text:JSON.stringify({protocol,reason}),at:new Date().toISOString()};
      publication.publish(record,sessionStream ? {type:"session",session:{...record,kind:"decision"}} : {type:"log",text:"[decision] "+record.text,at:record.at});
      publication.flush();
    };
    const denyLocalTool = (reason: "local_policy_unavailable" | "local_policy_denied"): never => {
      const error = new Error(reason);
      try {
        recordToolDenial("roster-local-tool-denial/1",reason);
      }
      finally { controller.abort(error); }
      throw error;
    };
    const readLocalPolicy = async () => {
      if (!this.localToolPolicy) return undefined;
      try {
        const policy = await this.localToolPolicy.current();
        if (validLocalToolPolicy(policy)) return policy;
      } catch { /* Never expose filesystem errors or policy contents. */ }
      return denyLocalTool("local_policy_unavailable");
    };
    const checkLocalTool = async (request: LocalToolRequest) => {
      const policy = await readLocalPolicy();
      if (policy && !localToolAllowed(policy, request)) denyLocalTool("local_policy_denied");
    };
    const failManagedTool = (error: unknown): never => {
      try {
        if (error instanceof ToolAccessRefusal) {
          recordToolDenial("roster-core-tool-denial/1",error.reason);
        }
      } finally { controller.abort(error); }
      throw error;
    };
    const checkCoreTrust = async () => {
      if (!coreMcp) return;
      let policy;
      if (this.coreTrust) {
        try {
          policy=await this.coreTrust.current();
          if (!validCoreTrustPolicy(policy)) throw new Error();
        } catch { return failManagedTool(new ToolAccessRefusal("core_trust_unavailable")); }
      }
      if (!coreOriginTrusted(policy,input.agent_id,coreMcp.url))
        return failManagedTool(new ToolAccessRefusal("core_origin_untrusted"));
    };
    const checkCoreAccess = async () => {
      await checkCoreTrust();
      if(!this.coreAuthority)return;
      if(!coreMcp)return failManagedTool(new ToolAccessRefusal("core_credential_missing"));
      try {
        await this.coreAuthority.verify(coreMcp,{executionId:input.execution_id,workId:input.work_id,runtimeId:this.id,agentId:input.agent_id,requestSha256},controller.signal);
        await checkCoreTrust();
      }catch(error){return failManagedTool(error);}
    };
    const clientRefusal=(error:unknown):never=>{
      if(controller.signal.aborted)throw controller.signal.reason;
      return failManagedTool(error instanceof ToolAccessRefusal?error:
        new ToolAccessRefusal(error instanceof McpClientBindingDenied?'execution_scope_denied':'core_authority_unavailable'));
    };
    const reportedUsage=new Map<string,SessionRecord>();
    const recordModelUsage=(usage: ModelUsage) => {
      if(!logging || controller.signal.aborted) return;
      try {
      const previous=reportedUsage.get(usage.invocation_id);
      const record=modelUsageRecord(usage,previous?.at ?? new Date().toISOString());
      if(previous) {
        if(previous.text!==record.text) {const error=new Error("Model usage report conflict");controller.abort(error);throw error;}
        return;
      }
      reportedUsage.set(usage.invocation_id,record);
      publication.publish(record,sessionStream ? {type:"session",session:record} : {type:"log",text:"Model usage: "+record.text,at:record.at});
      } catch(error) {controller.abort(error);throw error;}
    };
    try {
      accepted();
      controller.signal.throwIfAborted();
      // A plain local call cannot use private state as a substitute for Core's
      // fresh execution/body authority. Ordinary invocations stay compatible.
      if(input.context.continuation && (this.coreAuthority?.bindsRequest!==true||!coreMcp||!requestSha256||!/^[a-f0-9]{64}$/.test(requestSha256)))
        failManagedTool(new ToolAccessRefusal('core_authority_unavailable'));
      await checkCoreAccess();
      const continuation=await loadExecutionContinuation(input,this.id,this.executions);
      if(continuation)await checkCoreAccess();
      const workspace = await this.workspaces.create(
        input.agent_id,
        input.execution_id,
      );
      controller.signal.throwIfAborted();
      await checkCoreAccess();
      const policy = await readLocalPolicy();
      const executionInput = policy ? snapshotAgentInvocation({...input,context:{...input.context,
        resources:localResourceSelection(policy,input.agent_id,input.context.resources ?? [])}}) : input;
      controller.signal.throwIfAborted();
      const suspendForCompletion = (waitId:string,checkpoint:Record<string,unknown>):never => {
          controller.signal.throwIfAborted();
          if (!logging || suspensionRequest) throw new Error('Execution is no longer accepting a suspension');
          suspensionRequest=new AgentSuspensionRequest(waitId,checkpoint);
          throw suspensionRequest;
        };
      const result = await executeTrackedAgent(this.engine, agent, executionInput, {
        continuation,
        suspendForCompletion,
        suspendForReply: suspendForCompletion,
        parameters: snapshotAgentParameters(agent.parameters ?? {}),
		coreMcp,
        authorizeCoreConnection: checkCoreAccess,
        refuseCoreAccess: reason=>failManagedTool(new ToolAccessRefusal(reason)),
        resources: executionInput.context.resources ?? [],
        bindMcpConnection: async configuration => {
          try {
            if(!this.mcpConnections)throw new ToolAccessRefusal('execution_scope_denied');
            await checkCoreAccess();
            return await this.mcpConnections.bindClient(configuration);
          }catch(error){return clientRefusal(error);}
        },
        visibleMcpTools: async (connectionId, names, revision) => {
          try {
            const current = await readLocalPolicy();
            let selected=current ? localMcpToolSelection(current,input.agent_id,connectionId,names) : [...names];
            if(!selected.length)return [];
            if(!this.mcpConnections||!revision)throw new ToolAccessRefusal('execution_scope_denied');
            if(!coreMcp)throw new ToolAccessRefusal('core_credential_missing');
            selected=await this.mcpConnections.selectClient(connectionId,revision,selected);
            await checkCoreAccess();
            selected=await selectCoreMcpTools(coreMcp,{protocol:'roster-mcp-tool-selection/1',runtime_id:this.id,connection_id:connectionId,revision,tools:selected},controller.signal);
            await checkCoreAccess();
            selected=await this.mcpConnections.selectClient(connectionId,revision,selected);
            const latest=await readLocalPolicy();
            return latest?localMcpToolSelection(latest,input.agent_id,connectionId,selected):selected;
          }catch(error){return clientRefusal(error);}
        },
        invokeResource: async (operation) => {
          try {
            const request: LocalToolRequest = {agentId:input.agent_id,kind:"resource",target:operation.id,operation:operation.name};
            await checkLocalTool(request);
            if (!coreMcp) throw new ToolAccessRefusal("core_credential_missing");
            await checkCoreAccess();
            if (!input.context.resources?.some(resource => resource.id === operation.id && resource.operations.includes(operation.name))) throw new ToolAccessRefusal("execution_scope_denied");
            const result = await invokeCoreResource(coreMcp, operation, controller.signal);
            await checkCoreAccess();
            await checkLocalTool(request);
            return result;
          } catch (error) { return failManagedTool(error); }
        },
        authorizeMcpTool: async (connectionId, toolName, revision) => {
          try {
          const request: LocalToolRequest = {agentId:input.agent_id,kind:"mcp",target:connectionId,operation:toolName};
          await checkLocalTool(request);
          if (!coreMcp) throw new ToolAccessRefusal("core_credential_missing");
          if(!this.mcpConnections||!revision)throw new ToolAccessRefusal('execution_scope_denied');
          await this.mcpConnections.assertClient(connectionId,revision,toolName);
          await checkCoreAccess();
          await authorizeCoreMcpTool(coreMcp, this.id, connectionId, toolName, controller.signal, revision);
          await checkCoreAccess();
          await checkLocalTool(request);
          await this.mcpConnections.assertClient(connectionId,revision,toolName);
          } catch(error) { return clientRefusal(error); }
        },
        approveTool: async (tool,args) => {
          try {
            if(!this.approvals) throw new Error("Tool approval service unavailable");
            recordSession({kind:"log",text:"도구 승인 대기: "+tool});
            await this.approvals.request({agent_id:input.agent_id,execution_id:input.execution_id,work_id:input.work_id,tool,arguments:args},controller.signal);
            recordSession({kind:"decision",text:"Tool approved: "+tool});
          } catch(error) {controller.abort(error);throw error;}
        },
        workspace,
        signal: controller.signal,
        recordSession,
        recordModelUsage,
        log: (text) => {
          if (typeof text === "string" && text.trim()) recordSession({kind:"log",text});
        },
      }, consumer ? (phase,durationMS) => {
        const record=engineObservation(phase,durationMS,new Date().toISOString());
        publication.publish(record,{type:'session',session:{...record,kind:'note'}});
        publication.flush();
      } : undefined);
      // Catching the request inside an agent cannot turn it into business success.
      if (suspensionRequest) throw suspensionRequest;
      // A long-running author may make no managed tool calls. Recheck the
      // original authority before committing/releasing its terminal result.
      await checkCoreAccess();
      logging = false;
      publication.flush();
      controller.signal.throwIfAborted();
      result.metrics.duration_ms = Math.round(performance.now() - start);
      const terminal = consumer ? persist("result",terminalText(result.summary || result.status)) : undefined;
      if(consumer) this.journal!.seal(input.execution_id);
      await this.executions.save({
        id: input.execution_id,
        state: "completed",
        result,
      });
      deliver({ type: "result", result, ...(terminal ? {session:terminal}: {}) });
    } catch (error) {
      if(error===suspensionRequest && suspensionRequest && !controller.signal.aborted) {
        try {
          await checkCoreAccess();
          logging=false;
          publication.flush();
          controller.signal.throwIfAborted();
          if(!this.executions.saveSuspension) throw new Error('Durable suspension storage unavailable');
          if(consumer && (!this.journal?.commitSuspension || !this.executions.suspensionJournals))throw new Error('Durable suspension journal unavailable');
          const checkpoint:SuspensionCheckpoint={version:1,wait_id:suspensionRequest.waitId,execution_id:input.execution_id,work_id:input.work_id,runtime_id:this.id,agent_id:input.agent_id,state:suspensionRequest.state};
          const receipt:SuspensionReceipt={protocol:'roster-execution-suspension/1',wait_id:checkpoint.wait_id,execution_id:checkpoint.execution_id,work_id:checkpoint.work_id,runtime_id:checkpoint.runtime_id,agent_id:checkpoint.agent_id,checkpoint_digest:createHash('sha256').update(JSON.stringify(checkpoint)).digest('hex')};
          suspensionReceipt=receipt;
          const terminal:SessionRecord|undefined=consumer ? {id:'suspension.'+input.execution_id,kind:'note',text:SUSPENSION_NOTE,at:new Date().toISOString()} : undefined;
          const commit:SuspensionJournalCommit|undefined=terminal && consumer ? {receipt,binding:{execution_id:input.execution_id,work_id:input.work_id,agent_id:input.agent_id,consumer_id:consumer},entry:terminal} : undefined;
          // Persist the checkpoint and recovery intent before the journal note.
          await this.executions.saveSuspension({id:input.execution_id,state:'suspended',suspension:receipt},checkpoint,commit);
          if(commit)this.journal!.commitSuspension!(commit);
          deliver({type:'suspended',suspension:receipt,...(terminal?{session:terminal}:{})});
          return;
        } catch(suspensionError) {error=suspensionError;}
      }
      logging = false;
      if(suspensionReceipt) {
        const stored=await this.executions.get(input.execution_id);
        if(stored?.state==='suspended' && JSON.stringify(stored.suspension)===JSON.stringify(suspensionReceipt)) {
          // Never downgrade an immutable stopped fact after an ambiguous write.
          // Startup replays only its exact safe note, not the agent execution.
          deliver({type:'observation',code:'suspension_journal_pending',message:'Execution stopped; suspension journal recovery is pending.'});
          return;
        }
      }
      try { publication.flush(); } catch(journalError) { error=journalError; }
      let message = error instanceof Error ? error.message : String(error);
      for (const reference of this.credentials?.references() ?? []) {
        const secret=this.credentials?.get(reference);if(secret)message=message.split(secret).join('[redacted]');
      }
      const selectedReference=agent.parameters?.credential_env;
      if(typeof selectedReference==='string') {
        const secret=this.credentials?.get(selectedReference) ?? process.env[selectedReference];
        if(secret)message=message.split(secret).join('[redacted]');
      }
      message=message.replace(/sk-[A-Za-z0-9_-]{6,}/g,'[redacted]').replace(/Bearer\s+\S+/gi,'Bearer [redacted]');
      let terminal: SessionRecord | undefined;
      try { if(consumer) terminal=persist("observation",terminalText(message)); } catch { /* Keep the receipt in attention even if the journal disk failed. */ }
      await this.executions.save({
        id: input.execution_id,
        state: "attention",
        observation: message,
      });
      if(consumer) { try { this.journal!.seal(input.execution_id); } catch { /* Recovered on next startup. */ } }
      deliver({
        type: "observation",
        code: controller.signal.aborted ? "interrupted" : "execution_error",
        message,
        ...(terminal ? {session:terminal}: {}),
      });
    } finally {
      clearTimeout(timer);
      this.active.delete(input.execution_id);
    }
    } finally {
      this.slots.delete(input.execution_id);
    }
  }
  async close() {
    this.closing = true;
    for (const c of this.active.values()) c.abort(new Error("런타임 종료"));
    while (this.slots.size) await new Promise((r) => setTimeout(r, 25));
    if(!this.journalClosed) {this.journalClosed=true;this.journal?.close();}
  }
}
