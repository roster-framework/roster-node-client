import { z } from 'zod';
import {Scheduler,type SchedulerConfig} from './scheduling.js';
export * from './scheduling.js';
import {SuspendedFrame} from './execution-suspension.js';
import {ExecutionContinuation} from './execution-continuation.js';
export * from './execution-continuation.js';
export * from './execution-suspension.js';
import {McpConnection} from './mcp-config.js';
export {McpConnection} from './mcp-config.js';
export * from './mcp-identity.js';
export * from './invocation-authority.js';
import type {MeetingDefinitionSpec} from './meeting.js';
export * from './meeting.js';
import {ParallelDefinition,type ParallelCheckpoint,type ParallelAnyJoin} from './task-parallel.js';
export * from './task-parallel.js';
export * from './work-parallel-progress.js';
export * from './work-cancellation.js';
export * from './agent-creation.js';
export * from './resource-history.js';
export * from './work-command-audit.js';
export * from './command-denials.js';
export * from './recurring-query.js';
export * from './recurring-change-audit.js';
export * from './session-delivery.js';
export * from './session-delivery-summary.js';
export * from './event-configuration.js';
export * from './event-work-command.js';

export const PROTOCOL = 'roster/0.1' as const;
export const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
export const Data = z.record(z.string(), z.unknown());
export const Target = z.object({ runtime_id: Id, agent_id: Id }).strict();
export const Agent = z.object({
  id: Id, name: z.string().min(1), description: z.string(),
  statuses: z.array(Id).min(1), events: z.array(Id), skills: z.array(z.string()), rules: z.array(z.string()),
  capabilities: z.array(z.enum(['knowledge:write'])),
}).strict();
export const Manifest = z.object({
  protocol: z.literal(PROTOCOL), runtime_id: Id, name: z.string(), engine: z.string(),
  agents: z.array(Agent), isolation: z.enum(['trusted-local-process', 'sandboxed']),
  management: z.boolean().default(false),
  execution_continuation: z.enum(['roster-execution-continuation/1','roster-execution-continuation/2']).optional(),
}).strict();
export const EventEmission = z.object({ type: Id, data: Data.default({}) }).strict();
export const SubscriptionDelivery = z.object({
  owner_member_id: Id, recipient_member_id: Id, publisher_member_id: Id.optional(), signal: Id,
  instruction: z.string().max(10000).optional(), resource_ids: z.array(Id).max(100).optional(),
}).strict();
export type SubscriptionDeliverySpec = z.infer<typeof SubscriptionDelivery>;
export const Result = z.object({
  status: Id, summary: z.string().max(20000), output: Data.default({}), events: z.array(EventEmission).max(20).default([]),
  artifacts: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9_.-]{1,120}$/), mime: z.enum(['text/plain','text/markdown','application/json']), content: z.string().max(100000) }).strict()).max(10).default([]),
  metrics: z.object({ duration_ms: z.number().nonnegative().optional(), cost_usd: z.number().nonnegative().optional() }).strict().default({}),
}).strict();
export const Invocation = z.object({
  protocol: z.literal(PROTOCOL), execution_id: Id, work_id: Id, agent_id: Id,
  input: Data, context: z.object({
    continuation: ExecutionContinuation.optional(),
    subscription_delivery: SubscriptionDelivery.optional(),
    core_instructions: z.object({text:z.string().max(20000),version:z.number().int().nonnegative(),updated:z.string(),updated_by:z.string()}).strict().optional(),
    request: z.string().max(20000), culture: z.string().max(20000),
    history: z.array(z.object({ actor: z.string(), summary: z.string(), output: Data })),
    knowledge: z.array(z.object({ id: z.string().optional(), kind: z.string().optional(), version: z.number().optional(), title: z.string(), body: z.string() })),
  }),
}).strict();
export const Frame = z.discriminatedUnion('type', [
  SuspendedFrame,
  z.object({ type: z.literal('log'), text: z.string().max(20000), at: z.string() }).strict(),
  z.object({ type: z.literal('result'), result: Result }).strict(),
  z.object({ type: z.literal('observation'), code: Id, message: z.string() }).strict(),
]);
export const ReviewAction = z.object({id:Id,label:z.string().min(1),event:Id.optional()}).strict();
export const QueueSchedule = z.object({
  priority: z.number().int().min(-1).max(2).default(0),
  not_before: z.iso.datetime({offset:true}).optional(),
  paused: z.boolean().optional(),
}).strict();
export type Schedule = z.infer<typeof QueueSchedule>;
const Subscription = z.object({
  from_member_id: Id.optional(), target_member_id: Id.optional(), owner_member_id: Id.optional(),
  instruction: z.string().max(10000).optional(), resource_ids: z.array(Id).max(100).optional(),
  priority: z.number().int().min(-1).max(2).optional(), delay_seconds: z.number().int().min(0).max(31536000).optional(),
  id: Id, on: Id, from: Target.optional(), source_id: Id.optional(), target: Target.optional(),
  board: z.object({ team: Id, title: z.string().min(1), response_event: Id.optional(), complete_on_response: z.boolean().default(false), actions:z.array(ReviewAction).max(5).optional() }).strict().optional(),
  max_per_work: z.number().int().min(1).max(20).default(3),
}).strict().refine(r => [r.target, r.target_member_id, r.board].filter(Boolean).length === 1, '전달 대상은 하나만 지정해야 합니다.')
  .refine(r => [r.from, r.from_member_id, r.source_id].filter(Boolean).length <= 1, '발행자는 하나만 지정해야 합니다.')
  .refine(r => !r.instruction && !r.resource_ids?.length || Boolean(r.target_member_id), '추가 지시문/리소스에는 구성원 수신자가 필요합니다.');
