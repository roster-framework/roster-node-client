import {z} from 'zod';

const Counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Cursor = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const SessionDeliveryState = z.enum(['pending', 'complete']);
export const SessionDeliveryQuery = z.object({
  state: z.enum(['all', 'pending', 'complete']).default('all'),
  limit: z.number().int().min(1).max(100).default(50),
  after: z.union([Cursor, z.literal('')]).default(''),
}).strict();
export type SessionDeliveryQuerySpec = z.infer<typeof SessionDeliveryQuery>;

export const SessionDeliveryAttempt = z.object({
  at: z.iso.datetime({offset:true}), outcome: z.enum(['ok', 'error']),
  stage: z.enum(['read', 'validate', 'archive', 'checkpoint', 'ack', 'complete', 'transfer']),
  duration_ms: Counter, count: Counter.min(1), failures: Counter, consecutive_failures: Counter,
}).strict().refine(a => a.failures <= a.count && a.consecutive_failures <= a.failures &&
  (a.outcome === 'ok'
    ? a.stage === 'transfer' && a.consecutive_failures === 0 && a.failures < a.count
    : a.stage !== 'transfer' && a.consecutive_failures > 0));
export const SessionDeliveryStatus = z.object({
  execution_id: Cursor, work_id: z.string().min(1), member_id: z.string(), unit_id: z.string(),
  confirmed_through: Counter, complete: z.boolean(), state: SessionDeliveryState,
  last_attempt: SessionDeliveryAttempt.optional(),
}).strict().refine(d => d.complete === (d.state === 'complete'));
export type SessionDeliveryStatusSpec = z.infer<typeof SessionDeliveryStatus>;
export const SessionDeliveryStatusPage = z.object({
  items: z.array(SessionDeliveryStatus).max(100), next_after: Cursor.optional(),
}).strict();
export type SessionDeliveryStatusPageSpec = z.infer<typeof SessionDeliveryStatusPage>;

// Current keyset read, not a snapshot, total count or creation-time ordering.
// JSON Schema consumers must enforce these ordering/query-dependent rules too.
export function validateSessionDeliveryPage(value: unknown, input: z.input<typeof SessionDeliveryQuery> = {}): SessionDeliveryStatusPageSpec {
  const q = SessionDeliveryQuery.parse(input), page = SessionDeliveryStatusPage.parse(value);
  if (page.items.length > q.limit || page.next_after !== undefined &&
    (page.items.length !== q.limit || page.next_after !== page.items.at(-1)?.execution_id))
    throw Error('Invalid session delivery page');
  let previous = q.after;
  for (const item of page.items) {
    if (item.execution_id <= previous || q.state !== 'all' && item.state !== q.state)
      throw Error('Invalid session delivery page');
    previous = item.execution_id;
  }
  return page;
}
