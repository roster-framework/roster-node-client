import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionDeliverySummary} from '../dist/index.js';
export const empty = {total:0,pending:0,complete:0,observed:0,unobserved:0,pending_unobserved:0,pending_errors:0,recorded_attempts:0,recorded_failures:0,latest_errors:{read:0,validate:0,archive:0,checkpoint:0,ack:0,complete:0},latest_duration:{samples:0,sum_ms:0,min_ms:0,max_ms:0}};
test('delivery summaries reject partial totals, private labels and misleading duration/time samples',()=>{
 assert.deepEqual(SessionDeliverySummary.parse(empty),empty);
 const value={...empty,total:2,pending:1,complete:1,observed:2,pending_errors:1,recorded_attempts:5,recorded_failures:2,latest_errors:{...empty.latest_errors,archive:1},latest_duration:{samples:2,sum_ms:14,min_ms:4,max_ms:10},first_attempt_at:'2026-10-04T00:00:00Z',last_attempt_at:'2026-10-04T00:01:00Z'};
 assert.deepEqual(SessionDeliverySummary.parse(value),value);
 for(const change of [{total:3},{pending_unobserved:1},{recorded_attempts:1},{recorded_failures:6},{pending_errors:2},{latest_errors:{...value.latest_errors,private:'credential'}},{latest_duration:{...value.latest_duration,samples:1}},{latest_duration:{...value.latest_duration,sum_ms:9}},{latest_duration:{...value.latest_duration,sum_ms:Number.MAX_SAFE_INTEGER+1}},{first_attempt_at:'2026-10-04T01:00:00Z'},{first_attempt_at:undefined},{runtime_url:'private'}]) assert.equal(SessionDeliverySummary.safeParse({...value,...change}).success,false);
 assert.equal(SessionDeliverySummary.safeParse({...empty,total:100001,pending:100001,unobserved:100001,pending_unobserved:100001}).success,false);
 assert.equal(SessionDeliverySummary.safeParse({...empty,first_attempt_at:'2026-10-04T00:00:00Z'}).success,false);
 assert.equal(SessionDeliverySummary.safeParse({...value,first_attempt_at:'2026-10-04T00:00:00.000000002Z',last_attempt_at:'2026-10-04T00:00:00.000000001Z'}).success,false);
});
