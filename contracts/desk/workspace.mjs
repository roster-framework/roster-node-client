import { planDesk, applyDesk, exportDesk } from "./agent.mjs";
import { validateWorkspaceDesk, resourceActions } from "./workspace-format.mjs";
import { equal, id } from "./value.mjs";
import { portableEvents, eventCommand } from "./events.mjs";
import {deskWorkMode,deskWorkspaceOverview,pinnedDeskRevision,deskFlowDefinition,deskWorkWrite,deskWorkCommandID,deskWorkSize} from './work-boundary.mjs';
const pathFor = (member) => "/workspaces/" + member;
const agentDesk = (desk) => ({
  ...desk.owner.agent,
  schema: "roster/desk/v1",
  text: desk.text,
});
const ownerRef = (value, owner) => (value === "$owner" ? owner : value);
const mapSteps = (steps, reference) =>
  steps.map((step) => ({
    ...step,
    ...(step.member_id ? { member_id: reference(step.member_id) } : {}),
    ...(step.parallel?{parallel:{...step.parallel,members:step.parallel.members.map(member=>({...member,member_id:reference(member.member_id)}))}}:{}),
    ...(step.allowed_members
      ? {
          allowed_members: step.allowed_members.map((value) =>
            reference(value),
          ),
        }
      : {}),
  }));
const stepsFor=(steps,owner)=>mapSteps(steps,value=>ownerRef(value,owner));
const fileFlow = (flow, owner) => ({
  id: flow.id,
  name: flow.name,
  version: flow.version,
  default: flow.default,
  steps: mapSteps(flow.steps,value=>value===owner?'$owner':value),
});
const flowValue = (flow, owner, team) => ({
  ...flow,
  steps: stepsFor(flow.steps, owner),
  unit_id: team,
  workspace_id: owner,
});
const sameSpace = (a, b) =>
  a.enabled === b.enabled && equal(a.member_ids, b.member_ids);
