import {z} from 'zod';
const id=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
// Execution-token-only projection. Hash the received wire bytes, never a
// parsed object: defaults, large numbers and escaping can change serialization.
export const InvocationAuthority=z.object({
 protocol:z.literal('roster-invocation-authority/1'),
 execution_id:id,work_id:id,runtime_id:id,agent_id:id,
 request_sha256:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type InvocationAuthoritySpec=z.infer<typeof InvocationAuthority>;
