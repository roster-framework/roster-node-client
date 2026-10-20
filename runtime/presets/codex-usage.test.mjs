import {test} from 'node:test';
import assert from 'node:assert/strict';
import {codexUsageObserver} from './codex/usage.mjs';

test('CLI terminal aggregate projects only declared usage and deduplicates replay', () => {
  const reports = [], observer = codexUsageObserver({recordModelUsage: value => reports.push(value)}, 'configured-model');
  const event = {type:'turn.completed', usage:{input_tokens:12, cached_input_tokens:8, output_tokens:0, prompt:'PRIVATE', request_id:'PRIVATE'}};
  observer.observe(event); observer.observe(event); observer.finish();
  assert.deepEqual(reports, [{version:1,invocation_id:'codex-cli-turn',provider:'codex-cli',model:'configured-model',
    phase:'unknown',state:'completed',input_tokens:12,output_tokens:0,cached_input_tokens:8}]);
  assert.ok(!JSON.stringify(reports).includes('PRIVATE'));
  assert.throws(() => observer.observe({type:'turn.completed',usage:{...event.usage,input_tokens:13}}), /Conflicting/);
});

test('missing, invalid and failed usage remain unknown without guessing model or cost', () => {
  for (const usage of [undefined, {input_tokens:-1,output_tokens:'7',cached_input_tokens:Infinity},
    {input_tokens:2,output_tokens:1.5,cached_input_tokens:3}]) {
    const reports = [], observer = codexUsageObserver({recordModelUsage: value => reports.push(value)});
    observer.observe({type:'turn.completed',usage}); observer.finish();
    assert.equal(reports.length,1); assert.equal(reports[0].model,'cli-default');
    assert.equal(reports[0].cached_input_tokens,null); assert.equal(reports[0].output_tokens,null);
  }
  for (const event of [undefined,{type:'turn.failed',error:{message:'PRIVATE'}}]) {
    const reports = [], observer = codexUsageObserver({recordModelUsage: value => reports.push(value)});
    if(event) observer.observe(event); observer.finish(); observer.finish();
    assert.equal(reports.length,1); assert.equal(reports[0].state,'failed');
    assert.equal(reports[0].input_tokens,null); assert.ok(!JSON.stringify(reports).includes('PRIVATE'));
  }
});
