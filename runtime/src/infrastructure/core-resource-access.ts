import type { ResourceOperation } from "../domain/resource.js";
import {coreToolEndpoint, requireCoreToolResponse} from "./core-tool-access.js";

export async function invokeCoreResource(core: { url: string; token: string }, operation: ResourceOperation, signal: AbortSignal) {
  const url = coreToolEndpoint(core.url, "/api/core/resource-invocations");
  const response = await requireCoreToolResponse(() => fetch(url, {
    method: "POST", headers: { Authorization: `Bearer ${core.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(operation), redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
  }), signal);
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new Error("Resource tool returned invalid data"); }
  if (typeof value === "object" && value !== null && "isError" in value && value.isError === true) throw new Error("Resource tool failed");
  return value;
}
