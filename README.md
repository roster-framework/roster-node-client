# Roster Node Client

[English](README.md) | [한국어](README.ko.md)

Host operations that a central Roster Core can describe and call. `runtime/` runs agent and script operations, `resource/` serves documents and MCP tools, and `contracts/` holds shared Node.js schemas. A separate Python client is planned but is not included in these run instructions.

![Roster Node Client flow: Core calls Runtime and Resource Nodes; Runtime Events can follow a Core subscription to a target Call](docs/assets/node-client-flow.svg)

## Run locally

Requirements: Node.js 24, npm, and Go 1.26. Keep credentials and writable data directories outside the repository. Runtime requires `ROSTER_TOKEN` of at least 24 characters. Resource requires distinct `ROSTER_RESOURCE_TOKEN` and `ROSTER_RESOURCE_ADMIN_TOKEN` values of at least 32 characters each.

Start Runtime after setting `ROSTER_TOKEN` and a writable `ROSTER_DATA_DIR`:

```sh
cd runtime
npm ci
npm run build
node dist/main.js
```

Start Resource in another terminal after setting `ROSTER_RESOURCE_TOKEN`, `ROSTER_RESOURCE_ADMIN_TOKEN`, and its own `ROSTER_DATA_DIR`:

```sh
cd resource
go run ./cmd/roster-resource-server
```

Default loopback addresses are Runtime `127.0.0.1:7331` and Resource `127.0.0.1:7340`. Use separate data directories and credentials. Remote Resource listeners need a TLS certificate and key; remote Runtime deployments need an explicit TLS proxy. Core connects to provider HTTPS URLs outbound. Node registration or a health response does not prove that a particular Call succeeded.

## Start prepared services together

Build Runtime from `runtime/` with `npm ci && npm run build`, then build Resource from `resource/` with `go build -o roster-resource-server.exe ./cmd/roster-resource-server` on Windows (use `roster-resource-server` on Linux). Create owner-only config JSON and a separate owner-only env JSON **outside this repository**, then run from the repository root:

```sh
node scripts/launch.mjs --config ../local-config/node-client.json
```

The config uses `schema: "roster-launch/1"`, `data_root`, `env_file`, `runtime_entry` (the absolute path to `runtime/dist/main.js`), and `resource_binary`; `runtime_port`, `resource_port`, and `agent_module` are optional. The env file shape is `{ "env": { "ROSTER_TOKEN": "...", "ROSTER_RESOURCE_TOKEN": "...", "ROSTER_RESOURCE_ADMIN_TOKEN": "..." } }`. Use distinct real tokens in that external file. The launcher serves loopback ports 7331 and 7340 by default, checks health endpoints, and keeps Runtime and Resource data separate under the external data root. Grouped startup and shutdown are verified in Linux Docker; native Windows ACL and signal behavior remain unverified.

## Add an Agent or MCP resource

Runtime loads a trusted local ES module from `agent_module`; keep it outside this repository. The module exports `createAgents(options)` and returns declared Agent implementations. Startup imports and runs the module, so treat it as provider code and review it before use. This minimal example handles a request without a model call:

```js
export function createAgents(options = {}) {
  return [{
    spec: { id: 'custom-echo', name: String(options.name || 'Echo'), description: 'Local request echo',
      statuses: ['done'], events: ['complete'], skills: [], rules: [], capabilities: [] },
    async execute(invocation, context) {
      context.signal.throwIfAborted();
      return { status: 'done', summary: 'Request received',
        output: { request: invocation.context.request },
        events: [{ type: 'complete', data: {} }], artifacts: [], metrics: {} };
    },
  }];
}
```

Set `agent_module` to that `.mjs` path in the external launcher config. Optional `agent_options`, such as `{ "name": "Local helper" }`, are passed only to Runtime. Runtime's [parameter example](runtime/examples/parameter-agent.ts) describes the typed author contract. Register the Agent as a Runtime Node with `target_id: "custom-echo"`, then call its declared `run` operation. Check registration, Describe, and Call results separately.

For a custom resource, run a Streamable HTTP MCP server as a separate process and validate its bearer credential there. The [Go SDK fixture](resource/internal/adapters/mcpclient/factory_test.go) shows a server and tool. Resource connects to its endpoint and handles `tools.list` and `tools.call`. Save the definition outside Git and register it with `node resource/scripts/resource.mjs register definition.json` using `ROSTER_RESOURCE_ADMIN_TOKEN`:

```json
{"id":"custom-mcp","name":"Custom MCP","component":"mcp","endpoint":"http://127.0.0.1:7440/mcp","credential_env":"CUSTOM_MCP_TOKEN","version":0}
```

Give `CUSTOM_MCP_TOKEN` to the Resource process through its owner-only env file. In grouped launcher config, list it in `resource_provider_env`; the launcher passes it only to Resource. Invoke with the service token using `node resource/scripts/resource.mjs invoke custom-mcp operation.json`, where `operation.json` can contain `{"name":"tools.call","tool":"echo","arguments":{"text":"hello"},"expected_version":1}` after registration returns version 1. Register a separate Core Resource Node with `target_id: "custom-mcp"` and the Resource URL, then inspect its `tools.list` and `tools.call` operations. Registration does not prove the MCP tool ran successfully.

## Verify

Run Docker module checks and package builds separately from each component:

```sh
# runtime/ or contracts/
docker run --rm -v "$PWD:/src" -w /src node:24-bookworm-slim sh -c "npm ci && npm test"

# resource/
docker run --rm -v "$PWD:/src:ro" -w /src golang:1.26 go test ./...
```

Component guides: [Runtime](runtime/README.md), [Resource](resource/README.md), and [Contracts](contracts/README.md). Contribution guidance: [CONTRIBUTING](CONTRIBUTING.md).
