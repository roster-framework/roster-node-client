import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import type { ToolApproval } from "@roster/contracts";
import type { ApprovalRepository } from "../application/tool-approvals.js";
export class FileApprovalRepository implements ApprovalRepository {
  constructor(private directory: string) {
    mkdirSync(directory, { recursive: true });
  }
  list(): ToolApproval[] {
    return readdirSync(this.directory)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.directory, f), "utf8")));
  }
  save(record: ToolApproval) {
    if (!/^[a-zA-Z0-9-]+$/.test(record.id))
      throw new Error("Invalid approval ID");
    const path = join(this.directory, record.id + ".json");
    writeFileSync(path + ".tmp", JSON.stringify(record, null, 2));
    renameSync(path + ".tmp", path);
  }
}
