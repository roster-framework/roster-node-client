import test from "node:test";
import assert from "node:assert/strict";
import { run } from "./resource.mjs";
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test("CLI shares service API and refuses remote HTTP before sending credentials", async () => {
  let received;
  const env = { ROSTER_RESOURCE_TOKEN: "service-test-token-32-characters-long" };
  const result = await run(["list"], env, async (url, options) => {
    received = { url: String(url), options };
    return new Response(JSON.stringify([{ id: "docs" }]), { status: 200 });
  });
  assert.deepEqual(result, [{ id: "docs" }]);
  assert.equal(received.url, "http://127.0.0.1:7340/v1/resources");
  assert.equal(received.options.headers.Authorization, `Bearer ${env.ROSTER_RESOURCE_TOKEN}`);
  assert.equal(received.options.redirect, "error");
  await run(['history','brief','1','2'],env,async(url,options)=>{assert.equal(String(url),'http://127.0.0.1:7340/v1/resources/brief/history?limit=1&after=2');assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,`Bearer ${env.ROSTER_RESOURCE_TOKEN}`);return new Response('{}');});
  await assert.rejects(run(["list"], { ...env, ROSTER_RESOURCE_URL: "http://remote.example" }, () => { throw new Error("credential leak"); }), /Invalid resource/);
});

test('document invoke CLI forwards the selected path and distinct definition/original versions', async () => {
  const directory=await mkdtemp(join(tmpdir(),'roster-resource-cli-'));
  const file=join(directory,'operation.json');
  const operation={name:'publish',expected_version:7,arguments:{source_kind:'upload',title:'First',body:'content',change_id:'stable',expected_version:0}};
  try {
    await writeFile(file,JSON.stringify(operation),{flag:'wx'});
    const env={ROSTER_RESOURCE_TOKEN:'service-test-token-32-characters-long'};
    const value=await run(['invoke','original',file],env,async(url,options)=>{
      assert.equal(String(url),'http://127.0.0.1:7340/v1/resources/original/invoke');
      assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
      assert.equal(options.headers.Authorization,`Bearer ${env.ROSTER_RESOURCE_TOKEN}`);
      assert.deepEqual(JSON.parse(options.body),operation);
      return new Response(JSON.stringify({id:'original',version:1}));
    });
    assert.deepEqual(value,{id:'original',version:1});
    await assert.rejects(run(['invoke','original',file],env,async()=>new Response('{}',{status:409})),/status 409/);
  } finally {await unlink(file);await rmdir(directory);}
});
