import type { RunFrame } from "@roster/contracts";
import type { SessionRecord } from "./session-delivery.js";

export type SessionNote = {
  kind: "log" | "decision" | "note" | "knowhow";
  text: string;
};

export type SessionFrame = {
  type: "session";
  session: SessionNote & { id: string; at: string };
};

// This optional stream extension is enabled by core's capability header.
export type RuntimeFrame = (RunFrame & { session?: SessionRecord }) | SessionFrame;
