import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { z } from "zod";
import { modelUsageRecord, type ModelUsage } from "../domain/model-usage.js";
import type {
  ModelExecution,
  PythonAgentWorker,
} from "../domain/model-execution.js";

const reply = z
  .object({
    status: z.string(),
    summary: z.string(),
    output: z.string(),
    event: z.string(),
  })
  .strict();
const frameLimit = 1_000_000;
const suspensionRequest = z.object({
  type: z.literal('suspend'),
  wait_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
  checkpoint: z.record(z.string(), z.unknown()),
}).strict();
class PythonWorkerFailure extends Error {}
const failureMessages: Record<string, string> = {
  sdk_missing: 'Python SDK integration unavailable; install the selected framework/provider in ROSTER_PYTHON_EXECUTABLE',
  invalid_configuration: 'Python model configuration or structured result rejected; check provider, model and SDK parameters',
  execution_failed: 'Python model execution failed; check provider availability and runtime deployment',
};
export class LocalPythonAgentWorker implements PythonAgentWorker {
  constructor(
    private executable = process.env.ROSTER_PYTHON_EXECUTABLE,
    private script = fileURLToPath(
      new URL("../../python/roster_agents/worker.py", import.meta.url),
    ),
    private credential: (reference: string) => string | undefined = (reference) => process.env[reference],
  ) {}
  private environment(config: ModelExecution["config"], workspace: string) {
    const env: NodeJS.ProcessEnv = {
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
    };
    const allowed = [
      "PATH",
      "Path",
      "SYSTEMROOT",
      "SystemRoot",
      "WINDIR",
      "TEMP",
      "TMP",
      "HOME",
      "USERPROFILE",
      ...String(process.env.ROSTER_PYTHON_ENV_ALLOWLIST ?? "")
        .split(",")
        .filter(Boolean),
    ];
    if (config.credential_env) allowed.push(config.credential_env);
    for (const name of allowed)
      if (process.env[name]) env[name] = process.env[name];
    if (config.credential_env) {
      const key = this.credential(config.credential_env);
      if (key) env[config.credential_env] = key;
      else delete env[config.credential_env];
    }
    // Framework account files and caches must not read the operator's profile.
    Object.assign(env, {
      HOME: workspace,
      USERPROFILE: workspace,
      APPDATA: join(workspace, "AppData", "Roaming"),
      LOCALAPPDATA: join(workspace, "AppData", "Local"),
      XDG_CONFIG_HOME: join(workspace, ".sdk-state"),
      XDG_DATA_HOME: join(workspace, ".sdk-state"),
      XDG_CACHE_HOME: join(workspace, ".sdk-state"),
      CREWAI_STORAGE_DIR: join(workspace, ".sdk-state"),
      TEMP: join(workspace, ".sdk-state"),
      TMP: join(workspace, ".sdk-state"),
    });
    return env;
  }
  private async exchange(
    config: ModelExecution["config"],
    payload: unknown,
    signal: AbortSignal,
    receive: (
      frame: Record<string, unknown>,
      send: (value: unknown) => void,
    ) => Promise<void>,
    workspace?: string,
  ) {
    if (!this.executable)
      throw new Error(
        "Set ROSTER_PYTHON_EXECUTABLE to an installed Python environment",
      );
    signal.throwIfAborted();
    const parent = resolve(
      process.env.ROSTER_DATA_DIR || ".roster",
      "python-workers",
    );
    await mkdir(parent, { recursive: true });
    const directory = workspace
      ? resolve(workspace)
      : await mkdtemp(join(parent, "validation-"));
    await mkdir(join(directory, ".sdk-state"), { recursive: true });
    await mkdir(join(directory, "AppData", "Roaming"), { recursive: true });
    await mkdir(join(directory, "AppData", "Local"), { recursive: true });
    let closed = Promise.resolve();
    try {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.executable!, ["-u", this.script], {
          cwd: directory,
          shell: false,
          windowsHide: true,
          env: this.environment(config, directory),
          stdio: ["pipe", "pipe", "pipe"],
        });
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        closed = new Promise<void>((done) =>
          child.once("close", () => {
            clearTimeout(killTimer);
            done();
          }),
        );
        let buffer = Buffer.alloc(0),
          total = 0,
          queue = Promise.resolve(),
          settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          clearTimeout(timer);
          child.stdin.destroy();
          if (child.exitCode === null) {
            child.kill();
            killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
            killTimer.unref();
          }
          error ? reject(error) : resolve();
        };
        const abort = () => finish(new Error("Python agent cancelled"));
        const timer = setTimeout(
          () => finish(new Error("Python worker timed out")),
          600000,
        );
        signal.addEventListener("abort", abort, { once: true });
        const send = (value: unknown) => {
          if (settled || signal.aborted)
            throw new Error("Python worker closed");
          const line = JSON.stringify(value) + "\n";
          if (Buffer.byteLength(line) > frameLimit)
            throw new Error("Python request exceeds bridge limit");
          child.stdin.write(line);
        };
        child.on("error", () =>
          finish(new Error("Python executable could not be started")),
        );
        child.stderr.on("data", () => {
          /* SDK diagnostics may contain credentials; never publish them. */
        });
        child.stdout.on("data", (bytes: Buffer) => {
          if (settled) return;
          total += bytes.length;
          if (total > 10_000_000)
            return finish(new Error("Python output limit exceeded"));
          buffer = Buffer.concat([buffer, bytes]);
          for (let pos; (pos = buffer.indexOf(10)) >= 0;) {
            const line = buffer.subarray(0, pos);
            buffer = buffer.subarray(pos + 1);
            if (line.length > frameLimit)
              return finish(new Error("Python frame limit exceeded"));
            queue = queue
              .then(async () => {
                if (settled) return;
                signal.throwIfAborted();
                const frame = JSON.parse(line.toString("utf8"));
                if (!frame || typeof frame !== "object" || Array.isArray(frame))
                  throw new Error("Invalid Python frame");
            if (frame.type === 'error' && typeof frame.code === 'string' && Object.hasOwn(failureMessages, frame.code))
              throw new PythonWorkerFailure(failureMessages[frame.code]);
            await receive(frame, send);
              })
          .catch((error) =>
                finish(
              error instanceof PythonWorkerFailure ? error : new Error(
                    "Python agent failed; check engine, model and parameters",
                  ),
                ),
              );
          }
          if (buffer.length > frameLimit)
            finish(new Error("Python frame limit exceeded"));
        });
        child.on("close", (code) => {
          void queue.then(() => {
            if (code !== 0 || buffer.length)
              finish(
                new Error(
                  "Python agent failed; check installed SDK and model settings",
                ),
              );
            else finish();
          });
        });
        try {
          send(payload);
        } catch (error) {
          finish(error as Error);
        }
      });
    } finally {
      // Cancellation acknowledges the stop request; directory removal waits
      // for the original worker process to actually release its handles.
      await closed;
      const path = relative(parent, directory);
      if (!workspace && path && !path.startsWith("..") && !path.includes(":"))
        await rm(directory, { recursive: true, force: true });
    }
  }
  async validate(config: ModelExecution["config"]) {
    let ready = false;
    await this.exchange(
      config,
      { type: "validate", config },
      AbortSignal.timeout(15000),
      async (frame) => {
        if (frame.type !== "ready" || ready)
          throw new Error("Invalid Python validation frame");
        ready = true;
      },
    );
    if (!ready) throw new Error("Python engine validation failed");
  }
  async execute(
    input: ModelExecution,
    signal: AbortSignal,
    log: (text: string) => void,
    invoke: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    suspendForReply?: (waitId: string, checkpoint: Record<string, unknown>) => never,
    recordModelUsage?: (usage: ModelUsage) => void,
  ) {
    let result: z.infer<typeof reply> | undefined;
    let suspension: z.infer<typeof suspensionRequest> | undefined;
    const calls = new Set<string>();
    await this.exchange(
      input.config,
      { type: "execute", ...input },
      signal,
      async (frame, send) => {
        if (result || suspension) throw new Error("Python emitted output after completion");
        if (frame.type === "model-usage") {
          // Reuse the Runtime contract; never forward arbitrary bridge payloads.
          // The host assigns archive time and scope, not the child process.
          const record = modelUsageRecord(frame.value as ModelUsage, new Date().toISOString());
          const { at: _at, ...usage } = JSON.parse(record.text).usage;
          recordModelUsage?.(usage);
          return;
        }
        if (frame.type === 'suspend') {
          suspension = suspensionRequest.parse(frame);
          if (Buffer.byteLength(JSON.stringify(suspension.checkpoint)) > 65536)
            throw new Error('Python suspension checkpoint exceeds the limit');
          return;
        }
        if (
          frame.type === "log" &&
          typeof frame.text === "string" &&
          frame.text.length <= 20000
        ) {
          log(frame.text);
          return;
        }
        if (frame.type === "result") {
          result = reply.parse(frame.value);
          return;
        }
        if (
          frame.type !== "tool" ||
          typeof frame.id !== "string" ||
          !/^[a-zA-Z0-9-]{1,100}$/.test(frame.id) ||
          calls.has(frame.id) ||
          calls.size >= 100 ||
          typeof frame.name !== "string" ||
          !frame.args ||
          typeof frame.args !== "object" ||
          Array.isArray(frame.args)
        )
          throw new Error("Invalid Python tool call");
        calls.add(frame.id);
        if (!input.tools.some((t) => t.name === frame.name))
          throw new Error("Unknown Python tool");
        try {
          const value = await invoke(
            frame.name,
            frame.args as Record<string, unknown>,
          );
          signal.throwIfAborted();
          send({ type: "tool-result", id: frame.id, value });
        } catch {
          throw new Error("Python tool rejected");
        }
      },
      input.workspace,
    );
    // exchange waits for the original child to close. A dirty exit, abort or
    // further frame never reaches the Runtime-owned suspension request.
    signal.throwIfAborted();
    if (suspension) {
      if (!suspendForReply) throw new Error('Python suspension is unavailable');
      return suspendForReply(suspension.wait_id, suspension.checkpoint);
    }
    if (!result) throw new Error("Python returned no result");
    return result;
  }
}
