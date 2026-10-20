# Process preset portability

The Runtime host can be Windows, Linux, macOS or a Linux Docker container. The template is the same; project and executable paths always refer to that host, not the Core host. Use native absolute paths, resolved directories and the matching CLI executable/CPU architecture. Never copy a Windows `codex.exe` into a Linux image.

| Environment | Executable | Project | Cancellation |
| --- | --- | --- | --- |
| Windows | installed `codex.exe`, optionally `ROSTER_CODEX_EXECUTABLE` | e.g. `D:/projects/demo` | `taskkill /T /F` |
| Linux | installed `codex` or explicit executable path | e.g. `/work/demo` | dedicated process group, TERM then KILL |
| macOS | installed `codex` or explicit executable path | e.g. `/Users/name/projects/demo` | same POSIX process group |
| Docker Linux | CLI installed in the image for its architecture | mounted directory, e.g. `/workspace` | POSIX group; container init also recommended |

CLI invocation is shell-free, so spaces in paths are preserved. Windows-only sandbox configuration is omitted on POSIX. User Codex config is ignored, while CLI login still resolves through the host's `CODEX_HOME`/home. Authentication files must not be committed, copied into image layers or included in preset parameters. In containers, initialize a dedicated login directory for the Runtime user and mount it as a private volume; avoid mounting the entire personal home. The CLI may need writable session/config storage. Bind project storage separately with permissions matching the chosen read-only/workspace-write mode.

For Docker, install Node 24+ and the platform-compatible Codex CLI in a reviewed image, install Runtime production dependencies, include `dist/` and `presets/`, run with an init process as an unprivileged user, and persist Runtime journal storage. Set `ROSTER_CODEX_EXECUTABLE`, `CODEX_HOME`, Runtime authentication and project mounts explicitly. The container needs provider network access. A container path is what the agent's `project` parameter must contain. Do not use `danger-full-access`, privileged containers or mount the Docker socket as a portability workaround. Codex's own sandbox may depend on kernel/container capabilities: verify the actual image before claiming deployment support.

Tests use real Node child processes and no paid model calls. Windows tests validate execution and cancellation; Linux container tests additionally check descendant process-group termination. macOS and real authenticated Codex calls in every environment remain separate acceptance checks, not inferred from passing Linux fixtures.
