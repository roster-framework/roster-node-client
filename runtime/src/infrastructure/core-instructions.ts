import type { RunInput } from "@roster/contracts";

// Kept separate from the runtime-owned configuration; never persisted into it.
export function coreInstructionPrompt(input: RunInput): string {
  const instruction = input.context.core_instructions;
  const persistent = instruction?.text
    ? `\nCore-managed instructions (version ${instruction.version}):\n${instruction.text}`
    : "";
  const delivery = input.context.subscription_delivery;
  return persistent + (delivery?.instruction ? `\nCore subscription instruction (${delivery.signal}):\n${delivery.instruction}` : "");
}
