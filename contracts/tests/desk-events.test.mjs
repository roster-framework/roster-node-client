import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatWorkspaceDesk,
  parseWorkspaceDesk,
  planWorkspaceDesk,
  applyWorkspaceDesk,
  exportWorkspaceDesk,
  DeskApplyError,
} from "../desk/index.mjs";
function fixture() {
  const view = {
    can_edit: true,
    owner: { id: "danny" },
    workspace: { id: "danny", name: "Danny", team_id: "product", version: 1 },
    placement_space: {
      workspace_id: "danny",
      enabled: true,
      member_ids: ["danny", "dev"],
      version: 1,
    },
    flows: [],
  };
  let events = {
    version: 2,
    owner_account_id: "secret-account",
    owner_member_id: "danny",
    workspace_id: "danny",
    definition: {
      version: 1,
      name: "Review",
      subscriptions: [
        {
          id: "start",
          on: "work.requested",
          target_member_id: "dev",
          owner_member_id: "danny",
          instruction: "Use design",
          resource_ids: ["design"],
          max_per_work: 3,
        },
        {
          id: "review",
          on: "complete",
          from_member_id: "dev",
          owner_member_id: "danny",
          board: {
            team: "product",
            title: "Review",
            complete_on_response: false,
          },
          max_per_work: 3,
        },
      ],
    },
  };
  const writes = [],
    reads = [];
  let fail = false,
    race = false;
  const api = async (path, method = "GET", body) => {
    if(path==='/core/work-creation-capabilities')return {version:1,mode:'local'};
    if (method === "GET") reads.push(path);
    else writes.push({ path, method, body: structuredClone(body) });
    if (path === "/state")
      return {
        members: [
          { id: "danny", kind: "human", state: "active", team: "product" },
          { id: "dev", kind: "agent", state: "active", team: "product" },
        ],
      };
    if (path === "/workspaces/danny/events") {
      if (method === "GET") {
        const result = structuredClone(events);
        if (race && reads.filter((p) => p === path).length >= 2)
          result.version++;
        return result;
      }
      if (fail) throw Error("Fixture event authority revoked");
      assert.equal(body.version, events.version);
      events = {
        ...events,
        version: events.version + 1,
        definition: structuredClone(body.definition),
      };
      return structuredClone(events);
    }
    if (path === "/workspaces/danny") {
      if (method === "PUT") {
        assert.equal(body.version, view.workspace.version);
        view.workspace.name = body.name;
        view.workspace.version++;
      }
      return structuredClone(view);
    }
    throw Error("Unexpected endpoint " + path);
  };
  return {
    api,
    writes,
    reads,
    fail: () => (fail = true),
    race: () => (race = true),
  };
}
test("event export is explicit, excludes authority and roundtrips without writes", async () => {
  const f = fixture();
  const legacy = await exportWorkspaceDesk(f.api, "danny");
  assert.equal(legacy.events, undefined);
  assert.ok(!f.reads.some((p) => p.endsWith("/events")));
  const exported = await exportWorkspaceDesk(f.api, "danny", { events: true });
  assert.ok(!JSON.stringify(exported).includes("secret-account"));
  assert.equal(
    exported.events.definition.subscriptions[0].owner_member_id,
    undefined,
  );
  const parsed = parseWorkspaceDesk(formatWorkspaceDesk(exported));
  assert.deepEqual(parsed, exported);
  assert.equal((await planWorkspaceDesk(f.api, parsed)).eventPlan.write, false);
  await applyWorkspaceDesk(f.api, parsed);
  assert.deepEqual(f.writes, []);
});
test("stale event file and unplaced participant fail read-only before workspace change", async () => {
  for (const kind of ["version", "placement"]) {
    const f = fixture(),
      desk = await exportWorkspaceDesk(f.api, "danny", { events: true });
    desk.workspace.name = "Edited";
    if (kind === "version") desk.events.version--;
    else desk.events.definition.subscriptions[0].target_member_id = "outsider";
    await assert.rejects(
      applyWorkspaceDesk(f.api, desk),
      /version conflict|not placed/,
    );
    assert.deepEqual(f.writes, []);
  }
});
test("event edit uses its own version, preserves delivery fields and resolves owner only", async () => {
  const f = fixture(),
    desk = await exportWorkspaceDesk(f.api, "danny", { events: true });
  desk.events.definition.name = "Changed";
  const rule = desk.events.definition.subscriptions[1];
  rule.from_member_id = "$owner";
  rule.priority = 2;
  rule.delay_seconds = 60;
  const plan = await planWorkspaceDesk(f.api, desk);
  assert.equal(plan.eventPlan.write, true);
  assert.deepEqual(f.writes, []);
  const saved = await applyWorkspaceDesk(f.api, desk);
  assert.equal(saved.events.version, 3);
  assert.equal(saved.workspace.version, 1);
  assert.equal(
    saved.events.definition.subscriptions[0].instruction,
    "Use design",
  );
  assert.deepEqual(saved.events.definition.subscriptions[0].resource_ids, [
    "design",
  ]);
  assert.equal(
    saved.events.definition.subscriptions[1].from_member_id,
    "$owner",
  );
  assert.equal(saved.events.definition.subscriptions[1].priority, 2);
  assert.equal(f.writes.length, 1);
  assert.equal(
    f.writes[0].body.definition.subscriptions[1].from_member_id,
    "danny",
  );
  assert.ok(!JSON.stringify(f.writes).includes("owner_account_id"));
});
test("partial event authority failure preserves earlier writes and supports current recovery export", async () => {
  const f = fixture(),
    desk = await exportWorkspaceDesk(f.api, "danny", { events: true });
  desk.workspace.name = "Edited";
  desk.events.definition.name = "New";
  f.fail();
  await assert.rejects(
    applyWorkspaceDesk(f.api, desk),
    (e) =>
      e instanceof DeskApplyError &&
      e.phase === "event flow" &&
      e.owner === "danny" &&
      e.completed.includes("workspace"),
  );
  const recovery = await exportWorkspaceDesk(f.api, "danny", { events: true });
  assert.equal(recovery.workspace.name, "Edited");
  assert.equal(recovery.workspace.version, 2);
  assert.equal(recovery.events.version, 2);
  assert.equal(recovery.events.definition.name, "Review");
  assert.ok(!f.writes.some((v) => v.path === "/works"));
});
test("event export rejects concurrent edits and file rejects hidden authority and addresses", async () => {
  const f = fixture();
  f.race();
  await assert.rejects(
    exportWorkspaceDesk(f.api, "danny", { events: true }),
    /Events changed/,
  );
  for (const [key, value] of [
    ["owner_member_id", "danny"],
    ["target", { runtime_id: "run", agent_id: "dev" }],
    ["source_id", "foreign"],
    ["credentials", "secret"],
  ]) {
    const fresh = fixture(),
      desk = await exportWorkspaceDesk(fresh.api, "danny", { events: true });
    desk.events.definition.subscriptions[0][key] = value;
    assert.throws(
      () => formatWorkspaceDesk(desk),
      /Invalid event subscription/,
    );
  }
});
