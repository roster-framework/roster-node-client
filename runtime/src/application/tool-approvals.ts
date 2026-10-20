import { randomUUID } from "node:crypto";
import type { ToolApproval } from "@roster/contracts";
export interface ApprovalRepository {
  list(): ToolApproval[];
  save(record: ToolApproval): void;
}
export class ToolApprovals {
  private pending = new Map<string, (allowed: boolean) => void>();
  constructor(
    private repository: ApprovalRepository,
    private timeoutMs = 300000,
  ) {
    for (const record of repository.list())
      if (record.state === "pending" || record.state === "approved")
        repository.save({ ...record, state: "expired" });
  }
  list(agentId: string) {
    return this.repository
      .list()
      .filter((r) => r.agent_id === agentId)
      .sort(
        (a, b) =>
          Number(b.state === "pending") - Number(a.state === "pending") ||
          b.created.localeCompare(a.created),
      )
      .slice(0, 20);
  }
  async request(
    input: Pick<
      ToolApproval,
      "agent_id" | "execution_id" | "work_id" | "tool" | "arguments"
    >,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (
      this.repository
        .list()
        .filter((r) => r.agent_id === input.agent_id && r.state === "pending")
        .length >= 20
    )
      throw new Error("Too many pending tool approvals");
    const raw = JSON.stringify(input.arguments);
    if (Buffer.byteLength(raw) > 50000)
      throw new Error("Tool approval arguments exceed 50KB");
    const record: ToolApproval = {
      ...input,
      arguments: JSON.parse(raw),
      id: randomUUID(),
      state: "pending",
      created: new Date().toISOString(),
      expires: new Date(Date.now() + this.timeoutMs).toISOString(),
    };
    let release!: (allowed: boolean) => void;
    const decision = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    this.pending.set(record.id, release);
    const cancel = () => release(false);
    signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, this.timeoutMs);
    try {
      this.repository.save(record);
      const allowed = await decision;
      signal.throwIfAborted();
      const current = this.repository.list().find((r) => r.id === record.id)!;
      if (!allowed || Date.now() >= Date.parse(current.expires))
        throw new Error(
          current.state === "denied"
            ? "Tool execution denied"
            : "Tool approval expired",
        );
      this.repository.save({ ...current, state: "consumed" });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      this.pending.delete(record.id);
      const current = this.repository.list().find((r) => r.id === record.id);
      if (
        current &&
        (current.state === "pending" || current.state === "approved")
      )
        this.repository.save({ ...current, state: "expired" });
    }
  }
  decide(agentId: string, id: string, allow: boolean, actor: string) {
    const record = this.repository
      .list()
      .find((r) => r.id === id && r.agent_id === agentId);
    const release = this.pending.get(id);
    if (
      !record ||
      !release ||
      record.state !== "pending" ||
      Date.now() >= Date.parse(record.expires)
    )
      throw new Error("Approval request is no longer pending");
    this.repository.save({
      ...record,
      state: allow ? "approved" : "denied",
      decided_at: new Date().toISOString(),
      decided_by: actor,
    });
    release(allow);
  }
}
