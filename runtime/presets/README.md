# Bundled presets

`codex-cli-collaborating` adds explicit durable shared-question waiting and checkpoint resumption to authorized delegation. It requires invocation-scoped Core access, current authority checks and Runtime suspension support. Ordinary and delegating templates keep their existing contracts. Its implementation is in [collaborating.mjs](codex/collaborating.mjs).

`codex-cli-delegating` is an optional separate template for authorized asynchronous task/conversation delegation. Existing `codex-cli` v2 tool exposure is preserved. Its implementation is in [delegating.mjs](codex/delegating.mjs); a child creation receipt does not mean result completion.

These are Runtime source files, included in the Git repository and production package. No separate preset repository or download is required for built-in templates.

`codex/agent.mjs` declares the `codex-cli` creation template automatically loaded by `src/main.ts`. Instance parameters declare project, model, role instructions, explicit skills, sandbox mode, effort, timeout and optional tool approval. Runtime creates the agent; Core supplies organization/permissions/event routing. Set `ROSTER_CODEX_EXECUTABLE` if the installed CLI is not on PATH. CLI installation and host authentication remain prerequisites. Default mode is read-only.

Templates emit local `complete`/`fail`. Semantic help, process failure and cancellation cannot become success just because the process exits normally. Minutes are Runtime artifacts. Desktop tools and Runtime credentials are not inherited by the child; resource bodies are not injected automatically. Version 2 connects invocation-scoped Core MCP with resource/session query tools. The token is environment-only, excluded from shell environments and redacted before session logging; supplied MCP startup is required. Old version-1 instances are not silently migrated: preserve their deployed source or explicitly recreate/migrate from the current catalogue. Subfolder instructions are not OS isolation.

External author modules remain optional additions via `ROSTER_AGENT_MODULE`; duplicate template IDs are rejected instead of replacing built-in implementations. Changing a declaration/version changes its catalogue revision. Existing instances retain their creation contract and are not silently migrated.

Source location is authoritative: the earlier standalone `roster-agent-presets` repository is no longer the Runtime deployment source. `claude-code/agent.mjs` provides `claude-code-cli`; Runtime automatically resolves both CLIs on its own host. The [local discovery implementation](../src/infrastructure/local-cli-discovery.ts) determines installation and login status. Claude defaults to read-only built-in tools and respects CLI permissions without global permission bypass. Both templates remain visible when installation/login needs attention. No company-specific policy, model availability guesses, credentials or autonomous planning policy belongs in the built-in adapter.
