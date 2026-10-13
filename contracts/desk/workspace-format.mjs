import { parseDesk, formatDesk } from "./agent.mjs";
import { bytes, record, version, id, ids, text } from "./value.mjs";
import { validateDeskEvents } from "./events.mjs";
import { validateParallel } from './parallel.mjs';
import {parseDeskJSON} from './json.mjs';
export const resourceActions = [
  "resource.read",
  "resource.write",
  "resource.use",
];
const actions = [
  ...resourceActions,
  "work.read",
  "work.create",
  "chat.send",
  "agent.trigger",
  "event.forward",
  "mcp.use",
  "session.read",
  "session.correct",
  "knowhow.read",
  "workspace.read",
];
export function validateWorkspaceDesk(desk) {
  record(
    desk,
    [
      "schema",
      "work_revision",
      "owner",
      "workspace",
      "space",
      "flows",
      "events",
      "resources",
      "text",
    ],
    "Desk v2 metadata",
  );
  if (desk.schema !== "roster/desk/v2") throw Error("Unsupported Desk schema");
  if (desk.work_revision !== undefined) {
    version(desk.work_revision, "Work");
    if(desk.work_revision>=Number.MAX_SAFE_INTEGER)throw Error("Invalid Work revision");
  }
  record(desk.owner, ["member_id", "agent"], "Desk owner");
  if (!!desk.owner.member_id === !!desk.owner.agent)
    throw Error("Choose one owner reference or managed agent");
  if (desk.owner.member_id) id(desk.owner.member_id, "owner member");
  else {
    record(
      desk.owner.agent,
      [
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
      ],
      "managed agent",
    );
    parseDesk(
      formatDesk({
        ...desk.owner.agent,
        schema: "roster/desk/v1",
        text: desk.text,
      }),
    );
  }
  if (
    typeof desk.text !== "string" ||
    bytes(desk.text) > 20000 ||
    (desk.owner.member_id && desk.text.trim())
  )
    throw Error("Markdown instructions require a managed agent owner");
  record(desk.workspace, ["name", "team_id", "version"], "workspace");
  text(desk.workspace.name, "workspace name", 200);
  id(desk.workspace.team_id, "workspace team");
  version(desk.workspace.version, "workspace");
  if (desk.space !== undefined) {
    record(desk.space, ["enabled", "member_ids", "version"], "placement space");
    if (typeof desk.space.enabled !== "boolean")
      throw Error("Invalid placement enabled");
    ids(desk.space.member_ids, "placement members", 64, true);
    version(desk.space.version, "placement");
    if (
      desk.space.enabled
        ? !desk.space.member_ids.length
        : desk.space.member_ids.length
    )
      throw Error(
        "Enabled space needs participants; disabled space must be empty",
      );
  }
  if (desk.events !== undefined) validateDeskEvents(desk.events);
  if (desk.flows !== undefined) {
    if (
      !Array.isArray(desk.flows) ||
      desk.flows.length > 64 ||
      new Set(desk.flows.map((f) => f?.id)).size !== desk.flows.length
    )
      throw Error("Invalid workspace flows");
    if (desk.flows.filter((f) => f?.default).length > 1)
      throw Error("Choose one default flow");
    for (const flow of desk.flows) {
      record(
        flow,
        ["id", "name", "version", "default", "steps"],
        "workspace flow",
      );
      id(flow.id, "flow ID");
      text(flow.name, "flow name", 200);
      version(flow.version, "flow");
      if (
        typeof flow.default !== "boolean" ||
        !Array.isArray(flow.steps) ||
        !flow.steps.length ||
        flow.steps.length > 64
      )
        throw Error("Invalid flow steps");
      for (const step of flow.steps) {
        record(
          step,
          [
            "kind",
            "member_id",
            "team_id",
            "flow_id",
            "instruction",
            "accept",
            "allowed_members",
            "timeout_seconds",
            "parallel",
          ],
          "flow step",
        );
        if (!["member", "review", "auto", "team", "flow", "parallel"].includes(step.kind))
          throw Error("Invalid step kind");
        if(step.kind==='parallel') {
          validateParallel(step.parallel);
          if(step.member_id||step.team_id||step.flow_id||step.instruction||step.accept?.length||step.allowed_members?.length||step.timeout_seconds)throw Error('Invalid parallel step target');
        }else if(step.parallel!==undefined)throw Error('Parallel definition on a sequential step');
        for (const key of ["member_id", "team_id", "flow_id"])
          if (step[key] !== undefined) id(step[key], key, key === "member_id");
        if (
          step.instruction !== undefined &&
          (typeof step.instruction !== "string" ||
            bytes(step.instruction) > 10000)
        )
          throw Error("Invalid step instruction");
        if (step.accept !== undefined)
          ids(step.accept, "accepted statuses", 100);
        if (
          step.timeout_seconds !== undefined &&
          (!Number.isInteger(step.timeout_seconds) ||
            step.timeout_seconds < 0 ||
            step.timeout_seconds > 600 ||
            (step.timeout_seconds > 0 &&
              !["member", "auto"].includes(step.kind)))
        )
          throw Error("Invalid agent step timeout");
        if (step.allowed_members !== undefined)
          ids(step.allowed_members, "delegation members", 100, true);
        if (
          (["member", "review", "auto"].includes(step.kind) &&
            !step.member_id) ||
          (step.kind === "team" && !step.team_id) ||
          (step.kind === "flow" && !step.flow_id)
        )
          throw Error("Missing step target");
        if (
          (["team", "flow"].includes(step.kind) &&
            (step.member_id ||
              step.instruction ||
              step.accept?.length ||
              step.allowed_members?.length)) ||
          (step.kind === "member" &&
            (step.team_id || step.flow_id || step.allowed_members?.length)) ||
          (step.kind === "review" &&
            (step.team_id ||
              step.flow_id ||
              step.allowed_members?.length ||
              step.accept?.length)) ||
          (step.kind === "team" && step.flow_id) ||
          (step.kind === "flow" && step.team_id) ||
          (step.kind === "auto" &&
            (!step.team_id || step.flow_id || !step.allowed_members?.length))
        )
          throw Error("Invalid step target combination");
      }
    }
  }
  if (desk.resources !== undefined) {
    record(
      desk.resources,
      ["bindings", "expected_grants"],
      "resource permissions",
    );
    if (
      !Array.isArray(desk.resources.bindings) ||
      desk.resources.bindings.length > 100 ||
      new Set(desk.resources.bindings.map((b) => b?.id)).size !==
        desk.resources.bindings.length
    )
      throw Error("Invalid resource bindings");
    for (const binding of desk.resources.bindings) {
      record(
        binding,
        ["id", "server_id", "resource_id", "version", "actions"],
        "resource binding reference",
      );
      for (const key of ["id", "server_id", "resource_id"])
        id(binding[key], key);
      version(binding.version, "binding");
      if (!binding.version) throw Error("Existing binding required");
      if (
        !Array.isArray(binding.actions) ||
        !binding.actions.length ||
        binding.actions.some((a) => !resourceActions.includes(a)) ||
        new Set(binding.actions).size !== binding.actions.length
      )
        throw Error("Invalid resource actions");
    }
    if (
      !Array.isArray(desk.resources.expected_grants) ||
      desk.resources.expected_grants.length > 1000
    )
      throw Error("Full expected grant snapshot required");
    for (const grant of desk.resources.expected_grants) {
      record(
        grant,
        ["subject_member_id", "target", "actions"],
        "expected grant",
      );
      id(grant.subject_member_id, "grant subject");
      record(
        grant.target,
        ["kind", "id", "include_descendants"],
        "grant target",
      );
      if (
        !["member", "unit", "mcp", "work", "resource"].includes(
          grant.target.kind,
        ) ||
        typeof grant.target.id !== "string" ||
        !grant.target.id ||
        bytes(grant.target.id) > 300
      )
        throw Error("Invalid grant target");
      if (
        grant.target.include_descendants !== undefined &&
        typeof grant.target.include_descendants !== "boolean"
      )
        throw Error("Invalid descendant selector");
      if (
        !Array.isArray(grant.actions) ||
        !grant.actions.length ||
        grant.actions.some((a) => !actions.includes(a))
      )
        throw Error("Invalid grant actions");
    }
  }
  if (bytes(JSON.stringify(desk)) > 250000)
    throw Error("Workspace Desk exceeds 250000 bytes");
  return desk;
}
export function parseWorkspaceDesk(source) {
  if (bytes(source) > 250000)
    throw Error("Workspace Desk exceeds 250000 bytes");
  const match = source
    .replace(/^\uFEFF/, "")
    .match(/^```json\r?\n([\s\S]*?)\r?\n```(?:\r?\n|$)([\s\S]*)$/);
  if (!match)
    throw Error(
      "Desk must start with a JSON fenced block followed by Markdown instructions",
    );
  const metadata = parseDeskJSON(match[1],250000);
  if (metadata && Object.hasOwn(metadata, "text"))
    throw Error("Instructions belong after the JSON block");
  return validateWorkspaceDesk({ ...metadata, text: match[2].trim() });
}
export function formatWorkspaceDesk(desk) {
  validateWorkspaceDesk(desk);
  const { text, ...metadata } = desk;
  const source =
    "```json\n" + JSON.stringify(metadata, null, 2) + "\n```\n\n" + text + "\n";
  if (bytes(source) > 250000)
    throw Error("Workspace Desk exceeds 250000 bytes");
  return source;
}
