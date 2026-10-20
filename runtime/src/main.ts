import { SqliteRuntimeOwnership } from './infrastructure/sqlite-runtime-ownership.js';
import { ToolApprovals } from "./application/tool-approvals.js";
import { FileApprovalRepository } from "./infrastructure/approval-files.js";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RosterRuntime } from "./application/runtime.js";
import { FileRuntimeStorage } from "./infrastructure/filesystem.js";
import { executeAgent } from "./infrastructure/langgraph-engine.js";
import {
  managedImplementation,
  inspectMcp,
  validateManagedConfiguration,
} from "./infrastructure/langchain-managed.js";
import { createRuntimeApi } from "./interfaces/http.js";
import type { AgentModule } from "./agent.js";
import { ConsoleStreamCapture } from "./infrastructure/console-stream.js";
import { SqliteSessionJournal } from "./infrastructure/sqlite-session-journal.js";
import { JournalRetention } from "./application/session-retention.js";
import { sessionRetentionConfig } from "./infrastructure/session-retention-config.js";
import { startSessionRetention } from "./infrastructure/session-retention-timer.js";
import {FileModelCredentials} from './infrastructure/model-credentials.js';
import {LocalPythonAgentWorker} from './infrastructure/python-agent-worker.js';
import { JsonSchemaAgentParameters } from './infrastructure/agent-parameters.js';
import {RuntimeAgentCreation} from './application/agent-creation.js';
import {authorCreationSources} from './infrastructure/agent-creation-sources.js';
import {managedCreationSources} from './infrastructure/managed-creation-sources.js';
import { createAgentTemplates as codexTemplates } from '../presets/codex/agent.mjs';
import { createAgentTemplates as delegatingCodexTemplates } from '../presets/codex/delegating.mjs';
import { createAgentTemplates as collaboratingCodexTemplates } from '../presets/codex/collaborating.mjs';
import { createAgentTemplates as claudeTemplates } from '../presets/claude-code/agent.mjs';
import { HostLocalCliDiscovery } from './infrastructure/local-cli-discovery.js';
import { FileLocalToolPolicy } from './infrastructure/local-tool-policy-file.js';
import {FileCoreTrust} from './infrastructure/core-trust-file.js';
import {HttpCoreExecutionAuthority} from './infrastructure/core-execution-authority.js';
import {McpConnections} from './application/mcp-connections.js';
import {FileMcpIdentityFingerprint} from './infrastructure/mcp-identity-fingerprint.js';

const retentionConfig = sessionRetentionConfig(process.env);
const localToolPolicy = process.env.ROSTER_LOCAL_TOOL_POLICY_FILE
  ? new FileLocalToolPolicy(resolve(process.env.ROSTER_LOCAL_TOOL_POLICY_FILE)) : undefined;
// An explicitly configured policy must be readable and valid before listening.
if (localToolPolicy) await localToolPolicy.current();
const coreTrust=process.env.ROSTER_CORE_TRUST_FILE ? new FileCoreTrust(resolve(process.env.ROSTER_CORE_TRUST_FILE)) : undefined;
if(coreTrust) await coreTrust.current();
if(process.env.ROSTER_REQUIRE_CORE_AUTHORITY!==undefined&&!['0','1'].includes(process.env.ROSTER_REQUIRE_CORE_AUTHORITY))throw Error('Invalid Core authority requirement');
const requireCoreAuthority=process.env.ROSTER_REQUIRE_CORE_AUTHORITY===undefined?!!coreTrust:process.env.ROSTER_REQUIRE_CORE_AUTHORITY==='1';
const coreAuthority=requireCoreAuthority?new HttpCoreExecutionAuthority():undefined;
const token = process.env.ROSTER_TOKEN;
if (!token || token.length < 24)
  throw new Error("ROSTER_TOKEN을 24자 이상으로 설정하세요.");
const ownership = new SqliteRuntimeOwnership(resolve(process.env.ROSTER_DATA_DIR || '.roster'));
ownership.acquire();
process.once('exit', () => ownership.release());
const credentials = new FileModelCredentials(resolve(process.env.ROSTER_DATA_DIR || '.roster'));
const python = new LocalPythonAgentWorker(undefined, undefined, reference => credentials.get(reference));
const modulePath = process.env.ROSTER_AGENT_MODULE;
const loaded: AgentModule | undefined = modulePath
  ? await import(pathToFileURL(resolve(modulePath)).href)
  : undefined;
