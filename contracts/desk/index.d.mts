export type DeskAPI = (
  path: string,
  method?: string,
  body?: unknown,
) => Promise<any>;
export type AgentDesk = {
  schema: "roster/desk/v1";
  runtime_id: string;
  agent_id: string;
  member_id?: string;
  team: string;
  preset?: string;
  name: string;
  version: number;
  agent_version?: number;
  mcp_ids: string[];
  configuration?: Partial<Pick<import('../dist/index.js').ManagedAgentConfig,'engine'|'provider'|'model'|'base_url'|'credential_env'|'model_parameters'|'instructions'|'skills'|'rules'|'tool_approval'>>;
  credentials?: Record<string,string>;
  text: string;
};
export type DeskStep = {
  timeout_seconds?: number;
  kind: "member" | "review" | "auto" | "team" | "flow" | "parallel";
  parallel?:{mode:'all'|'any';members:{member_id:string;accept:string[];instruction?:string;timeout_seconds?:number}[]};
  member_id?: string;
  team_id?: string;
  flow_id?: string;
  instruction?: string;
  accept?: string[];
  allowed_members?: string[];
};
export type DeskFlow = {
  id: string;
  name: string;
  version: number;
  default: boolean;
  steps: DeskStep[];
};
export type DeskGrant = {
  subject_member_id: string;
  target: {
    kind: "member" | "unit" | "mcp" | "work" | "resource";
    id: string;
    include_descendants?: boolean;
  };
  actions: string[];
};
export type WorkspaceDesk = {
  schema: "roster/desk/v2";
  work_revision?: number;
  owner:
    | { member_id: string; agent?: never }
    | { agent: Omit<AgentDesk, "schema" | "text">; member_id?: never };
  workspace: { name: string; team_id: string; version: number };
  space?: { enabled: boolean; member_ids: string[]; version: number };
  flows?: DeskFlow[];
  events?: {
    version: number;
    definition: {
      version: 1;
      name: string;
      subscriptions: {
        id: string;
        on: string;
        from_member_id?: string;
        target_member_id?: string;
        instruction?: string;
        resource_ids?: string[];
        priority?: number;
        delay_seconds?: number;
        max_per_work?: number;
        board?: {
          team: string;
          title: string;
          response_event?: string;
          complete_on_response?: boolean;
          actions?: { id: string; label: string; event?: string }[];
        };
      }[];
    };
  };
  resources?: {
    bindings: {
      id: string;
      server_id: string;
      resource_id: string;
      version: number;
      actions: string[];
    }[];
    expected_grants: DeskGrant[];
  };
  text: string;
};
export type AgentPlan = {
  desk: AgentDesk;
  desired: any;
  member?: { id: string };
  writeAgent: boolean;
  writeInstructions: boolean;
  createMember: boolean;
  existing: boolean;
};
export type WorkspacePlan = {
  workMode: "local" | "independent";
  desk: WorkspaceDesk;
  owner: string;
  agent?: AgentPlan;
  writeWorkspace: boolean;
  writeSpace: boolean;
  flows: { desired: any; write: boolean }[];
  resourcePlan?: { write: boolean };
  eventPlan?: { write: boolean };
};
export function parseDesk(source: string): AgentDesk;
export function parseDeskDocument(source: string): AgentDesk | WorkspaceDesk;
export function formatDesk(desk: AgentDesk): string;
export function planDesk(api: DeskAPI, desk: AgentDesk): Promise<AgentPlan>;
export function applyDesk(api: DeskAPI, desk: AgentDesk): Promise<AgentDesk>;
export function exportDesk(
  api: DeskAPI,
  runtime: string,
  agent: string,
): Promise<AgentDesk>;
export function validateWorkspaceDesk(desk: WorkspaceDesk): WorkspaceDesk;
export function parseWorkspaceDesk(source: string): WorkspaceDesk;
export function formatWorkspaceDesk(desk: WorkspaceDesk): string;
export function planWorkspaceDesk(
  api: DeskAPI,
  desk: WorkspaceDesk,
): Promise<WorkspacePlan>;
export function applyWorkspaceDesk(
  api: DeskAPI,
  desk: WorkspaceDesk,
): Promise<WorkspaceDesk>;
export function exportWorkspaceDesk(
  api: DeskAPI,
  member: string,
  options?: { agent?: boolean; resources?: boolean; events?: boolean },
): Promise<WorkspaceDesk>;
export class DeskApplyError extends Error {
  phase: string;
  completed: string[];
  owner: string;
  cause: unknown;
}
