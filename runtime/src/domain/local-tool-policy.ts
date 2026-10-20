import type {ResourceAccessSpec} from "./resource.js";
// Host-owner policy is independent of Core's organizational permission.
export type LocalToolRequest = {
  agentId: string;
  kind: "resource" | "mcp";
  target: string;
  operation: string;
};
export type LocalToolPolicy = {
  version: 1;
  revision: string;
  grants: LocalToolRequest[];
};
export interface LocalToolPolicySource {
  current(): Promise<LocalToolPolicy>;
}
const key = /^[A-Za-z0-9_.:-]{1,200}$/;
export function validLocalToolPolicy(value: unknown): value is LocalToolPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(k => !["version", "revision", "grants"].includes(k)) ||
      p.version !== 1 || typeof p.revision !== "string" || !key.test(p.revision) ||
      !Array.isArray(p.grants) || p.grants.length > 1000) return false;
  const seen = new Set<string>();
  return p.grants.every(g => {
    if (!g || typeof g !== "object" || Array.isArray(g) ||
        Object.keys(g).length !== 4 || Object.keys(g).some(k => !["agentId", "kind", "target", "operation"].includes(k)) ||
        ![g.agentId, g.target, g.operation].every(v => typeof v === "string" && key.test(v)) ||
        !["resource", "mcp"].includes(g.kind)) return false;
    const id = JSON.stringify([g.agentId, g.kind, g.target, g.operation]);
    if (seen.has(id)) return false;
    seen.add(id); return true;
  });
}
export function localToolAllowed(policy: LocalToolPolicy, request: LocalToolRequest): boolean {
  return validLocalToolPolicy(policy) && policy.grants.some(g =>
    g.agentId === request.agentId && g.kind === request.kind &&
    g.target === request.target && g.operation === request.operation);
}

// A denied resource's name/metadata never enters the agent-facing context.
export function localResourceSelection(policy: LocalToolPolicy, agentId: string, resources: ResourceAccessSpec[]): ResourceAccessSpec[] {
  if (!validLocalToolPolicy(policy)) return [];
  const grants = new Set(policy.grants.filter(g=>g.agentId===agentId&&g.kind==="resource")
    .map(g=>JSON.stringify([g.target,g.operation])));
  return resources.flatMap(resource => {
    const operations = resource.operations.filter(operation => grants.has(JSON.stringify([resource.id,operation])));
    return operations.length ? [{...resource,operations}] : [];
  });
}

export function localMcpToolSelection(policy: LocalToolPolicy, agentId: string, connectionId: string, names: string[]): string[] {
  if (!validLocalToolPolicy(policy)) return [];
  const allowed = new Set(policy.grants.filter(g=>g.agentId===agentId&&g.kind==="mcp"&&g.target===connectionId).map(g=>g.operation));
  return names.filter(name=>allowed.has(name));
}
