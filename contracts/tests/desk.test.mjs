import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseWorkspaceDesk,
  formatWorkspaceDesk,
  planWorkspaceDesk,
  applyWorkspaceDesk,
  exportWorkspaceDesk,
  DeskApplyError,
} from "../desk/index.mjs";
const member = {
  id: "danny",
  name: "Danny",
  team: "product",
  kind: "human",
  state: "active",
};
const grant = {
  subject_member_id: "danny",
  target: { kind: "member", id: "other" },
  actions: ["workspace.read"],
};
const binding = {
  id: "code",
  server_id: "local",
  resource_id: "repository",
  unit_id: "product",
  collection: "code",
  route: "proxy",
  version: 1,
};
const file = () => ({
  schema: "roster/desk/v2",
  owner: { member_id: "danny" },
  workspace: { name: "Danny desk", team_id: "product", version: 0 },
  space: { enabled: true, member_ids: ["$owner", "dev"], version: 0 },
  flows: [
    {
      id: "release",
      name: "Release",
      version: 0,
      default: true,
      steps: [
        { kind: "member", member_id: "dev", accept: ["success"] },
        { kind: "review", member_id: "$owner" },
      ],
    },
  ],
  resources: {
    bindings: [
      {
        id: "code",
        server_id: "local",
        resource_id: "repository",
        version: 1,
        actions: ["resource.read"],
      },
    ],
    expected_grants: [grant],
  },
  text: "",
});

