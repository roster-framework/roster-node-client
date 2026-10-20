import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {createHash} from 'node:crypto';
import {Id,ExecutionSuspension} from '@roster/contracts';
import type {SuspensionCheckpoint} from '../domain/execution-suspension.js';
import {validateSuspensionJournal, type SuspensionJournalCommit} from '../domain/suspension-journal.js';
import type { RuntimeManifest } from "@roster/contracts";
import {readAgentCreationState} from '../application/agent-creation.js';
import {readMcpIdentity} from '../application/mcp-connections.js';
import type {
  RegistryRepository,
  Registry,
  ExecutionRepository,
  Receipt,
  WorkspaceProvider,
} from "../application/ports.js";
export class FileRuntimeStorage
  implements RegistryRepository, ExecutionRepository, WorkspaceProvider
{
  constructor(
    private directory: string,
    name: string,
  ) {
    mkdirSync(join(directory, "executions"), { recursive: true });
    if (!existsSync(join(directory, "registry.json")))
      this.atomic("registry.json", {
        name,
        managed_agents: [],
        mcp_connections: [],
      });
  }
  private atomic(path: string, value: unknown) {
    const full = join(this.directory, path);
    writeFileSync(full + ".tmp", JSON.stringify(value, null, 2),{mode:0o600});
    renameSync(full + ".tmp", full);
  }
  async read(): Promise<Registry> {
    const registry=JSON.parse(
      readFileSync(join(this.directory, "registry.json"), "utf8"),
    );
    if(registry.agent_creations!==undefined)readAgentCreationState(registry.agent_creations);
    if(registry.mcp_identity!==undefined)readMcpIdentity(registry.mcp_identity);
    return registry;
  }
  async transact(action: (r: Registry) => void) {
    const registry = JSON.parse(
      readFileSync(join(this.directory, "registry.json"), "utf8"),
    ) as Registry;
    action(registry);
    if(registry.mcp_identity!==undefined)readMcpIdentity(registry.mcp_identity);
    if(registry.agent_creations!==undefined)readAgentCreationState(registry.agent_creations);
    this.atomic("registry.json", registry);
  }
  async publish(manifest: RuntimeManifest) {
    this.atomic("state.json", manifest);
  }
  async reserve(id: string) {
    Id.parse(id);
    try {
      writeFileSync(
        join(this.directory, "executions", id + ".json"),
        JSON.stringify({ id, state: "running" }),
        { flag: "wx" },
      );
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }
  async get(id: string): Promise<Receipt | undefined> {
    Id.parse(id);
    const path = join(this.directory, "executions", id + ".json");
    if(!existsSync(path))return undefined;
    const record=JSON.parse(readFileSync(path,'utf8'));
    if(record.id!==id)throw new Error('Foreign execution record');
    if(record.state==='suspended') {
      this.validateSuspension(record,record.private_checkpoint);
      if(record.private_journal!==undefined)this.validateJournal(record.private_journal,record.suspension);
      // Private continuation state must never enter the public receipt API.
      return {id:record.id,state:'suspended',suspension:record.suspension};
    }
    if(record.private_checkpoint!==undefined || record.private_journal!==undefined)throw new Error('Invalid private checkpoint record');
    return record;
  }
  async save(receipt: Receipt) {
    Id.parse(receipt.id);
    if(receipt.state==='suspended' || receipt.suspension!==undefined || (await this.get(receipt.id))?.state==='suspended') throw new Error('Suspended execution requires immutable checkpoint storage');
    this.atomic(join("executions", receipt.id + ".json"), receipt);
  }
  private validateSuspension(receipt:Receipt,checkpoint:SuspensionCheckpoint) {
    const parsed=ExecutionSuspension.safeParse(receipt.suspension);
    const s=parsed.success ? parsed.data : undefined;
    if(receipt.state!=='suspended' || receipt.result!==undefined || receipt.observation!==undefined || !s || !checkpoint || checkpoint.version!==1 || !checkpoint.state || typeof checkpoint.state!=='object' || Array.isArray(checkpoint.state)) throw new Error('Invalid suspended execution record');
    for(const key of ['execution_id','work_id','runtime_id','agent_id','wait_id'] as const) {
      Id.parse(s[key]);
      if(s[key]!==checkpoint[key])throw new Error('Foreign suspension checkpoint');
    }
    if(receipt.id!==s.execution_id || Buffer.byteLength(JSON.stringify(checkpoint.state))>65536 || createHash('sha256').update(JSON.stringify(checkpoint)).digest('hex')!==s.checkpoint_digest) throw new Error('Suspension checkpoint integrity failed');
  }
  private validateJournal(journal:SuspensionJournalCommit,receipt:Receipt['suspension']) {
    validateSuspensionJournal(journal);
    if(JSON.stringify(journal.receipt)!==JSON.stringify(receipt))throw new Error('Foreign suspension journal receipt');
  }
  async saveSuspension(receipt:Receipt,checkpoint:SuspensionCheckpoint,journal?:SuspensionJournalCommit) {
    receipt=structuredClone(receipt);
    checkpoint=structuredClone(checkpoint);
    journal=journal ? structuredClone(journal) : undefined;
    this.validateSuspension(receipt,checkpoint);
    if(journal)this.validateJournal(journal,receipt.suspension);
    const current=await this.get(receipt.id);
    if(current?.state==='suspended' && JSON.stringify(current.suspension)===JSON.stringify(receipt.suspension)) {
      const record=JSON.parse(readFileSync(join(this.directory,'executions',receipt.id+'.json'),'utf8'));
      if(JSON.stringify(record.private_journal)!==JSON.stringify(journal))throw new Error('Suspension journal intent conflict');
      return;
    }
    if(current?.state!=='running')throw new Error('Original execution is not running');
    // One atomic local record owns both terminal receipt and private checkpoint.
    this.atomic(join('executions',receipt.id+'.json'),{...receipt,private_checkpoint:checkpoint,...(journal?{private_journal:journal}:{})});
  }
  async *suspensionJournals():AsyncIterable<SuspensionJournalCommit> {
    // Stream one verified record at a time; do not accumulate private checkpoints.
    for(const file of readdirSync(join(this.directory,'executions')).filter(f=>f.endsWith('.json'))) {
      const id=file.slice(0,-5),receipt=await this.get(id);
      if(receipt?.state!=='suspended')continue;
      const record=JSON.parse(readFileSync(join(this.directory,'executions',file),'utf8'));
      this.validateSuspension(record,record.private_checkpoint);
      if(record.private_journal!==undefined) {
        this.validateJournal(record.private_journal,receipt.suspension);
        yield structuredClone(record.private_journal);
      }
    }
  }
  async readSuspensionCheckpoint(id:string):Promise<SuspensionCheckpoint> {
    const receipt=await this.get(id);
    if(receipt?.state!=='suspended')throw new Error('Suspension checkpoint unavailable');
    const record=JSON.parse(readFileSync(join(this.directory,'executions',id+'.json'),'utf8'));
    this.validateSuspension(record,record.private_checkpoint);
    return structuredClone(record.private_checkpoint);
  }
  async recover() {
    for (const file of readdirSync(join(this.directory, "executions")).filter(
      (f) => f.endsWith(".json"),
    )) {
      const record = await this.get(file.slice(0, -5));
      if (record?.state === "running")
        await this.save({
          ...record,
          state: "attention",
          observation:
            "런타임 재시작으로 실행이 중단되었습니다. 자동 재실행하지 않습니다.",
        });
    }
  }
  async create(agentId: string, executionId: string) {
    const path = join(this.directory, "workspaces", agentId, executionId);
    mkdirSync(path, { recursive: true });
    return path;
  }
}