const agents = loaded
  ? await loaded.createAgents(
      JSON.parse(process.env.ROSTER_AGENT_OPTIONS || "{}"),
    )
  : [];
const storage = new FileRuntimeStorage(
  resolve(process.env.ROSTER_DATA_DIR || ".roster"),
  process.env.ROSTER_RUNTIME_NAME || "Node 런타임",
);
const factory={create:(config:import('@roster/contracts').ManagedAgentConfig,connections:import('@roster/contracts').McpConfig[])=>managedImplementation(config,connections,python,reference=>credentials.get(reference)),validate:validateManagedConfiguration};
const localClis = new HostLocalCliDiscovery();
await localClis.inspect();
const launch = (id: 'codex' | 'claude') => async () => { await localClis.inspect(); return localClis.launch(id); };
const bundledTemplates = [...codexTemplates({resolveLaunch:launch('codex')}), ...delegatingCodexTemplates({resolveLaunch:launch('codex')}), ...collaboratingCodexTemplates({resolveLaunch:launch('codex')}), ...claudeTemplates({resolveLaunch:launch('claude')})];
const externalTemplates = await loaded?.createAgentTemplates?.(JSON.parse(process.env.ROSTER_AGENT_OPTIONS||'{}')) ?? [];
const templateIDs = new Set(bundledTemplates.map(t => t.id));
for (const template of externalTemplates) {
  if (templateIDs.has(template.id)) throw new Error(`Duplicate agent template ID: ${template.id}`);
  templateIDs.add(template.id);
}
const author=authorCreationSources([...bundledTemplates, ...externalTemplates],reference=>credentials.get(reference));
const builtin=managedCreationSources(factory),parameters=new JsonSchemaAgentParameters();
const creations=new RuntimeAgentCreation(process.env.ROSTER_RUNTIME_ID||'node-local',storage,parameters,r=>[...builtin(r),...author(r)]);
const capture = new ConsoleStreamCapture();
capture.install();
const journal = new SqliteSessionJournal(resolve(process.env.ROSTER_DATA_DIR || ".roster", "session-journal.db"),process.env.ROSTER_RUNTIME_ID || "node-local");
const retention = new JournalRetention(journal, retentionConfig.policy);
const runtime = new RosterRuntime(
  process.env.ROSTER_RUNTIME_ID || "node-local",
  agents,
  storage,
  storage,
  storage,
  {
    execute: (agent, input, context) =>
      capture.run(context.log, () => executeAgent(agent, input, context)),
  },
  factory,
  { inspect: inspectMcp },
  { maxConcurrent: Number(process.env.ROSTER_MAX_CONCURRENT ?? 4),
    maxPerAgent: Number(process.env.ROSTER_MAX_PER_AGENT ?? 1) },
  new ToolApprovals(new FileApprovalRepository(resolve(process.env.ROSTER_DATA_DIR || ".roster", "tool-approvals"))),
  journal,
  credentials,
  parameters,
  creations,
  localToolPolicy,
  coreTrust,
  coreAuthority,
  new McpConnections(process.env.ROSTER_RUNTIME_ID||'node-local',storage,{inspect:inspectMcp},
    new FileMcpIdentityFingerprint(resolve(process.env.ROSTER_DATA_DIR||'.roster'))),
);
await runtime.initialize();
const server = createRuntimeApi(runtime, token, retention, localClis);
const stopRetention = startSessionRetention(retention, retentionConfig.sweepSeconds);
const port = Number(process.env.PORT || 7331);
const listen = process.env.ROSTER_LISTEN || "127.0.0.1";
server.listen(port, listen, () =>
  console.log(`Roster runtime ${runtime.id}: http://${listen}:${port}`),
);
let stopping:Promise<void>|undefined;
function stop() {
  return stopping ??= (async()=>{
    stopRetention();
    const closed=new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await runtime.close();
    await closed;
    capture.close();
    ownership.release();
  })();
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
