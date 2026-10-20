import {ToolAccessRefusal} from "../domain/tool-access-refusal.js";

// The execution credential belongs to this exact Core origin. Never follow a
// redirect or accept URL credentials; diagnostic errors do not echo the URL.
export function coreToolEndpoint(origin: string, pathname: string): URL {
  try {
    const url = new URL(origin);
    if (url.username || url.password || url.pathname !== "/mcp" || url.search || url.hash ||
        !(url.protocol === "https:" || url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error();
    url.pathname = pathname;
    return url;
  } catch {
    throw new ToolAccessRefusal("core_authority_unavailable");
  }
}

export async function requireCoreToolResponse(request: () => Promise<Response>, signal: AbortSignal): Promise<Response> {
  let response: Response;
  try { response = await request(); }
  catch {
    signal.throwIfAborted();
    throw new ToolAccessRefusal("core_authority_unavailable");
  }
  if (response.ok) return response;
  // Do not parse an untrusted error response or retain its stream.
  try { await response.body?.cancel(); } catch { /* The refusal still stands. */ }
  throw new ToolAccessRefusal(response.status === 403 ? "core_policy_denied" :
    response.status === 401 ? "core_credential_rejected" : "core_authority_unavailable");
}