export const Workflow = z.object({ version: z.literal(1), name: z.string().min(1), subscriptions: z.array(Subscription).max(100) }).strict();
export type AgentSpec = z.infer<typeof Agent>;
export type RuntimeManifest = z.infer<typeof Manifest>;
export type RunInput = z.infer<typeof Invocation>;
export type RunResult = z.infer<typeof Result>;
export type RunFrame = z.infer<typeof Frame>;
export type WorkflowSpec = z.infer<typeof Workflow>;
export type ExecutionTarget = z.infer<typeof Target>;

export const ToolApprovalPolicy = z.object({
  mode: z.enum(['none','all','selected']),
  tools: z.array(z.string().min(1).max(200)).max(200),
}).strict().refine(p => p.mode !== 'selected' || p.tools.length > 0, 'Select tools requiring approval');
export type ToolApprovalPolicySpec = z.infer<typeof ToolApprovalPolicy>;
export type ToolApproval = {id:string;agent_id:string;execution_id:string;work_id:string;tool:string;arguments:Record<string,unknown>;state:'pending'|'approved'|'denied'|'expired'|'consumed';created:string;expires:string;decided_at?:string;decided_by?:string};
import { AgentEngine, ModelProvider, ModelParameters } from './agent-model.js';
export { AgentEngine, ModelProvider, ModelParameters } from './agent-model.js';
export type { ModelParameterValues } from './agent-model.js';
export const ManagedAgent = z.object({
  tool_approval: ToolApprovalPolicy.optional(),
  id: Id, name: z.string().min(1), description: z.string().default(''), kind: z.enum(['echo','llm']),
  version: z.number().int().nonnegative().default(0),
  engine: AgentEngine.optional(), model_parameters: ModelParameters.optional(),
  provider: ModelProvider.default('openai-compatible'),
  instructions: z.string().max(20000).default(''), model: z.string().trim().max(300).default(''), credential_env: z.string().regex(/^(?:[A-Z][A-Z0-9_]*|)$/).default('OPENAI_API_KEY'),
  base_url: z.string().url().default('https://api.openai.com/v1'),
  statuses: z.array(Id).min(1).default(['success','needs_help']), events: z.array(Id).default([]),
  mcp_ids: z.array(Id).default([]), skills: z.array(z.string()).default([]), rules: z.array(z.string()).default([]),
}).strict();
export type ManagedAgentConfig = z.infer<typeof ManagedAgent>;
export type McpConfig = z.infer<typeof McpConnection>;
export type RuntimeAdmin = { manifest: RuntimeManifest; managed_agents: ManagedAgentConfig[]; mcp_connections: { config: McpConfig; tools: string[]; checked: string; error?: string }[]; credentials: { env: string; configured: boolean }[] };

export function validateResult(agent: AgentSpec, value: unknown): RunResult {
  const parsed = Result.parse(value);
  if (!agent.statuses.includes(parsed.status)) throw new Error(`선언되지 않은 반환 상태: ${parsed.status}`);
  for (const event of parsed.events) if (!agent.events.includes(event.type)) throw new Error(`선언되지 않은 이벤트: ${event.type}`);
  return parsed;
}
export function validateManifest(value: unknown): RuntimeManifest {
  const parsed = Manifest.parse(value);
  if (new Set(parsed.agents.map(a => a.id)).size !== parsed.agents.length) throw new Error('중복된 agent_id');
  for (const agent of parsed.agents) if (new Set(agent.events).size !== agent.events.length) throw new Error('중복된 반환 이벤트');
  return parsed;
}