function orderedFlows(flows) {
  const byId = new Map(flows.map((f) => [f.id, f])),
    visiting = new Set(),
    done = new Set(),
    result = [];
  function visit(flow) {
    if (done.has(flow.id)) return;
    if (visiting.has(flow.id))
      throw Error("Workspace flow aliases contain a cycle");
    visiting.add(flow.id);
    for (const step of flow.steps)
      if (step.kind === "flow" && byId.has(step.flow_id))
        visit(byId.get(step.flow_id));
    visiting.delete(flow.id);
    done.add(flow.id);
    result.push(flow);
  }
  flows.filter((f) => !f.default).forEach(visit);
  flows.filter((f) => f.default).forEach(visit);
  return result;
}
function resourceReplacement(resources, owner, current, registry) {
  if (!equal(current, resources.expected_grants))
    throw Error("Desk permissions conflict; export current Desk first");
  if (current.some((grant) => grant.subject_member_id !== owner))
    throw Error("Grant subject does not match owner");
  for (const ref of resources.bindings) {
    const binding = registry.bindings.find((b) => b.id === ref.id);
    if (
      !binding ||
      binding.server_id !== ref.server_id ||
      binding.resource_id !== ref.resource_id ||
      binding.version !== ref.version
    )
      throw Error("Desk resource binding conflict; export current Desk first");
  }
  // A Desk controls only direct resource selectors, never other/inherited access.
  const direct = (grants) => {
    const byId = new Map();
    for (const grant of grants)
      if (grant.target.kind === "resource")
        for (const action of grant.actions)
          if (resourceActions.includes(action)) {
            if (!byId.has(grant.target.id))
              byId.set(grant.target.id, new Set());
            byId.get(grant.target.id).add(action);
          }
    return [...byId]
      .map(([key, values]) => [key, [...values].sort()])
      .sort((a, b) => a[0].localeCompare(b[0]));
  };
  const requested = resources.bindings.map((ref) => ({
    target: { kind: "resource", id: ref.id },
    actions: ref.actions,
  }));
  if (equal(direct(current), direct(requested))) return current;
  const kept = current.flatMap((grant) => {
    if (grant.target.kind !== "resource") return [grant];
    const actions = grant.actions.filter(
      (action) => !resourceActions.includes(action),
    );
    return actions.length ? [{ ...grant, actions }] : [];
  });
  return [
    ...kept,
    ...resources.bindings.map((ref) => ({
      subject_member_id: owner,
      target: { kind: "resource", id: ref.id },
      actions: [...ref.actions],
    })),
  ];
}
export async function planWorkspaceDesk(api, input) {
  const desk = validateWorkspaceDesk(structuredClone(input));
  const workMode = await deskWorkMode(api);
  pinnedDeskRevision(desk,workMode);
  const state = await api("/state");
  const agent = desk.owner.agent
    ? await planDesk(api, agentDesk(desk))
    : undefined;
  const member =
    agent?.member ||
    (desk.owner.member_id
      ? state.members.find((m) => m.id === desk.owner.member_id)
      : undefined);
  if (
    (!member && !agent?.createMember) ||
    (member?.state && member.state !== "active")
  )
    throw Error("Active workspace owner required");
  const owner = member?.id ?? "$owner";
  const current = member ? await deskWorkspaceOverview(api,owner,workMode,desk.work_revision) : undefined;
  if (current && !current.can_edit) throw Error("Workspace editing forbidden");
  if (
    desk.workspace.team_id !==
    (current?.workspace.team_id ?? desk.owner.agent?.team)
  )
    throw Error("Workspace team binding changed");
  if (desk.workspace.version !== (current?.workspace.version ?? 0))
    throw Error("Desk workspace version conflict; export current Desk first");
  const space = desk.space
    ? {
        ...desk.space,
        member_ids: desk.space.member_ids.map((value) =>
          ownerRef(value, owner),
        ),
      }
    : undefined;
  if (space && space.version !== (current?.placement_space.version ?? 0))
    throw Error("Desk placement version conflict; export current Desk first");
  for (const value of space?.member_ids ?? [])
    if (
      value !== owner &&
      !state.members.some((m) => m.id === value && m.state === "active")
    )
      throw Error("Placement member unavailable");
  const effectiveSpace = space ?? current?.placement_space;
  const flows = orderedFlows(desk.flows ?? []);
  const flowPlans = [];
  for (const flow of flows) {
    const old = current?.flows.find((f) => f.id === flow.id);
    if (flow.version !== (old?.version ?? 0))
      throw Error("Desk flow version conflict: " + flow.id);
    const before = old
      ? await deskFlowDefinition(api,owner,desk.workspace.team_id,old,workMode,current.work_revision)
      : undefined;
    if (before && before.version !== flow.version)
      throw Error("Desk flow version conflict: " + flow.id);
    const desired = flowValue(flow, owner, desk.workspace.team_id);
    if(workMode==='independent')deskWorkSize(desired);
    const write = !equal(before, desired);
    if (write && !effectiveSpace?.enabled)
      throw Error("Flow changes require an enabled placement space");
    for (const step of write ? desired.steps : []) {
      for (const value of [
        step.member_id,
        ...(step.allowed_members ?? []),
        ...(step.parallel?.members.map(member=>member.member_id)??[]),
      ].filter(Boolean))
        if (!effectiveSpace.member_ids.includes(value))
          throw Error("Flow participant is not placed: " + flow.id);
    }
    flowPlans.push({ desired, before, write });
  }
  let resourcePlan;
  if (desk.resources) {
    const registry = await api("/core/resource-registry"); // Existing admin-only use case.
    const grants = member
      ? ((await api("/access/members/" + owner)).grants ?? [])
      : [];
    const desired = resourceReplacement(
      desk.resources,
      owner,
      grants,
      registry,
    );
    resourcePlan = {
      desired,
      expected: grants,
      write: !equal(grants, desired),
    };
  }
  let eventPlan;
  if (desk.events) {
    const before = member ? await api(pathFor(owner) + "/events") : undefined;
    if (desk.events.version !== (before?.version ?? 0))
      throw Error("Desk events version conflict; export current Desk first");
    const desired = eventCommand(portableEvents(desk.events, owner), owner);
    if(workMode==='independent')deskWorkSize(desired);
    const write =
      !before ||
      !equal(portableEvents(before, owner), portableEvents(desired, owner));
    if (write && !effectiveSpace?.enabled)
      throw Error("Event changes require an enabled placement space");
    for (const rule of write ? desired.definition.subscriptions : []) {
      for (const value of [rule.from_member_id, rule.target_member_id].filter(
        Boolean,
      ))
        if (!effectiveSpace.member_ids.includes(value))
          throw Error("Event participant is not placed: " + rule.id);
      if (rule.board && rule.board.team !== desk.workspace.team_id)
        throw Error("Event board belongs to another team");
      for (const resource of rule.resource_ids || [])
        if (
          desk.resources &&
          !desk.resources.bindings.some((ref) => ref.id === resource)
        )
          throw Error("Event resource is absent from Desk permissions");
    }
    eventPlan = { desired, write };
  }
  return {
    workMode,
    desk,
    owner,
    agent,
    current,
    space,
    flows: flowPlans,
    resourcePlan,
    eventPlan,
    writeWorkspace: desk.workspace.name.trim() !== current?.workspace.name,
    writeSpace:
      !!space &&
      !sameSpace(
        space,
        current?.placement_space ?? { enabled: false, member_ids: [] },
      ),
  };
}
export class DeskApplyError extends Error {
  constructor(phase, completed, cause, owner) {
    super(
      "Desk stopped at " +
        phase +
        ". Earlier steps may have succeeded; export current settings before retrying.",
    );
    this.name = "DeskApplyError";
    this.phase = phase;
    this.completed = [...completed];
    this.owner = owner;
    this.cause = cause;
  }
}
export async function applyWorkspaceDesk(api, desk) {
  const plan = await planWorkspaceDesk(api, desk),
    completed = [];
  let phase = "agent settings",
    owner = plan.owner;
  try {
    if (plan.agent) {
      const saved = await applyDesk(api, agentDesk(desk));
      owner = saved.member_id;
      completed.push("agent settings and core instructions");
    }
    phase = "workspace";
    // An intervening first materialization must not be hidden by a fresh read.
    let current = await api(pathFor(owner));
    pinnedDeskRevision(desk,plan.workMode,current);
    if (
      current.workspace.version !== desk.workspace.version ||
      current.workspace.team_id !== desk.workspace.team_id
    )
      throw Error("Workspace conflict");
    if (plan.writeWorkspace) {
      await api(pathFor(owner), "PUT", {
        name: desk.workspace.name,
        version: desk.workspace.version,
      });
      completed.push(phase);
    }
    phase = "placement space";
    if (plan.writeSpace) {
      await api(pathFor(owner) + "/space", "PUT", {
        ...plan.space,
        member_ids: plan.space.member_ids.map((v) => ownerRef(v, owner)),
      });
      completed.push(phase);
    }
    const defaults = new Map(
      (plan.current?.flows ?? []).map((f) => [
        f.id,
        { version: f.version, default: f.default },
      ]),
    );
    let workRevision=desk.work_revision;
    for (const entry of plan.flows) {
      phase = "flow " + entry.desired.id;
      if (!entry.write) continue;
      const desired = flowValue(entry.desired, owner, desk.workspace.team_id);
      // Setting a default can increment another listed flow's version. Only
      // our own predictable transition is accounted for; server CAS remains.
      desired.version = defaults.get(desired.id)?.version ?? desired.version;
      if(plan.workMode==='independent') {
        const receipt=await deskWorkWrite(api,{version:1,id:deskWorkCommandID(),expected_revision:workRevision,flow:desired});
        workRevision=receipt.work_revision;
      } else await api(pathFor(owner) + "/flows", "PUT", desired);
      completed.push(phase);
      if (desired.default)
        for (const [key, value] of defaults)
          if (key !== desired.id && value.default)
            defaults.set(key, { default: false, version: value.version + 1 });
      defaults.set(desired.id, {
        default: desired.default,
        version: desired.version + 1,
      });
    }
    phase = "resource permissions";
    if (plan.resourcePlan?.write) {
      const registry = await api("/core/resource-registry"),
        expected = (await api("/access/members/" + owner)).grants ?? [];
      const desired = resourceReplacement(
        desk.resources,
        owner,
        expected,
        registry,
      );
      await api("/access/members/" + owner, "PUT", {
        grants: desired,
        expected_grants: expected,
      });
      completed.push(phase);
    }
    if (plan.eventPlan?.write) {
      phase = "event flow";
      if(plan.workMode==='independent') {
        const value=eventCommand(plan.eventPlan.desired,owner);
        const receipt=await deskWorkWrite(api,{version:1,id:deskWorkCommandID(),expected_revision:workRevision,expected_workspace_version:value.version,
          unit_id:desk.workspace.team_id,workspace_id:owner,definition:value.definition},true);
        workRevision=receipt.work_revision;
      } else await api(
        pathFor(owner) + "/events",
        "PUT",
        eventCommand(plan.eventPlan.desired, owner),
      );
      completed.push(phase);
    }
    phase = "current export";
    return await exportWorkspaceDesk(api, owner, {
      agent: !!desk.owner.agent,
      resources: !!desk.resources,
      events: !!desk.events,
    });
  } catch (cause) {
    if (plan.agent && phase === "agent settings") {
      phase = cause.phase ?? phase;
      completed.push(...(cause.completed ?? []));
      try {
        const state = await api("/state"),
          matches = state.members.filter(
            (m) =>
              m.kind !== "human" &&
              m.runtime_id === desk.owner.agent.runtime_id &&
              m.agent_id === desk.owner.agent.agent_id,
          );
        if (matches.length === 1) owner = matches[0].id;
      } catch {} // Keep the original failure even if recovery lookup is offline.
    }
    throw new DeskApplyError(phase, completed, cause, owner);
  }
}
export async function exportWorkspaceDesk(api, member, options = {}) {
  id(member, "workspace owner");
  const workMode=await deskWorkMode(api);
  const view = await deskWorkspaceOverview(api,member,workMode);
  if (!view.can_edit) throw Error("Workspace editing forbidden");
  const owner = view.owner.id;
  let ownerDefinition = { member_id: owner },
    instructions = "";
  if (options.agent) {
    const state = await api("/state"),
      m = state.members.find((item) => item.id === owner);
    if (!m || m.kind === "human" || !m.runtime_id || !m.agent_id)
      throw Error("Managed agent owner required");
    const { schema, text, ...agent } = await exportDesk(
      api,
      m.runtime_id,
      m.agent_id,
    );
    ownerDefinition = { agent };
    instructions = text;
  }
  const flows = [];
  for (const summary of view.flows) {
    const flow = await deskFlowDefinition(api,owner,view.workspace.team_id,summary,workMode,view.work_revision);
    if (flow.version !== summary.version)
      throw Error("Workspace changed during export; retry");
    flows.push(fileFlow(flow, owner));
  }
  const desk = {
    schema: "roster/desk/v2",
    ...(workMode==='independent'?{work_revision:view.work_revision}:{}),
    owner: ownerDefinition,
    workspace: {
      name: view.workspace.name,
      team_id: view.workspace.team_id,
      version: view.workspace.version,
    },
    space: {
      enabled: view.placement_space.enabled,
      member_ids: view.placement_space.member_ids.map((v) =>
        v === owner ? "$owner" : v,
      ),
      version: view.placement_space.version,
    },
    flows,
    text: instructions,
  };
  if (options.resources) {
    const registry = await api("/core/resource-registry"),
      expected_grants = (await api("/access/members/" + owner)).grants ?? [],
      bindings = [];
    for (const grant of expected_grants)
      if (
        grant.target.kind === "resource" &&
        grant.actions.some((a) => resourceActions.includes(a))
      ) {
        const ref = registry.bindings.find((b) => b.id === grant.target.id);
        if (!ref) throw Error("Registered resource binding unavailable");
        let binding = bindings.find((b) => b.id === ref.id);
        if (!binding) {
          binding = {
            id: ref.id,
            server_id: ref.server_id,
            resource_id: ref.resource_id,
            version: ref.version,
            actions: [],
          };
          bindings.push(binding);
        }
        for (const action of grant.actions)
          if (
            resourceActions.includes(action) &&
            !binding.actions.includes(action)
          )
            binding.actions.push(action);
      }
    desk.resources = { bindings, expected_grants };
  }
  // Detect component edits while assembling a multi-endpoint export.
  if (options.events)
    desk.events = portableEvents(await api(pathFor(owner) + "/events"), owner);
  const latest = await deskWorkspaceOverview(api,owner,workMode,view.work_revision);
  if (
    !equal(view.workspace, latest.workspace) ||
    !equal(view.placement_space, latest.placement_space) ||
    !equal(view.flows, latest.flows)
  )
    throw Error("Workspace changed during export; retry");
  if (options.events) {
    const latestEvents = portableEvents(
      await api(pathFor(owner) + "/events"),
      owner,
    );
    if (!equal(desk.events, latestEvents))
      throw Error("Events changed during export; retry");
  }
  return validateWorkspaceDesk(desk);
}
