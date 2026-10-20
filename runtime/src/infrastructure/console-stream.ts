import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";

/** Route console output from an invocation to that invocation's stream.
 * AsyncLocalStorage prevents concurrent executions from sharing a log sink.
 * Child-process stdout must still be piped explicitly by the agent adapter.
 */
export class ConsoleStreamCapture {
  private readonly sinks = new AsyncLocalStorage<(text: string) => void>();
  private readonly original = globalThis.console;
  private readonly replacement: Console;
  constructor() {
    this.replacement = Object.create(this.original) as Console;
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      this.replacement[method] = (...args: unknown[]) => {
        const sink = this.sinks.getStore();
        if (sink) sink(format(...args));
        else this.original[method](...args);
      };
    }
  }
  install() {
    globalThis.console = this.replacement;
  }
  run<T>(sink: (text: string) => void, action: () => Promise<T>): Promise<T> {
    return this.sinks.run(sink, action);
  }
  close() {
    if (globalThis.console === this.replacement)
      globalThis.console = this.original;
    this.sinks.disable();
  }
}
