import { equal, bytes } from "./value.mjs";
import { parseDeskJSON } from "./json.mjs";
import {validateDeskConfiguration,validateDeskCredentials} from './configuration.mjs';
const isDeepStrictEqual = equal;
// Match the shared runtime/core Id contract, including dotted IDs and its length cap.
const id = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/;
export function parseDesk(text) {
  if (bytes(text) > 40000) throw Error("Desk file exceeds 40000 bytes");
  const match = text
    .replace(/^\uFEFF/, "")
    .match(/^```json\r?\n([\s\S]*?)\r?\n```(?:\r?\n|$)([\s\S]*)$/);
  if (!match)
    throw Error(
      "Desk must start with a JSON fenced block followed by Markdown instructions",
    );
  const desk = parseDeskJSON(match[1],250000);
  const allowed = [
    "schema",
    "runtime_id",
    "agent_id",
    "member_id",
    "team",
    "preset",
    "name",
    "version",
    "agent_version",
    "mcp_ids",
    "configuration",
    "credentials",
  ];
  if (
    !desk ||
    typeof desk !== "object" ||
    Array.isArray(desk) ||
    Object.keys(desk).some((k) => !allowed.includes(k))
  )
    throw Error("Unknown Desk metadata field");
  if (desk.schema !== "roster/desk/v1") throw Error("Unsupported Desk schema");
  if(desk.configuration!==undefined)validateDeskConfiguration(desk.configuration);
  if(desk.credentials!==undefined)validateDeskCredentials(desk.credentials);
  for (const key of ["runtime_id", "agent_id", "team"])
    if (typeof desk[key] !== "string" || !id.test(desk[key]))
      throw Error("Invalid " + key);
  for (const key of ["member_id", "preset"])
    if (
      desk[key] !== undefined &&
      (typeof desk[key] !== "string" || !id.test(desk[key]))
    )
      throw Error("Invalid " + key);
  if (!Number.isSafeInteger(desk.version) || desk.version < 0)
    throw Error("version is required");
  if (
    desk.agent_version !== undefined &&
    (!Number.isSafeInteger(desk.agent_version) || desk.agent_version < 0)
  )
    throw Error("Invalid agent_version");
  if (
    typeof desk.name !== "string" ||
    !desk.name.trim() ||
    desk.name.length > 100
  )
    throw Error("Invalid name");
  if (
    !Array.isArray(desk.mcp_ids) ||
    desk.mcp_ids.length > 100 ||
    desk.mcp_ids.some((v) => typeof v !== "string" || !id.test(v)) ||
    new Set(desk.mcp_ids).size !== desk.mcp_ids.length
  )
    throw Error("Invalid mcp_ids");
  desk.text = match[2].trim();
  if (bytes(desk.text) > 20000) throw Error("Instructions exceed 20000 bytes");
  return desk;
}
export function formatDesk(desk) {
  const { text, ...metadata } = desk;
  return (
    "```json\n" + JSON.stringify(metadata, null, 2) + "\n```\n\n" + text + "\n"
  );
}
const agentPath = (d) => "/agents/" + d.runtime_id + "/" + d.agent_id;
export async function planDesk(api, desk) {
  const state = await api("/state");
  if (!(state.units || []).some((u) => u.id === desk.team))
    throw Error("Unknown team");
  const matches = (state.members || []).filter(
    (m) =>
      m.kind !== "human" &&
      m.runtime_id === desk.runtime_id &&
      m.agent_id === desk.agent_id,
  );
  if (matches.length > 1) throw Error("Ambiguous member binding");
  const member = matches[0];
  if (desk.member_id && member?.id !== desk.member_id)
    throw Error("Member binding changed; export Desk again");
  if (member && (member.team !== desk.team || member.state !== "active"))
    throw Error("Desk does not move teams or reactivate members");
  const settings = await api(member ? agentPath(desk) : '/runtimes/'+desk.runtime_id+'/admin');
  const existing = (settings.managed_agents || []).find(
    (a) => a.id === desk.agent_id,
  );
  const declared = (settings.manifest?.agents || []).some(
    (a) => a.id === desk.agent_id,
  );
  if (!existing && declared)
    throw Error("Code-defined agents cannot be overwritten by Desk");
  let agent = existing;
  if (!agent) {
    if (!desk.preset) throw Error("New agents require a preset");
    agent = (settings.agent_presets || []).find(
      (p) => p.id === desk.preset,
    )?.agent;
    if (!agent) throw Error("Preset not found or not accessible");
    const catalog = settings.skill_catalog;
    if (
      agent.kind === "llm" &&
      catalog?.mode === "files" &&
      (agent.skills || []).length
    ) {
      if (catalog.error) throw Error("Skill catalog unavailable");
      const ready = new Map(
        (catalog.skills || []).map((item) => [item.id, item.ready]),
      );
      if (
        agent.skills.some(
          (skill) =>
            ready.get(skill) === false ||
            (!catalog.truncated && !ready.has(skill)),
        )
      )
        throw Error("Preset skill file unavailable");
    }
  }
  const available = new Set(
    (settings.mcp_connections || []).map((c) => c.config.id),
  );
  if (desk.mcp_ids.some((v) => !available.has(v)))
    throw Error("MCP connection not found or not accessible");
  const instructions = member
    ? await api(agentPath(desk) + "/instructions")
    : { text: "", version: 0 };
  if (instructions.version !== desk.version)
    throw Error("Desk version conflict; export current Desk first");
  const desired = {
    ...structuredClone(agent),
    ...(desk.configuration ? validateDeskConfiguration(structuredClone(desk.configuration)) : {}),
    id: desk.agent_id,
    name: desk.name,
    mcp_ids: desk.mcp_ids,
    version: existing?.version ?? 0,
  };
  const writeAgent = !isDeepStrictEqual(
    existing && { ...existing, version: existing.version ?? 0 },
    desired,
  );
  if (writeAgent && existing && desk.agent_version === undefined)
    throw Error("Desk agent version missing; export current Desk first");
  if (
    desk.agent_version !== undefined &&
    desk.agent_version !== (existing?.version ?? 0)
  )
    throw Error("Desk agent version conflict; export current Desk first");
  return {
    desk,
    desired,
    member,
    writeAgent,
    writeInstructions: instructions.text !== desk.text,
    createMember: !member,
    existing: Boolean(existing),
  };
}
export async function applyDesk(api, desk) {
  const plan = await planDesk(api, desk);
  let phase = "agent settings";
  const completed = [];
  try {
    if(desk.credentials) {
      phase='runtime credentials';
      await api('/runtimes/'+desk.runtime_id+'/manage/credentials','PUT',validateDeskCredentials(desk.credentials));
      completed.push(phase);
    }
    phase='agent settings';
    if (plan.writeAgent) {
      await api(plan.member ? agentPath(desk) : '/runtimes/'+desk.runtime_id+'/manage/'+(plan.existing?'agent-configuration':'agents'), "PUT", plan.desired);
      completed.push(phase);
    }
    phase = "member binding";
    if (plan.createMember) {
      await api("/members", "POST", {
        runtime_id: desk.runtime_id,
        agent_id: desk.agent_id,
        team: desk.team,
      });
      completed.push(phase);
    }
    phase = "core instructions";
    if (plan.writeInstructions) {
      await api(agentPath(desk) + "/instructions", "PUT", {
        text: desk.text,
        version: desk.version,
      });
      completed.push(phase);
    }
    phase = "current agent export";
    return await exportDesk(api, desk.runtime_id, desk.agent_id);
  } catch (error) {
    const failure = Error(
      "Desk application stopped at " +
        phase +
        ". Earlier steps may have succeeded; inspect or export before retrying. " +
        (desk.credentials ? 'Inspect current settings before retrying.' : error.message),
    );
    failure.phase = phase;
    failure.completed = completed;
    throw failure;
  }
}
export async function exportDesk(api, runtime, agent) {
  if (!id.test(runtime) || !id.test(agent)) throw Error("Invalid target");
  const state = await api("/state");
  const members = (state.members || []).filter(
    (m) =>
      m.kind !== "human" && m.runtime_id === runtime && m.agent_id === agent,
  );
  if (members.length !== 1) throw Error("Expected one member");
  const settings = await api("/agents/" + runtime + "/" + agent);
  const config = (settings.managed_agents || []).find((a) => a.id === agent);
  if (!config) throw Error("Managed agent required");
  const instruction = await api(
    "/agents/" + runtime + "/" + agent + "/instructions",
  );
  return {
    schema: "roster/desk/v1",
    runtime_id: runtime,
    agent_id: agent,
    member_id: members[0].id,
    team: members[0].team,
    name: config.name,
    version: instruction.version,
    agent_version: config.version ?? 0,
    mcp_ids: config.mcp_ids || [],
    configuration: Object.fromEntries(['engine','provider','model','base_url','credential_env','model_parameters','instructions','skills','rules','tool_approval'].filter(key=>config[key]!==undefined).map(key=>[key,structuredClone(config[key])])),
    text: instruction.text,
  };
}
