import { z } from "zod";
const candidate = z.object({member_id:z.string(), name:z.string(), accept:z.array(z.string()).nullable().optional()});
const contract = z.object({candidates:z.array(candidate).min(1).max(100), max_steps:z.number().int().min(1).max(12)});
const step = z.object({member_id:z.string(), instruction:z.string().max(10000).optional(), accept:z.array(z.string()).optional()}).strict();
export const delegationPrompt = "This is a planning stage. Do not execute the delegated work. Return output as a JSON string containing {\"delegation\":[{\"member_id\":\"candidate ID\",\"instruction\":\"specific task\",\"accept\":[\"declared completion status\"]}]}. Select only input.delegation.candidates. Human candidates have no statuses and need no accept. Never delegate recursively. Preserve the task's completion criteria.";
export function managedOutput(text: string, delegation: unknown): Record<string, unknown> {
  if (delegation === undefined) return {text};
  const allowed = contract.parse(delegation);
  const output = z.object({delegation:z.array(step).min(1).max(allowed.max_steps)}).strict().parse(JSON.parse(text));
  for (const s of output.delegation) {
    const c = allowed.candidates.find(c => c.member_id === s.member_id);
    if (!c || (c.accept?.length && !s.accept?.length) || s.accept?.some(status => !c.accept?.includes(status))) throw new Error("Delegation must use allowed members and their declared completion statuses");
  }
  return output;
}
