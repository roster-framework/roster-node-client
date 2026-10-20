import type { RunInput } from '@roster/contracts';

// Preserve Core's invocation independently from caller/agent mutation. The wire
// contract is JSON; cloning also disconnects nested business/resource objects.
export function snapshotAgentInvocation<T extends RunInput>(input: T): T {
  const copy = structuredClone(input);
  const seen = new WeakSet<object>();
  const pending: unknown[] = [copy];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    for (const child of Object.values(value)) pending.push(child);
    Object.freeze(value);
  }
  return copy;
}
