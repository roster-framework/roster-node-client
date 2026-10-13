// A host-owner connection boundary, separate from organizational tool grants.
export type CoreTrustPolicy = {version: 1; revision: string; grants: {agentId: string; origin: string}[]};
export interface CoreTrustSource { current(): Promise<CoreTrustPolicy>; }
const selector = /^[A-Za-z0-9_.:-]{1,200}$/;

export function coreMcpOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.pathname !== "/mcp" || url.search || url.hash ||
        !(url.protocol === "https:" || url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) return;
    return url.origin;
  } catch { return; }
}

export function validCoreTrustPolicy(value: unknown): value is CoreTrustPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(k=>!["version","revision","grants"].includes(k)) || p.version!==1 ||
      typeof p.revision!=="string" || !selector.test(p.revision) || !Array.isArray(p.grants) || p.grants.length>1000) return false;
  const seen = new Set<string>();
  return p.grants.every(g=>{
    if (!g || typeof g!=="object" || Array.isArray(g) || Object.keys(g).length!==2 ||
        Object.keys(g).some(k=>!["agentId","origin"].includes(k)) || typeof g.agentId!=="string" || !selector.test(g.agentId) ||
        typeof g.origin!=="string" || g.origin.length>2048 || coreMcpOrigin(g.origin+"/mcp")!==g.origin) return false;
    const key=JSON.stringify([g.agentId,g.origin]);
    if(seen.has(key)) return false;
    seen.add(key);return true;
  });
}

export function coreOriginTrusted(policy: CoreTrustPolicy | undefined, agentId: string, endpoint: string): boolean {
  const origin=coreMcpOrigin(endpoint);
  if (!origin) return false;
  // Unconfigured local installations keep loopback compatibility. Remote Core
  // endpoints require an explicit owner grant, including HTTPS endpoints.
  if (!policy) return ["127.0.0.1","localhost","[::1]"].includes(new URL(origin).hostname);
  return validCoreTrustPolicy(policy) && policy.grants.some(g=>g.agentId===agentId&&g.origin===origin);
}
