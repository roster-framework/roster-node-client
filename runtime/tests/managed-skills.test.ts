import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { once } from "node:events";
import { managedSkillCatalog, managedSkillsPrompt } from "../src/infrastructure/managed-skills.js";
import { ManagedAgent } from "@roster/contracts";
import { validateManagedAgentSkills } from "../src/infrastructure/managed-skills.js";
import { FileRuntimeStorage } from "../src/infrastructure/filesystem.js";
import { RosterRuntime } from "../src/application/runtime.js";
import { executeAgent } from "../src/infrastructure/langgraph-engine.js";
import { inspectMcp, managedImplementation } from "../src/infrastructure/langchain-managed.js";
import { createRuntimeApi } from "../src/interfaces/http.js";

test("managed skills load runtime-owned SKILL.md bodies and reject missing or oversized files", async () => {
  const previous = process.env.ROSTER_SKILLS_DIR;
  const root = await mkdtemp(join(tmpdir(), "roster-managed-skills-"));
  try {
    delete process.env.ROSTER_SKILLS_DIR;
    assert.match(await managedSkillsPrompt(["frontend"]), /본문 미설정/);
    assert.match(await managedSkillsPrompt(["Frontend Design"]), /Frontend Design/);
    assert.equal((await managedSkillCatalog()).mode, "references");
    process.env.ROSTER_SKILLS_DIR = root;
    await mkdir(join(root, "frontend"));
    await writeFile(join(root, "frontend", "SKILL.md"), "Review accessible interfaces.");
    assert.deepEqual((await managedSkillCatalog()).skills, [{ id: "frontend", ready: true }]);
    assert.match(await managedSkillsPrompt(["frontend"]), /Review accessible interfaces/);
    await assert.rejects(managedSkillsPrompt(["missing"]));
    const agent = ManagedAgent.parse({id:"agent",name:"Agent",kind:"llm",skills:["missing"]});
    await assert.rejects(validateManagedAgentSkills(agent));
    await validateManagedAgentSkills(agent, agent); // Existing settings can be edited while a file is repaired.
    await validateManagedAgentSkills({...agent,kind:"echo"});
    const storage = new FileRuntimeStorage(join(root, "state"), "skills-runtime");
    const runtime = new RosterRuntime("skills-runtime", [], storage, storage, storage,
      {execute: executeAgent}, {create: managedImplementation}, {inspect: inspectMcp});
    await runtime.initialize();
    const server = createRuntimeApi(runtime, "skill-test-token");
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
      const save = (skills: string[]) => fetch(base + "/admin/agents", {method:"PUT",headers:{Authorization:"Bearer skill-test-token","Content-Type":"application/json"},
        body:JSON.stringify({...agent,skills})});
      assert.equal((await save(["missing"])).status, 400);
      assert.equal((await storage.read()).managed_agents.length, 0);
      assert.equal((await save(["frontend"])).status, 200);
      assert.equal((await storage.read()).managed_agents[0]?.skills[0], "frontend");
      const preset = (skills: string[], name = "Template") => fetch(base + "/admin/agent-presets", {method:"PUT",headers:{Authorization:"Bearer skill-test-token","Content-Type":"application/json"},
        body:JSON.stringify({id:"template",name,agent:{...agent,skills}})});
      assert.equal((await preset(["missing"])).status, 400);
      assert.equal((await storage.read()).agent_presets?.length || 0, 0);
      assert.equal((await preset(["frontend"])).status, 200);
      await rm(join(root, "frontend", "SKILL.md"));
      assert.equal((await preset(["frontend"], "Renamed template")).status, 200);
    } finally {
      await runtime.close();
      await new Promise<void>(done => server.close(() => done()));
    }
    await assert.rejects(managedSkillsPrompt(["../escape"]));
    await assert.rejects(managedSkillsPrompt(["Frontend Design"]));
    await assert.rejects(managedSkillsPrompt(["frontend", "frontend"]));
    await writeFile(join(root, "frontend", "SKILL.md"), "x".repeat(30001));
    assert.deepEqual((await managedSkillCatalog()).skills, [{ id: "frontend", ready: false }]);
    await assert.rejects(managedSkillsPrompt(["frontend"]), /크기/);
    process.env.ROSTER_SKILLS_DIR = join(root, "missing");
    assert.match((await managedSkillCatalog()).error || "", /읽을 수/);
  } finally {
    if (previous === undefined) delete process.env.ROSTER_SKILLS_DIR;
    else process.env.ROSTER_SKILLS_DIR = previous;
    const absolute = resolve(root), temp = resolve(tmpdir()) + sep;
    if (absolute.startsWith(temp) && basename(absolute).startsWith("roster-managed-skills-"))
      await rm(absolute, { recursive: true, force: true });
  }
});
