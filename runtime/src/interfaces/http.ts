import { ResourceInvocation } from "./resource-contract.js";
import { SESSION_DELIVERY, JournalNotFound, JournalRecordsExpired } from "../domain/session-delivery.js";
import { JournalRetentionDisabled, JournalRetentionFailed } from "../domain/session-retention.js";
import type { JournalRetention } from "../application/session-retention.js";
import {AgentPreset, saveAgentPreset} from "../application/agent-presets.js";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Id, ManagedAgent, McpConnection } from "@roster/contracts";
import { AdmissionError, AgentVersionConflict, type RosterRuntime } from "../application/runtime.js";
import { managedSkillCatalog, validateManagedAgentSkills } from "../infrastructure/managed-skills.js";
import {AgentCreationConflict,AgentCreationUnavailable} from '../application/agent-creation.js';
import {strictRequestJSON} from './strict-json.js';
import {McpChangeConflict,McpIdentityUnavailable} from '../application/mcp-connections.js';
import type {LocalCliDiscovery} from '../domain/local-cli.js';
import {createHash} from 'node:crypto';
import {parseStrictJSON} from '../infrastructure/strict-json.js';
export function createRuntimeApi(runtime: RosterRuntime, token: string, retention?: JournalRetention, localClis?: LocalCliDiscovery) {
  async function rawBody(req: IncomingMessage) {
    const parts: Buffer[] = [];
    let size = 0;
    for await (const part of req) {
      size += part.length;
      if (size > 3_000_000) throw new Error("요청 크기 제한 초과");
      parts.push(Buffer.from(part));
    }
    return Buffer.concat(parts);
  }
  async function body(req: IncomingMessage) {
    return JSON.parse((await rawBody(req)).toString() || "{}");
  }
  function send(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  }
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method;
      if (url.pathname === "/health")
        return send(res, 200, { ok: true, runtime_id: runtime.id });
      if (req.headers.authorization !== `Bearer ${token}`)
        return send(res, 401, { error: "인증 필요" });
      if(url.pathname==='/admin/local-clis'&&method==='GET') {
        if(!localClis)return send(res,404,{error:'Local CLI discovery unavailable'});
        try{return send(res,200,{protocol:'roster-local-cli-discovery/1',runtime_id:runtime.id,clis:await localClis.inspect()});}
        catch{return send(res,503,{error:'Local CLI discovery failed; check Runtime host'});}
      }
      if(parts[0] === "admin" && parts[1] === "session-journal") {
        if(!retention) return send(res,404,{error:"Journal retention unavailable"});
        if(parts.length===2 && method==="GET") return send(res,200,retention.status());
        if(parts.length===3 && parts[2]==="audit" && method==="GET")
          return send(res,200,retention.audit(Number(url.searchParams.get("after") ?? 0),Number(url.searchParams.get("limit") ?? 100)));
        if(parts.length===3 && parts[2]==="prune" && method==="POST") {
          const input=await body(req);
          if(!input || typeof input!=="object" || Array.isArray(input) || Object.keys(input).length) throw new Error("Pruning accepts only an empty object; configure policy on the server");
          return send(res,200,retention.prune());
        }
        return send(res,404,{error:"Unknown journal retention path"});
      }
      if (url.pathname === "/state" && method === "GET")
        return send(res, 200, await runtime.manifest());
      if (url.pathname === '/agent-parameters' && method === 'GET')
        return send(res,200,await runtime.parameterDeclarations());
      if(url.pathname==='/agent-catalogue' && method==='GET'){
        if(!runtime.creations)return send(res,404,{error:'Agent creation catalogue unavailable'});
        try{return send(res,200,await runtime.creationCatalogue());}
        catch{return send(res,503,{error:'Agent catalogue unavailable'});}
      }
      if(url.pathname==='/admin/agent-creations' && method==='POST'){
        if(!runtime.creations)return send(res,404,{error:'Agent creation unavailable'});
        try{return send(res,200,await runtime.createAgent(await strictRequestJSON(req)));}
        catch(error){const status=error instanceof AgentCreationConflict?409:error instanceof AgentCreationUnavailable||(error as NodeJS.ErrnoException)?.code?503:400;return send(res,status,{error:'Agent creation rejected; retain original request ID and check source/parameters'});}
      }
      if (url.pathname === '/admin/credentials' && method === 'PUT') {
        if (!runtime.credentials) return send(res,503,{error:'Credential storage unavailable'});
        try { runtime.credentials.save(await body(req)); }
        catch { return send(res,400,{error:'Credential registration rejected; check reference, value and runtime storage'}); }
        return send(res,200,{saved:true});
      }
      if (url.pathname === "/admin" && method === "GET") {
        const registry = await runtime.registry.read();
        const {agent_creations:_privateCreations,mcp_identity:_privateMcpIdentity,...settings}=registry;
        return send(res, 200, {
          manifest: await runtime.manifest(),
          capacity: runtime.capacity(),
          skill_catalog: await managedSkillCatalog(),
          agent_parameter_declarations: (await runtime.parameterDeclarations()).agents,
          ...settings,
          can_manage_presets: true,
          credentials: [
            ...new Set([...registry.managed_agents.map((a) => a.credential_env), ...(runtime.credentials?.references() ?? [])]),
          ].filter(Boolean).map((env) => ({ env, configured: Boolean(runtime.credentials ? runtime.credentials.get(env) : process.env[env]) })),
        });
      }
      if (parts[0] === "admin" && parts[1] === "agents" && parts[3] === "approvals") {
        if(!runtime.approvals) return send(res,503,{error:"Tool approval service unavailable"});
        const agent=Id.parse(parts[2]);
        if(parts.length===4 && method==="GET") return send(res,200,{approvals:runtime.approvals.list(agent)});
        if(parts.length===5 && method==="POST") {
          const input=await body(req);
          if(typeof input.allow!=="boolean" || typeof input.actor!=="string" || !input.actor || input.actor.length>200) throw new Error("Invalid approval decision");
          runtime.approvals.decide(agent,Id.parse(parts[4]),input.allow,input.actor);
          return send(res,200,{ok:true});
        }
      }
      if (url.pathname === "/admin/name" && method === "PUT") {
        const input = await body(req);
        if (
          typeof input.name !== "string" ||
          !input.name.trim() ||
          input.name.length > 100
        )
          throw new Error("이름을 입력하세요.");
        await runtime.rename(input.name);
        return send(res, 200, await runtime.manifest());
      }
      if (url.pathname === "/admin/agent-presets" && method === "PUT") {
        const preset = AgentPreset.parse(await body(req));
        const previous = (await runtime.registry.read()).agent_presets?.find(item => item.id === preset.id);
        await validateManagedAgentSkills(preset.agent, previous?.agent);
        await runtime.validateAgent(preset.agent);
        return send(res, 200, await saveAgentPreset(runtime.registry, preset));
      }
      if ((url.pathname === "/admin/agents" || url.pathname === '/admin/agent-configuration') && method === "PUT") {
        const config = ManagedAgent.parse(await body(req));
        const previous = (await runtime.registry.read()).managed_agents.find(agent => agent.id === config.id);
        if (config.version !== (previous?.version ?? 0)) throw new AgentVersionConflict();
        await validateManagedAgentSkills(config, previous);
        await runtime.upsertAgent(config, url.pathname === '/admin/agent-configuration');
        return send(res, 200, await runtime.manifest());
      }
      if((url.pathname==='/mcp-catalogue'&&method==='GET')||
         (parts[0]==='mcp-connections'&&parts.length===2&&method==='GET')||
         (url.pathname==='/admin/mcp-changes'&&method==='POST')){
        if(!runtime.mcpConnections)return send(res,503,{error:'MCP identity service unavailable'});
        try{
          if(method==='POST')return send(res,200,await runtime.mcpConnections.change(await strictRequestJSON(req)));
          const catalogue=await runtime.mcpConnections.catalogue();
          if(url.pathname==='/mcp-catalogue')return send(res,200,catalogue);
          const descriptor=catalogue.connections.find(c=>c.connection_id===parts[1]);
          return send(res,descriptor?200:404,descriptor??{error:'MCP connection not found'});
        }catch(error){return send(res,error instanceof McpChangeConflict?409:error instanceof McpIdentityUnavailable||(error as NodeJS.ErrnoException)?.code?503:400,{error:'MCP identity request rejected; check revision, request ID and Runtime storage'});}
      }
      if (url.pathname === "/admin/mcp" && method === "PUT")
        return send(res, 200, {
          tools: await runtime.upsertMcp(McpConnection.parse(await body(req))),
        });
      if (
        parts[0] === "admin" &&
        parts[1] === "mcp" &&
        parts[2] &&
        method === "DELETE"
      ) {
        await runtime.removeMcp(Id.parse(parts[2]));
        return send(res, 200, { ok: true });
      }
      if (parts[0] === "executions" && parts[1]) {
        const id = Id.parse(parts[1]);
        if(parts[2] === "records") {
          if(!runtime.journal) return send(res,404,{error:"Journal unavailable"});
          const consumer=req.headers["x-roster-session-consumer"];
          if(req.headers["x-roster-service-protocol"]!==SESSION_DELIVERY || typeof consumer!=="string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(consumer)) throw new Error("Invalid journal protocol/consumer");
          res.setHeader("X-Roster-Service-Protocol",SESSION_DELIVERY);
          if(parts.length===3 && method==="GET") return send(res,200,runtime.journal.page(id,consumer,Number(url.searchParams.get("after") ?? 0),Number(url.searchParams.get("limit") ?? 100)));
          if(parts.length===4 && parts[3]==="ack" && method==="POST") {
            const input=await body(req);
            return send(res,200,{protocol:SESSION_DELIVERY,acknowledged:runtime.journal.acknowledge(id,consumer,input.through)});
          }
          return send(res,404,{error:"Unknown journal path"});
        }
        if (parts[2] === "cancel" && method === "POST")
          return send(res, 200, { requested: runtime.cancel(id) });
        if (method === "GET") {
          const receipt = await runtime.executions.get(id);
          return send(
            res,
            receipt ? 200 : 404,
            receipt || { error: "실행 없음" },
          );
        }
      }
      if (url.pathname === "/executions" && method === "POST") {
        const raw=await rawBody(req);
        const input = ResourceInvocation.parse(parseStrictJSON(new TextDecoder('utf-8',{fatal:true}).decode(raw),3_000_000));
        const requestSha256=createHash('sha256').update(raw).digest('hex');
        const durable=req.headers["x-roster-session-stream"]==="2";
        const consumer=req.headers["x-roster-session-consumer"];
        if(durable && (typeof consumer!=="string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(consumer))) throw new Error("Invalid journal consumer");
		const coreMcpUrl = req.headers["x-roster-core-mcp-url"];
		const coreMcpToken = req.headers["x-roster-core-mcp-token"];
		if ((coreMcpUrl === undefined) !== (coreMcpToken === undefined) ||
			(coreMcpUrl !== undefined && (typeof coreMcpUrl !== "string" || typeof coreMcpToken !== "string" || coreMcpToken.length < 32 || coreMcpToken.length > 1024)))
			throw new Error("Invalid core MCP execution credential");
		const coreMcp = typeof coreMcpUrl === "string" && typeof coreMcpToken === "string"
			? {url: coreMcpUrl, token: coreMcpToken} : undefined;
        try {
          await runtime.run(input, (frame) => {
            if (!res.destroyed) res.write(JSON.stringify(frame) + "\n");
          }, () => {
            res.writeHead(200, {
              "Content-Type": "application/x-ndjson",
              "Cache-Control": "no-store",
              ...(durable ? {"X-Roster-Session-Journal":"1"}: {}),
            });
            res.flushHeaders();
          }, coreMcp, durable || req.headers["x-roster-session-stream"] === "1", durable ? consumer as string : undefined,requestSha256);
        } catch (error) {
          if (!res.headersSent) {
            if (error instanceof AdmissionError) {
              if (error.status === 429 || error.status === 503) res.setHeader("Retry-After", "1");
              return send(res, error.status, { code: error.code, accepted: false,
                scope: error.scope, error: error.message });
            }
            return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
          }
          if (!res.destroyed) res.write(JSON.stringify({ type: "observation", code: "request_error",
            message: error instanceof Error ? error.message : String(error) }) + "\n");
        }
        res.end();
        return;
      }
      send(res, 404, { error: "경로 없음" });
    } catch (error) {
      if (res.headersSent) res.end();
      else if(error instanceof JournalRecordsExpired)
        send(res,410,{code:"journal_records_expired",execution_id:error.executionId,pruned_through:error.prunedThrough,
          through:error.through,acknowledged:error.acknowledged,error:error.message});
      else
        send(res, error instanceof JournalNotFound ? 404 : error instanceof JournalRetentionFailed ? 503 : error instanceof AgentVersionConflict || error instanceof JournalRetentionDisabled ? 409 : 400, {
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });
}
