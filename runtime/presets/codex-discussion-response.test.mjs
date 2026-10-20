import {test} from 'node:test';
import assert from 'node:assert/strict';
import {discussionResponsePrompt} from './codex/discussion-response.mjs';
import {createAgentTemplates} from './codex/delegating.mjs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, sep, basename} from 'node:path';

const input = () => ({execution_id:'response-execution', input:{discussion:{thread_id:'shared-thread',message_id:'question',reply_to_id:'question',attachments:[{resource_id:'figma',version:2}]}}});
const options = {agentCalls:true,coreMcp:{url:'http://localhost:7330/mcp',token:'PRIVATE_TOKEN'.repeat(4)}};

test('one shared reply has stable IDs without expanding scope or exposing credentials', () => {
  const p = discussionResponsePrompt(input(), options);
  assert.equal(p, discussionResponsePrompt(input(), options));
  assert.match(p, /roster_read_discussion/);
  assert.match(p, /roster_append_discussion/);
  assert.match(p, /"thread_id":"shared-thread"/);
  assert.match(p, /"reply_to_id":"question"/);
  assert.match(p, /"id":"reply-[a-f0-9]{64}"/);
  assert.match(p, /"command":\{"version":1,"id":"reply-/);
  assert.match(p, /ordinary questions and answers omit kind/);
  assert.match(p, /never use kind reply, question or message/);
  assert.match(p, /do not ask for its parent work history/);
  assert.match(p, /Do not automatically tag/);
  assert.match(p, /authorized original thread/);
  assert.match(p, /kind meeting.approve/);
  assert.match(p, /meeting.revise with concrete corrections/);
  assert.match(p, /ordinary reply does not approve/);
  assert.match(p, /newer draft superseded/);
  assert.match(p, /same reply ID, kind, answer text/);
  assert.match(p, /meeting.draft with no reply_to_id/);
  assert.match(p, /draft ID \(not the approval ID\)/);
  assert.match(p, /byte-for-byte identical text/);
  assert.match(p, /Only if explicitly configured/);
  assert.match(p, /attachments and chosen mentions/);
  assert.ok(!p.includes('PRIVATE_TOKEN'));
  const other = input(); other.execution_id = 'other-execution';
  assert.notEqual(p, discussionResponsePrompt(other, options));
});

test('actual preset passes reply references to a child and refuses missing MCP before launch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'roster-reply-prompt-'));
  try {
    let launches = 0;
    // This is an actual child process, not a model or a saved business answer.
    const source = `let prompt='';process.stdin.on('data',x=>prompt+=x);process.stdin.on('end',()=>{
      const guided=prompt.includes('"thread_id":"shared-thread"')&&prompt.includes('"reply_to_id":"question"')&&prompt.includes('roster_append_discussion')&&prompt.includes('Report success only after the answer is saved');
      const privateData=prompt.includes('PRIVATE_TOKEN');
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'needs_help',summary:guided&&!privateData?'Reply guidance received; no answer was saved by this fixture':'Missing guidance or exposed credential',minutes:''})}}));
    });`;
    const template = createAgentTemplates({resolveLaunch:async () => {launches++; return {command:process.execPath,prefix:['--input-type=module','-e',source]};}})[0];
    const agent = template.create({id:'responder',name:'Responder',parameters:{project:directory}});
    const context = {signal:new AbortController().signal,log:()=>{},coreMcp:options.coreMcp};
    // Exercise actual JSON shapes emitted by Core's message serialization,
    // including nil attachments and current-version references (omitempty).
    for (const attachments of [input().input.discussion.attachments, null, [], [{resource_id:'figma'}]]) {
      const invocation = input(); invocation.input.discussion.attachments = attachments;
      const result = await agent.execute(JSON.parse(JSON.stringify(invocation)), context);
      assert.equal(result.status,'needs_help');
      assert.equal(result.summary,'Reply guidance received; no answer was saved by this fixture');
    }
    assert.equal(launches,4);
    await assert.rejects(() => agent.execute(input(), {...context,coreMcp:undefined}), /current Core MCP access/);
    assert.equal(launches,4);
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep) && basename(directory).startsWith('roster-reply-prompt-'));
    await rm(directory,{recursive:true,force:true});
  }
});

test('ordinary work does not acquire response behavior; malformed or missing tool access fails', () => {
  assert.equal(discussionResponsePrompt({input:{}}, {}), '');
  assert.throws(() => discussionResponsePrompt(input(), {agentCalls:false,coreMcp:options.coreMcp}), /delegation preset/);
  assert.throws(() => discussionResponsePrompt(input(), {agentCalls:true}), /Core MCP/);
  for (const mutate of [
    x => {x.execution_id='';},
    x => {x.input.discussion.thread_id='invalid?';},
    x => {x.input.discussion.reply_to_id='other-question';},
    x => {x.input.discussion.actor='other-member';},
    x => {x.input.discussion.kind='meeting.approve';},
    x => {x.input.discussion.reviewer_member_id='other-member';},
    x => {x.input.discussion.attachments='not-an-array';},
    x => {delete x.input.discussion.attachments;},
    x => {x.input.discussion.attachments[0].version=null;},
    x => {x.input.discussion.attachments[0].version=-1;},
    x => {x.input.discussion.attachments[0].version=Number.MAX_SAFE_INTEGER+1;},
    x => {x.input.discussion.attachments[0].body='private body';},
    x => {x.input.discussion.attachments.push({...x.input.discussion.attachments[0]});},
  ]) {
    const x = input(); mutate(x);
    assert.throws(() => discussionResponsePrompt(x, options), /requires an execution ID|Invalid discussion/);
  }
});
