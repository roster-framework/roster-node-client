import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export async function run(args, env = process.env, request = fetch) {
  const origin = new URL(env.ROSTER_RESOURCE_URL || "http://127.0.0.1:7340");
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
    !(origin.protocol === "https:" || origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw new Error("Invalid resource server origin");
  const [command, value, version] = args;
  let method = "GET", path = "/v1/resources", input, rawInput, token = env.ROSTER_RESOURCE_TOKEN;
  if (command === "history" && value && args.length <= 4) {
    const query = new URLSearchParams();
    if (version) query.set('limit',version);
    if (args[3]) query.set('after',args[3]);
    path += `/${encodeURIComponent(value)}/history` + (query.size?'?'+query:'');
  } else if (command === "register" && value) {
    method = "POST"; input = JSON.parse(await readFile(value, "utf8")); token = env.ROSTER_RESOURCE_ADMIN_TOKEN;
  } else if (command === "configure-subscription" && value && args.length===2) {
    method="POST";rawInput=await readFile(value,"utf8");if(Buffer.byteLength(rawInput)>100000)throw new Error("Subscription command exceeds limit");const command=JSON.parse(rawInput);if(typeof command.resource_id!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(command.resource_id))throw new Error("Invalid resource ID");path+=`/${encodeURIComponent(command.resource_id)}/subscription-configurations`;
  } else if (command === "publish" && value) {
    method = "POST"; input = JSON.parse(await readFile(value, "utf8")); path += `/${encodeURIComponent(input.id)}/publish`;
  } else if (command === "get" && value) path += `/${encodeURIComponent(value)}/document?version=${encodeURIComponent(version || "0")}`;
  else if (command === "invoke" && value && version) {
    method = "POST"; path += `/${encodeURIComponent(value)}/invoke`; input = JSON.parse(await readFile(version, "utf8"));
  } else if (command !== "list" || value) throw new Error("Usage: resource.mjs history ID [LIMIT] [AFTER] | list | register FILE | publish FILE | get ID [VERSION] | invoke ID FILE | configure-subscription FILE");
  if (!token || token.length < 32) throw new Error("Resource service credential required");
  const response = await request(new URL(path, origin), { method, redirect: "error", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: rawInput ?? (input ? JSON.stringify(input) : undefined), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Resource server status ${response.status}`);
  return response.json();
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await run(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
