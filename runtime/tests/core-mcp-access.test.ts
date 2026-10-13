import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { authorizeCoreMcpTool, selectCoreMcpTools } from "../src/infrastructure/core-mcp-access.js";
import {ToolAccessRefusal} from "../src/domain/tool-access-refusal.js";

test("runtime sends each external MCP tool decision to core with execution credential", async () => {
  const revision='e60e47d5-a41c-47b8-b6dd-34f650e3c001';
  const requests: {path: string; authorization: string; body: unknown}[] = [];
  let status = 200;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({path: request.url || "", authorization: String(request.headers.authorization || ""), body: JSON.parse(Buffer.concat(chunks).toString())});
      response.writeHead(status, {"Content-Type": "application/json"});
      response.end(JSON.stringify({ok: status === 200}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as {port: number}).port;
    const core = {url: `http://127.0.0.1:${port}/mcp`, token: "rex1.scoped"};
    await authorizeCoreMcpTool(core, "runtime", "files", "read_file", new AbortController().signal,revision);
    assert.deepEqual(requests[0], {
      path: "/api/core/mcp-authorizations", authorization: "Bearer rex1.scoped",
      body: {runtime_id: "runtime", connection_id: "files", revision, tool_name: "read_file"},
    });
    status = 403;
    await assert.rejects(authorizeCoreMcpTool(core, "runtime", "files", "read_file", new AbortController().signal,revision), /denied/);
    await assert.rejects(authorizeCoreMcpTool({url:"http://remote.example/mcp",token:"secret"}, "runtime", "files", "read_file", new AbortController().signal,revision),
      error => error instanceof ToolAccessRefusal && error.reason === "core_authority_unavailable");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Core discovery accepts only an exact identity and a subset of the frozen request", async () => {
  const query = {protocol: 'roster-mcp-tool-selection/1' as const, runtime_id: 'runtime', connection_id: 'files', revision: 'e60e47d5-a41c-47b8-b6dd-34f650e3c001', tools: ['read']};
  let payload: string | Buffer = JSON.stringify(query);
  let contentType = 'application/json';
  let onRequest = () => {};
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      onRequest();
      response.writeHead(200, {'Content-Type': contentType});
      response.end(payload);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const core = {url: `http://127.0.0.1:${(server.address() as {port: number}).port}/mcp`, token: 'rex1.scoped'};
  const signal = new AbortController().signal;
  try {
    assert.deepEqual(await selectCoreMcpTools(core, query, signal), ['read']);
    payload = JSON.stringify({...query, tools: []});
    assert.deepEqual(await selectCoreMcpTools(core, query, signal), []);
    const invalid = [
      JSON.stringify({...query, runtime_id: 'other'}),
      JSON.stringify({...query, connection_id: 'other'}),
      JSON.stringify({...query, revision: 'e60e47d5-a41c-47b8-b6dd-34f650e3c002'}),
      JSON.stringify({...query, tools: ['password']}),
      JSON.stringify({...query, tools: ['read', 'read']}),
      JSON.stringify(query).replace('"tools":', '"tools":[],"tools":'),
      ' '.repeat(256 * 1024 + 1),
      Buffer.from([0xc3, 0x28]),
    ];
    for (const body of invalid) {
      payload = body;
      await assert.rejects(selectCoreMcpTools(core, query, signal), error => error instanceof ToolAccessRefusal && error.reason === 'core_authority_unavailable');
    }
    payload = JSON.stringify(query);
    contentType = 'text/plain';
    await assert.rejects(selectCoreMcpTools(core, query, signal), ToolAccessRefusal);
    contentType = 'application/json';
    payload = JSON.stringify({...query, tools: ['password']});
    onRequest = () => { query.tools.push('password'); };
    await assert.rejects(selectCoreMcpTools(core, query, signal), ToolAccessRefusal);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
