// Runtime-owned audience expected from the authenticated Core, never a prompt.
export type ExecutionAudience = {executionId:string;workId:string;runtimeId:string;agentId:string;requestSha256?:string};
export type CoreConnection = {url:string;token:string};
export interface CoreExecutionAuthority {
  readonly bindsRequest?: boolean;
  verify(core:CoreConnection, expected:ExecutionAudience, signal:AbortSignal):Promise<void>;
}