export const NotificationConfigure = z.object({
  id: Id, version: z.number().int().nonnegative(), unit_id: Id,
  kind: z.enum(['published', 'received']), publisher_member_id: Id.optional(),
  signal: Id.optional(), event_type: Id.optional(), subscription_id: Id.optional(),
  resource_ids: z.array(Id).min(1).max(20), template: z.string().min(1).max(16000),
  body_fields: z.array(Id).max(20), enabled: z.boolean(),
}).strict().refine(v => v.publisher_member_id ? !!v.signal && !v.event_type : !!v.event_type && !v.signal,
  'Select a publisher signal or a Core event')
  .refine(v => v.kind === 'received' ? !!v.subscription_id : !v.subscription_id, 'Received notifications require a subscription')
  .refine(v => new Set(v.resource_ids).size === v.resource_ids.length && new Set(v.body_fields).size === v.body_fields.length, 'Duplicate destination or body field');
export type NotificationConfig = z.infer<typeof NotificationConfigure>;
export type NotificationDestination = { resource_id:string; server_id:string; provider_id:string; binding_version:number; provider_version:number };
export type NotificationRule = NotificationConfig & { owner_account_id:string; owner_member_id:string; destinations:NotificationDestination[] };
export type NotificationStatus = {
  id:string; rule_id:string; rule_version:number; owner_member_id:string; kind:'published'|'received';
  unit_id:string; work_id:string; event_id:string; publisher_member_id?:string; recipient_member_id?:string;
  subscription_id?:string; receipt_id?:string; destination:NotificationDestination;
  state:'pending'|'sending'|'delivered'|'failed'|'blocked'; attempts:number; cycle_attempts:number;
  created:string; attempted_at?:string; delivered_at?:string; next_at?:string; failure?:string;
};

// Workflows address members/teams; execution targets are resolved by core.
export const TaskStep = z.object({
  kind: z.enum(['member', 'team', 'flow', 'auto', 'review', 'parallel']),
  parallel: ParallelDefinition.optional(),
  member_id: Id.optional(), team_id: Id.optional(), flow_id: Id.optional(),
  instruction: z.string().max(10000).optional(), accept: z.array(Id).max(100).optional(),
  allowed_members: z.array(Id).min(1).max(100).optional(),
  timeout_seconds: z.number().int().min(0).max(600).optional(),
}).strict().superRefine((step, ctx) => {
  const invalid = step.kind === 'parallel'
    ? !step.parallel || !!step.member_id || !!step.team_id || !!step.flow_id || !!step.instruction || !!step.accept?.length || !!step.allowed_members?.length || !!step.timeout_seconds
    : step.parallel !== undefined;
  if (invalid) ctx.addIssue({code:'custom',message:'Invalid parallel step'});
  if (step.parallel && (new Set(step.parallel.members.map(m=>m.member_id)).size !== step.parallel.members.length || step.parallel.members.some(m=>new Set(m.accept).size !== m.accept.length)))
    ctx.addIssue({code:'custom',message:'Duplicate parallel member or status'});
});
export type TaskStepSpec = z.infer<typeof TaskStep>;
export const TaskFlow = z.object({
  id: Id, name: z.string().min(1).max(200), unit_id: Id,
  workspace_id: Id.optional(),
  version: z.number().int().nonnegative(), default: z.boolean(),
  steps: z.array(TaskStep).min(1).max(64),
}).strict();
export type TaskFlowSpec = z.infer<typeof TaskFlow>;
export const RecurringWork = z.object({
  id: Id, unit_id: Id, title: z.string().min(1).max(200), request: z.string().min(1).max(20000),
  input: Data, steps: z.array(TaskStep).min(1).max(64), scheduling: QueueSchedule,
  every_seconds: z.number().int().min(3600).max(31536000),
  next_run_at: z.iso.datetime({offset:true}), active: z.boolean(), version: z.number().int().nonnegative(),
  last_work_id: Id.optional(), last_slot_at: z.iso.datetime({offset:true}).optional(),
}).strict();
export type RecurringWorkSpec = z.infer<typeof RecurringWork>;
export type PlannedStep = TaskStepSpec & { name: string; team: string; target?: ExecutionTarget; group?: string; candidates?: PlannedStep[]; branches?:PlannedStep[] };
export type TaskPlan = { steps: PlannedStep[]; cursor: number; blocked?: boolean; parallel?:ParallelCheckpoint; any_joins?:ParallelAnyJoin[] };

