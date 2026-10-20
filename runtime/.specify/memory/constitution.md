# Roster engineering constitution

Version: 1.0.0 | Ratified: 2026-10-02

1. Core owns organization, work orchestration, persistent instructions and approvals. Runtime owns agent configuration, skills, tools and execution. Teams are independent of runtime servers.
2. Record user requirements, implementation decisions, acceptance criteria and verification before marking a task complete.
3. Preserve execution history and explicit human approval boundaries. Never silently migrate in-flight work when providers change.
4. Never persist provider credentials in organization state, API responses, logs or Git. Remote connections require authenticated HTTPS.
5. Verify meaningful boundaries with isolated deterministic tests. Use go run for executable verification; do not use go build. Never start paid model executions for verification.
6. Commit each completed logical task. Do not overwrite unrelated working changes.
