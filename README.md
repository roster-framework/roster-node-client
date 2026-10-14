# Roster Node Client / 로스터 노드 클라이언트

Host operations that a central Roster Core can describe and call. `runtime/` runs agent and script operations, `resource/` serves documents and tools, and `contracts/` holds shared Node.js schemas. A separate Python client is planned. 중앙 Roster Core가 명세를 조회하고 호출할 수 있는 operation을 제공합니다. `runtime/`은 실행을, `resource/`는 문서·도구를, `contracts/`는 공유 Node.js schema를 맡습니다.

## Run locally / 로컬 실행

Requirements: Node.js 24, npm, Go 1.26. Give Runtime one service token of at least 24 characters; give Resource distinct service and admin tokens of at least 32 characters each. Store them outside the repository. 필요 도구는 Node.js 24, npm, Go 1.26입니다. Runtime 서비스 토큰은 24자 이상, Resource 서비스·관리 토큰은 서로 다르고 각각 32자 이상이어야 합니다. 저장소 밖에서 주입하세요.

Start Runtime in one terminal after setting `ROSTER_TOKEN` and a writable `ROSTER_DATA_DIR`:

```sh
cd runtime
npm ci
npm run build
node dist/main.js
```

Start Resource in another terminal after setting `ROSTER_RESOURCE_TOKEN`, `ROSTER_RESOURCE_ADMIN_TOKEN`, and its **own** `ROSTER_DATA_DIR`:

```sh
cd resource
go run ./cmd/roster-resource-server
```

기본 loopback 주소는 Runtime `127.0.0.1:7331`, Resource `127.0.0.1:7340`입니다. 두 프로세스의 데이터 폴더와 토큰을 분리하세요. A remote Resource listener requires its TLS certificate/key; remote Runtime needs an explicit TLS proxy. The Core connects to provider HTTPS URLs outbound. Neither Node registration nor a health response proves a particular Call succeeded.

Core-side `token_env` names refer to the service tokens available in the **Core process**. The values must match the provider tokens and must never appear in a Node binding, manifest, or Git. Core의 `token_env`는 Core 프로세스에서 읽는 환경변수 이름이며 값은 공급자 토큰과 일치해야 합니다.

To start both prepared services with one command, build Runtime from `runtime/` with `npm ci && npm run build`, then build Resource from `resource/` with `go build -o roster-resource-server.exe ./cmd/roster-resource-server` on Windows (use `roster-resource-server` on Linux). Create an owner-only config JSON and a separate owner-only env JSON **outside this repository**, then run from the repository root:

```sh
node scripts/launch.mjs --config ../local-config/node-client.json
```

The config uses `schema: "roster-launch/1"`, `data_root`, `env_file`, `runtime_entry` (the absolute path to `runtime/dist/main.js`), and `resource_binary`; `runtime_port`, `resource_port`, and `agent_module` are optional. The env file has the shape `{ "env": { "ROSTER_TOKEN": "...", "ROSTER_RESOURCE_TOKEN": "...", "ROSTER_RESOURCE_ADMIN_TOKEN": "..." } }`. Use distinct, real tokens in that external file and give it owner-only permissions. The launcher serves loopback ports 7331 and 7340 by default, checks both health endpoints, and keeps separate Runtime and Resource data under its external `data_root`. Its grouped startup and shutdown have been verified in Linux Docker; native Windows ACL and signal behavior remain unverified. 두 서비스를 한 번에 실행할 때 설정·토큰·데이터를 저장소 밖에 두고, Runtime과 Resource의 토큰과 데이터 경계를 분리하세요. 원격 연결에는 별도의 TLS 배포 설정이 필요합니다.

## Add your own Agent or MCP resource / 커스텀 확장

Runtime loads a trusted local ES module from `agent_module`; keep that file outside this repository. The module exports `createAgents(options)` and returns declared Agent implementations. This minimal example handles a request without a model or extra privileges. Startup imports and runs module code, so install and review it as provider code. Runtime의 `Agent`·`Invocation`·`Result` 형식은 [public contracts](contracts/src/index.ts)와 [author types](runtime/src/agent.ts)에 있습니다.

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

Set `agent_module` to that `.mjs` file in the external launcher config. Optional `agent_options`, such as `{ "name": "Local helper" }`, go only to Runtime; keep credentials in the separate env file. Runtime's existing [parameter example](runtime/examples/parameter-agent.ts) shows a typed author contract. Core registers this Agent as a Runtime Node with `target_id: "custom-echo"`, then can call its declared `run` operation. 등록과 실제 Describe·Call 성공은 각각 확인하세요.

For a custom resource, run your own **Streamable HTTP MCP server** as a separate process and validate its bearer credential there. The [Go SDK fixture](resource/internal/adapters/mcpclient/factory_test.go) shows a server and tool; Resource connects to the endpoint and handles `tools.list` and `tools.call`. Save a definition outside Git and register it with `node resource/scripts/resource.mjs register definition.json` using `ROSTER_RESOURCE_ADMIN_TOKEN`:

```json
{"id":"custom-mcp","name":"Custom MCP","component":"mcp","endpoint":"http://127.0.0.1:7440/mcp","credential_env":"CUSTOM_MCP_TOKEN","version":0}
```

The Resource process must receive `CUSTOM_MCP_TOKEN` from its owner-only env file. In grouped launcher config, list it in `resource_provider_env`; the launcher passes it only to Resource. Invoke with the service token using `node resource/scripts/resource.mjs invoke custom-mcp operation.json`, where `operation.json` can contain `{"name":"tools.call","tool":"echo","arguments":{"text":"hello"},"expected_version":1}` after registration returns version 1. Register a separate Core Resource Node with `target_id: "custom-mcp"` and the Resource server URL, then inspect its `tools.list`/`tools.call` operation. 등록은 MCP 서버 접속 성공이나 도구 실행 성공을 증명하지 않습니다. 원격 endpoint에는 HTTPS가 필요하며 Core·Runtime·Resource의 토큰은 분리합니다.

## Verify / 검증

From each component, run the Docker module checks and package build separately. 구성요소별로 Docker 검증과 패키지 빌드를 수행합니다.

```sh
# runtime/ or contracts/
docker run --rm -v "$PWD:/src" -w /src node:24-bookworm-slim sh -c "npm ci && npm test"

# resource/
docker run --rm -v "$PWD:/src:ro" -w /src golang:1.26 go test ./...
```

Usage details: [Runtime](runtime/README.md), [Resource](resource/README.md), [Contracts](contracts/README.md). Contribution goals and Issue/PR guidance: [CONTRIBUTING](CONTRIBUTING.md). Internal design documents are maintained separately. 사용법은 구성요소 README에, 기여 안내는 CONTRIBUTING에 있습니다. 내부 설계 문서는 별도로 관리합니다.
