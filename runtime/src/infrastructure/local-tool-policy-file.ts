import { open } from "node:fs/promises";
import { validLocalToolPolicy, type LocalToolPolicy, type LocalToolPolicySource } from "../domain/local-tool-policy.js";

// Loaded from a host environment path, never from Core invocation parameters.
export class FileLocalToolPolicy implements LocalToolPolicySource {
  constructor(private readonly path: string) {}
  async current(): Promise<LocalToolPolicy> {
    const file = await open(this.path, "r");
    try {
      const bytes = Buffer.alloc(65537);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 65536) throw new Error("Local tool policy unavailable");
      const value: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
      if (!validLocalToolPolicy(value)) throw new Error("Local tool policy unavailable");
      return value;
    } finally { await file.close(); }
  }
}
