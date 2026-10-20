import test from 'node:test';
import assert from 'node:assert/strict';
import {ResourceHistoryQuery,validateResourceHistoryPage,validateResourceDocumentList,validateResourceDocument} from '../dist/index.js';
const doc={id:'alias',unit_id:'organization',collection:'docs',source_kind:'upload',source_uri:'',title:'Title',version:1,updated:'2026-10-04T00:00:00Z'};
const item={version:1,title:'Title',updated:doc.updated};
test('history bounds, strict privacy, identity, ordering and query continuation',()=>{
 assert.deepEqual(ResourceHistoryQuery.parse({}),{limit:20,after:0});
 for(const q of [{limit:0},{limit:101},{after:-1},{after:Number.MAX_SAFE_INTEGER+1},{private:'token'}])assert.throws(()=>ResourceHistoryQuery.parse(q));
 assert.equal(validateResourceHistoryPage({resource_id:'alias',items:[item],next_after:1},'alias',{limit:1}).next_after,1);
 assert.deepEqual(validateResourceHistoryPage({resource_id:'alias',items:[]},'alias').items,[]);
 for(const page of [{resource_id:'other',items:[item]},{resource_id:'alias',items:[{...item,body:'private'}]},{resource_id:'alias',items:[item,item]},{resource_id:'alias',items:[item],next_after:2},{resource_id:'alias',items:[item],next_after:1},{resource_id:'alias',items:null},{resource_id:'alias',items:[{...item,version:Number.MAX_SAFE_INTEGER+1}]}])assert.throws(()=>validateResourceHistoryPage(page,'alias'));
 assert.throws(()=>validateResourceHistoryPage({resource_id:'alias',items:[item]},'alias',{after:1}));
});
test('metadata excludes originals and duplicate aliases; selected original matches exact version',()=>{
 assert.deepEqual(validateResourceDocumentList({resources:[doc]}),[doc]);
 for(const docs of [[{...doc,body:'private'}],[doc,doc],[{...doc,credentials:'private'}]])assert.throws(()=>validateResourceDocumentList({resources:docs}));
 const raw={resource:{...doc,body:'<script>no execution</script>'}};
 assert.equal(validateResourceDocument(raw,'alias',1).body,raw.resource.body);
 assert.throws(()=>validateResourceDocument(raw,'other',1));assert.throws(()=>validateResourceDocument(raw,'alias',2));
 assert.throws(()=>validateResourceDocument({resource:{...doc,provider_token:'private'}},'alias',1));
});