test('Desk preserves step deadlines and rejects unsupported reference limits', () => {
  const desk=file();desk.flows[0].steps[0].timeout_seconds=5;
  assert.equal(parseWorkspaceDesk(formatWorkspaceDesk(desk)).flows[0].steps[0].timeout_seconds,5);
  for(const timeout of [-1,601,0.5]) {desk.flows[0].steps[0].timeout_seconds=timeout;assert.throws(()=>formatWorkspaceDesk(desk));}
  desk.flows[0].steps[0].timeout_seconds=0;desk.flows[0].steps[1].timeout_seconds=5;
  assert.throws(()=>formatWorkspaceDesk(desk));
});
function fixture() {
  const state = {
    units: [{ id: "product" }],
    members: [
      member,
      { id: "dev", team: "product", state: "active", kind: "agent" },
    ],
  };
  let workspace = {
      id: "danny",
      team_id: "product",
      name: "Danny",
      version: 0,
    },
    space = {
      workspace_id: "danny",
      enabled: false,
      member_ids: [],
      version: 0,
    },
    grants = [grant],
    flows = [];
  const writes = [];
  let failure = "";
  const api = async (path, method = "GET", body) => {
    if(path==='/core/work-creation-capabilities')return {version:1,mode:'local'};
    if (method !== "GET") {
      writes.push({ path, body });
      if (path === failure) throw Error("backend stopped");
    }
    if (path === "/state") return structuredClone(state);
    if (path === "/core/resource-registry")
      return { bindings: [binding], server_ids: ["local"] };
    if (path === "/access/members/danny") {
      if (method === "PUT") {
        assert.deepEqual(body.expected_grants, grants);
        grants = structuredClone(body.grants);
      }
      return { grants: structuredClone(grants) };
    }
    if (path === "/workspaces/danny") {
      if (method === "PUT") {
        assert.equal(body.version, workspace.version);
        workspace = {
          ...workspace,
          name: body.name.trim(),
          version: workspace.version + 1,
        };
      }
      return {
        workspace: structuredClone(workspace),
        owner: member,
        can_edit: true,
        placement_space: structuredClone(space),
        flows: flows.map(
          ({ steps, unit_id, workspace_id, ...summary }) => summary,
        ),
      };
    }
    if (path === "/workspaces/danny/space") {
      assert.equal(body.version, space.version);
      space = {
        ...space,
        ...structuredClone(body),
        version: space.version + 1,
      };
      return space;
    }
    if (path === "/workspaces/danny/flows") {
      const old = flows.find((f) => f.id === body.id);
      assert.equal(body.version, old?.version ?? 0);
      if (body.default)
        flows.forEach((f) => {
          if (f.default && f.id !== body.id) {
            f.default = false;
            f.version++;
          }
        });
      flows = flows.filter((f) => f.id !== body.id);
      flows.push({ ...structuredClone(body), version: body.version + 1 });
      return flows.at(-1);
    }
    if (path.startsWith("/workspaces/danny/flows/"))
      return structuredClone(
        flows.find((f) => f.id === path.split("/").at(-1)),
      );
    throw Error("Unexpected request " + path);
  };
  return {
    api,
    writes,
    state,
    fail: (path) => (failure = path),
    get grants() {
      return grants;
    },
    get flows() {
      return flows;
    },
  };
}
test("v2 strict roundtrip rejects secrets, oversized files, owner ambiguity and hidden instructions", () => {
  assert.deepEqual(parseWorkspaceDesk(formatWorkspaceDesk(file())), file());
  for (const change of [
    (d) => (d.url = "https://secret"),
    (d) => (d.workspace.token = "secret"),
    (d) => (d.owner.agent = {}),
    (d) => (d.text = "Hidden human instructions"),
    (d) => d.space.member_ids.push("dev"),
    (d) => (d.resources.bindings[0].credential = "secret"),
    (d) => (d.flows[0].steps[0].endpoint = "hidden"),
  ]) {
    const d = file();
    change(d);
    assert.throws(() => formatWorkspaceDesk(d));
  }
  assert.throws(() => parseWorkspaceDesk("x".repeat(250001)));
});
test('parallel Desk apply/export preserves owner references and no-op without flattening', async () => {
  const f=fixture(), desk=file();
  f.state.members.push({id:'qa',team:'product',kind:'agent',state:'active'});
  desk.space.member_ids.push('qa');
  desk.flows[0].steps=[{kind:'parallel',parallel:{mode:'all',members:[{member_id:'dev',accept:['success'],instruction:'Develop',timeout_seconds:5},{member_id:'qa',accept:['success'],instruction:'Check'}]}},{kind:'member',member_id:'$owner'}];
  const saved=await applyWorkspaceDesk(f.api,desk), count=f.writes.length;
  assert.deepEqual(saved.flows[0].steps,desk.flows[0].steps);
  assert.deepEqual(await exportWorkspaceDesk(f.api,'danny',{resources:true}),saved);
  await applyWorkspaceDesk(f.api,saved); assert.equal(f.writes.length,count);
});
test("human preview is read-only; apply uses existing commands, preserves unrelated grants and has no-op export", async () => {
  const f = fixture(),
    preview = await planWorkspaceDesk(f.api, file());
  assert.equal(preview.writeWorkspace, true);
  assert.equal(f.writes.length, 0);
  const saved = await applyWorkspaceDesk(f.api, file());
  assert.equal(saved.schema, "roster/desk/v2");
  assert.equal(saved.space.member_ids[0], "$owner");
  assert.equal(saved.flows[0].steps[1].member_id, "$owner");
  assert.equal(saved.flows[0].version, 1);
  assert.deepEqual(f.grants[0], grant);
  assert.equal(f.writes.length, 4);
  assert.deepEqual(
    await exportWorkspaceDesk(f.api, "danny", { resources: true }),
    saved,
  );
  const count = f.writes.length;
  await applyWorkspaceDesk(f.api, saved);
  assert.equal(f.writes.length, count);
  saved.resources.bindings = [];
  await applyWorkspaceDesk(f.api, saved);
  assert.deepEqual(f.grants, [grant]);
});
test("each stale version, binding and grant snapshot fails before writes", async () => {
  for (const mutate of [
    (d) => (d.workspace.version = 1),
    (d) => (d.space.version = 1),
    (d) => (d.flows[0].version = 1),
    (d) => (d.resources.expected_grants = []),
    (d) => (d.resources.bindings[0].resource_id = "changed"),
    (d) => (d.resources.bindings[0].version = 2),
    (d) => (d.space.member_ids = ["missing"]),
    (d) => (d.flows[0].steps[0].member_id = "other"),
  ]) {
    const f = fixture(),
      d = file();
    mutate(d);
    await assert.rejects(applyWorkspaceDesk(f.api, d));
    assert.equal(f.writes.length, 0);
  }
});
test("resource permission inclusion fails closed without admin and does not block resource-free owner files", async () => {
  const f = fixture();
  const api = (path, ...rest) => {
    if (path === "/core/resource-registry") throw Error("Forbidden");
    return f.api(path, ...rest);
  };
  await assert.rejects(applyWorkspaceDesk(api, file()), /Forbidden/);
  assert.equal(f.writes.length, 0);
  const d = file();
  delete d.resources;
  assert.equal((await applyWorkspaceDesk(api, d)).owner.member_id, "danny");
});
test("export preserves split grant order on no-op and resource edits preserve unrelated actions on the same selector", async () => {
  const f = fixture(),
    mixed = [
      grant,
      {
        subject_member_id: "danny",
        target: { kind: "resource", id: "code" },
        actions: ["resource.read", "session.read", "session.correct"],
      },
      {
        subject_member_id: "danny",
        target: { kind: "resource", id: "code" },
        actions: ["resource.use"],
      },
    ];
  await f.api("/access/members/danny", "PUT", {
    expected_grants: [grant],
    grants: mixed,
  });
  const d = await exportWorkspaceDesk(f.api, "danny", { resources: true }),
    count = f.writes.length;
  await applyWorkspaceDesk(f.api, d);
  assert.equal(f.writes.length, count);
  assert.deepEqual(f.grants, mixed);
  d.resources.bindings = [];
  await applyWorkspaceDesk(f.api, d);
  assert.deepEqual(f.grants, [
    grant,
    { ...mixed[1], actions: ["session.read", "session.correct"] },
  ]);
});
test("partial failure exposes phase, completed steps and recovery export, never rollback or execute", async () => {
  const f = fixture();
  f.fail("/workspaces/danny/space");
  await assert.rejects(
    applyWorkspaceDesk(f.api, file()),
    (e) =>
      e instanceof DeskApplyError &&
      e.phase === "placement space" &&
      e.completed.join(",") === "workspace",
  );
  const current = await exportWorkspaceDesk(f.api, "danny");
  assert.equal(current.workspace.name, "Danny desk");
  assert.equal(current.space.enabled, false);
  assert.equal(f.writes.length, 2);
  f.fail("");
  const desired = file();
  desired.workspace.version = current.workspace.version;
  await applyWorkspaceDesk(f.api, desired);
  assert.ok(f.writes.every((w) => !/^\/works(?:\/|$)/.test(w.path)));
});
test("default change and dependency ordering account for only own version changes; alias cycles reject", async () => {
  const f = fixture();
  let saved = await applyWorkspaceDesk(f.api, file());
  saved.flows.push({
    id: "inner",
    name: "Inner",
    version: 0,
    default: true,
    steps: [{ kind: "member", member_id: "dev", accept: ["success"] }],
  });
  saved.flows[0].default = false;
  saved.flows[0].steps = [{ kind: "flow", flow_id: "inner" }];
  saved = await applyWorkspaceDesk(f.api, saved);
  assert.equal(saved.flows.find((f) => f.id === "inner").default, true);
  assert.equal(saved.flows.find((f) => f.id === "release").default, false);
  const count = f.writes.length;
  await applyWorkspaceDesk(f.api, saved);
  assert.equal(f.writes.length, count);
  saved.flows.find((f) => f.id === "inner").steps = [
    { kind: "flow", flow_id: "release" },
  ];
  await assert.rejects(planWorkspaceDesk(f.api, saved), /cycle/);
  assert.equal(f.writes.length, count);
});
test("new managed agent preserves preset and reports a recoverable member after an instruction failure", async () => {
  const f = fixture();
  f.state.members = f.state.members.filter((m) => m.id !== "danny");
  const settings = {
    manifest: { agents: [] },
    managed_agents: [],
    mcp_connections: [],
    agent_presets: [
      {
        id: "developer",
        agent: {
          id: "template",
          name: "Template",
          kind: "echo",
          instructions: "Runtime rules",
          skills: ["testing"],
          statuses: ["success"],
          mcp_ids: [],
          tool_approval: { mode: "all" },
        },
      },
    ],
  };
  let instructions = { text: "", version: 0 },
    fail = true,
    creations = 0;
  const api = async (path, method = "GET", body) => {
    if (path === "/agents/runtime/front" || path === '/runtimes/runtime/admin' || path === '/runtimes/runtime/manage/agents') {
      if (method === "PUT") {
        settings.managed_agents = [
          { ...body, version: (settings.managed_agents[0]?.version ?? 0) + 1 },
        ];
      }
      return structuredClone(settings);
    }
    if (path === "/members") {
      creations++;
      f.state.members.push({
        id: "danny",
        kind: "agent",
        state: "active",
        name: "Front",
        ...body,
      });
      return {};
    }
    if (path.endsWith("/instructions")) {
      if (method === "PUT") {
        if (fail) throw Error("instruction server unavailable");
        assert.equal(body.version, instructions.version);
        instructions = { text: body.text, version: instructions.version + 1 };
      }
      return structuredClone(instructions);
    }
    return f.api(path, method, body);
  };
  const d = {
    schema: "roster/desk/v2",
    owner: {
      agent: {
        runtime_id: "runtime",
        agent_id: "front",
        team: "product",
        preset: "developer",
        name: "Front",
        version: 0,
        agent_version: 0,
        mcp_ids: [],
      },
    },
    workspace: { name: "Front workspace", team_id: "product", version: 0 },
    text: "Core rules",
  };
  assert.equal((await planWorkspaceDesk(api, d)).agent.createMember, true);
  await assert.rejects(
    applyWorkspaceDesk(api, d),
    (e) =>
      e instanceof DeskApplyError &&
      e.owner === "danny" &&
      e.phase === "core instructions" &&
      e.completed.join(",") === "agent settings,member binding",
  );
  const recovery = await exportWorkspaceDesk(api, "danny", { agent: true });
  assert.equal(recovery.owner.agent.agent_version, 1);
  assert.equal(recovery.owner.agent.version, 0);
  assert.equal(settings.managed_agents[0].instructions, "Runtime rules");
  assert.deepEqual(settings.managed_agents[0].skills, ["testing"]);
  assert.deepEqual(settings.managed_agents[0].tool_approval, { mode: "all" });
  fail = false;
  const saved = await applyWorkspaceDesk(api, {
    ...recovery,
    text: "Core rules",
  });
  assert.equal(saved.owner.agent.version, 1);
  assert.equal(creations, 1);
});
test("an unchanged export remains a no-op when saved flows survive a disabled or reduced placement", async () => {
  const f = fixture(),
    d = await applyWorkspaceDesk(f.api, file());
  await f.api("/workspaces/danny/space", "PUT", {
    enabled: false,
    member_ids: [],
    version: d.space.version,
  });
  const disabled = await exportWorkspaceDesk(f.api, "danny"),
    count = f.writes.length;
  await applyWorkspaceDesk(f.api, disabled);
  assert.equal(f.writes.length, count);
  disabled.flows[0].name = "Changed";
  await assert.rejects(
    applyWorkspaceDesk(f.api, disabled),
    /enabled placement/,
  );
  assert.equal(f.writes.length, count);
});