type MemberBase = { id: string; name: string; team: string; role?: string; state: 'active' | 'leave' | 'retired'; binding_version?: number; provider_history?: { previous: ExecutionTarget; next: ExecutionTarget; actor: string; at: string; version: number }[] };
export type Member = MemberBase & ( (ExecutionTarget & {kind?: 'agent'}) | {kind: 'human'; runtime_id?: never; agent_id?: never} );
export type Work = { meeting?:MeetingDefinitionSpec; plan?:TaskPlan; scheduling?:Schedule; recurring_id?:string; recurring_version?:number; scheduled_for?:string; id: string; unit_id?:string; due_date?:string; title: string; request: string; input: Record<string, unknown>; kind?: 'task'|'conversation'; target?:ExecutionTarget; human_id?:string; created_by?:string; state: 'queued' | 'working' | 'waiting' | 'attention' | 'done' | 'cancelled'; created: string; workflow: WorkflowSpec };
export type WorkEvent = { publisher_member_id?:string; signal?:string; id: string; work_id: string; type: string; data: Record<string, unknown>; source: ExecutionTarget; execution_id?: string; at: string };
export type Run = ExecutionTarget & { runtime_rejected?:boolean; timeout_seconds?:number; deadline_at?:string; timeout_at?:string; subscription_delivery?:SubscriptionDeliverySpec; core_instructions?: {text:string;version:number;updated:string;updated_by:string}; scheduling?:Schedule; created?:string; id: string; work_id: string; event_id: string; subscription: string; state: 'queued' | 'running' | 'completed' | 'attention' | 'cancelled'; logs: { at: string; text: string }[]; input: Record<string, unknown>; retrieved?: RetrievedSource[]; result?: RunResult; observation?: string; started?: string; ended?: string };
export type Card = { scheduling?:Schedule; id: string; subscription?:string; review_run_id?:string; review_digest?:string; work_id: string; team: string; title: string; body: string; state: 'open' | 'claimed' | 'done'; assignee?: string; assignee_id?:string; responder_id?:string; response?: string; response_event?: string; complete_on_response: boolean; actions?:z.infer<typeof ReviewAction>[]; action?:string; created: string };
export type Identity = { account_id: string; username: string; member_id: string; name: string; role: 'admin' | 'team_admin' | 'member' | 'viewer'; team: string; grants?:ScopeGrant[]; must_change_password?:boolean };
export type Account = { id: string; username: string; member_id: string; role: Identity['role']; disabled: boolean; created: string; grants?:ScopeGrant[]; must_change_password?:boolean };
export type Permission = 'organization.manage'|'agents.manage'|'tools.use'|'accounts.manage'|'workflow.manage'|'runtimes.manage'|'monitor.details';
export type ScopeGrant = {unit_id:string;permissions:Permission[]};
export type OrganizationUnit = {id:string;name:string;parent_id:string;color?:string};
export type TeamMessage = {id:string;team:string;member_id:string;text:string;at:string};
export type OrganizationNotice = {id:string;unit_id:string;actor_id:string;text:string;at:string};
export type SignupRequest = {id:string;username:string;name:string;team:string;title:string;created:string};
export type RuntimeResources = {runtime_id:string;error?:string;connections:{id:string;name:string;type?:string;tools:string[];agent_ids:string[];checked:string;error?:string}[]};
export type Knowledge = { id: string; title: string; body: string; work_id: string; created: string };
export type Message = { id: string; work_id: string; actor: string; text: string; at: string };
export type ContentKind = 'document' | 'session' | 'knowhow';
export type ContentRecord = { id: string; organization_id: string; kind: ContentKind; title: string; body: string; version: number; source_uri: string; work_id?: string; created: string; updated: string; deleted: boolean };
export type RetrievedSource = { id: string; kind: ContentKind; title: string; version: number; source_uri: string; excerpt: string; score: number };
export type OrgState = {
  task_flows?: TaskFlowSpec[];
  recurring_works?: RecurringWorkSpec[];
  scheduler?:SchedulerConfig;
  units?:OrganizationUnit[];notices?:OrganizationNotice[];team_messages?:TeamMessage[];unit_workflows?:{unit_id:string;definition:WorkflowSpec}[];brand_color?:string;office_theme?:string;
  revision: number; workflow_yaml: string; culture: string; organization_name: string;
  presets: { id: string; name: string; description: string; title: string; request: string; input: Record<string, unknown> }[];
  runtimes: RuntimeRegistration[];
  members: Member[]; works: Work[]; events: WorkEvent[]; runs: Run[]; cards: Card[]; knowledge: Knowledge[]; messages: Message[];
};
export type RuntimeRegistration = { url: string; alias?: string; unit_id?:string; manifest: RuntimeManifest; seen: string };
export {ProviderChangeCommand,ProviderChangeProgress,validateProviderChangeCommand,providerChangeFingerprint,validateProviderChangeProgress} from './provider-change.js';
export type {ProviderChangeCommandSpec,ProviderChangeProgressSpec} from './provider-change.js';
