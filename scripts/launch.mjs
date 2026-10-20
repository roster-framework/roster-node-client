#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, readdirSync, readFileSync } from 'node:fs';
import { access, chmod, lstat, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_ROOT = join(ROOT, 'runtime');
const RESOURCE_ROOT = join(ROOT, 'resource');
const RESERVED = new Set(['PATH','SYSTEMROOT','WINDIR','HOME','USERPROFILE','HOMEDRIVE','HOMEPATH','TMP','TEMP','TMPDIR','LANG','LC_ALL','COMSPEC','PATHEXT','NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','REQUEST_METHOD','SSL_CERT_FILE','SSL_CERT_DIR','CURL_CA_BUNDLE','GODEBUG','GOGC','GOMAXPROCS','GOMEMLIMIT','GOTRACEBACK','PORT','ROSTER_LISTEN','ROSTER_DATA_DIR','ROSTER_TLS_CERT','ROSTER_TLS_KEY','ROSTER_TOKEN','ROSTER_RESOURCE_TOKEN','ROSTER_RESOURCE_ADMIN_TOKEN','ROSTER_AGENT_MODULE','ROSTER_AGENT_OPTIONS']);
const TOTAL_MS = 30_000;
const STARTUP_MS = 60_000;
const SERVICE_ENV_KEYS = ['ROSTER_TOKEN','ROSTER_RESOURCE_TOKEN','ROSTER_RESOURCE_ADMIN_TOKEN'];

class LaunchFailure extends Error {
  constructor(component, code, exit = 2) { super(code); this.component = component; this.code = code; this.exit = exit; }
}
function fail(component, code, exit = 2) { throw new LaunchFailure(component, code, exit); }
function jsonResult(phase, component, code, children = {}, unresolved = []) {
  process.stdout.write(`${JSON.stringify({ schema:'roster-launch-result/1', phase, component, code, children, unresolved })}\n`);
}
function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
function overlap(a,b) { return inside(a,b) || inside(b,a); }
function parseStrict(text) {
  let i=0; const ws=()=>{while(/[\t\n\r ]/u.test(text[i]??'\0'))i++;}; const bad=()=>fail('preflight','json_invalid');
  const str=()=>{const start=i;if(text[i++]!=='"')return bad();while(i<text.length){const c=text.charCodeAt(i++);if(c===34){try{return JSON.parse(text.slice(start,i));}catch{return bad();}}if(c<32)return bad();if(c===92){const e=text[i++];if(e==='u'){if(!/^[\da-f]{4}$/iu.test(text.slice(i,i+4)))return bad();i+=4;}else if(!e||!('"\\/bfnrt'.includes(e)))return bad();}}return bad();};
  const value=(depth=0)=>{if(depth>64)return bad();ws();const c=text[i];if(c==='"')return str();if(c==='{'){i++;ws();const obj=Object.create(null),keys=new Set();if(text[i]==='}'){i++;return obj;}while(true){ws();if(text[i]!=='"')return bad();const k=str();if(keys.has(k))return bad();keys.add(k);ws();if(text[i++]!==':')return bad();obj[k]=value(depth+1);ws();if(text[i]==='}'){i++;return obj;}if(text[i++]!==',')return bad();}}if(c==='['){i++;ws();const arr=[];if(text[i]===']'){i++;return arr;}while(true){arr.push(value(depth+1));ws();if(text[i]===']'){i++;return arr;}if(text[i++]!==',')return bad();}}for(const [s,v] of [['true',true],['false',false],['null',null]])if(text.startsWith(s,i)){i+=s.length;return v;}const n=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(i))?.[0];if(n){i+=n.length;const v=Number(n);if(Number.isFinite(v))return v;}return bad();};
  const out=value();ws();if(i!==text.length)return bad();return out;
}
function exactKeys(obj,required,optional=[]) {
  if(!obj||typeof obj!=='object'||Array.isArray(obj))fail('preflight','config_invalid');
  const allowed=new Set([...required,...optional]);if(Object.keys(obj).some(k=>!allowed.has(k))||required.some(k=>!(k in obj)))fail('preflight','config_invalid');
}
export function parseAgentOptions(value) {
  const options=value===undefined?Object.create(null):value;
  if(!options||typeof options!=='object'||Array.isArray(options))fail('preflight','agent_options_invalid');
  let serialized;try{serialized=JSON.stringify(options);}catch{fail('preflight','agent_options_invalid');}
  if(typeof serialized!=='string')fail('preflight','agent_options_invalid');
  if(Buffer.byteLength(serialized,'utf8')>16*1024)fail('preflight','agent_options_too_large');
  return serialized;
}
export function parseProviderEnvNames(value) {
  const names=value===undefined?[]:value;
  if(!Array.isArray(names)||names.length>16||new Set(names).size!==names.length||names.some(name=>typeof name!=='string'||!/^[A-Z][A-Z0-9_]{0,99}$/u.test(name)||name.startsWith('LD_')||RESERVED.has(name)))fail('preflight','resource_provider_env_invalid');
  return names;
}
export function validateServiceAndProviderEnv(envDocument,providerNames) {
  exactKeys(envDocument,['env']);const env=envDocument.env,allowed=new Set([...SERVICE_ENV_KEYS,...providerNames]);
  if(!env||typeof env!=='object'||Array.isArray(env)||Object.keys(env).some(name=>!allowed.has(name)))fail('preflight','env_invalid');
  for(const name of [...SERVICE_ENV_KEYS,...providerNames])if(typeof env[name]!=='string'||env[name].length===0)fail('preflight','env_invalid');
  const tokens={runtime:env.ROSTER_TOKEN,resource:env.ROSTER_RESOURCE_TOKEN,admin:env.ROSTER_RESOURCE_ADMIN_TOKEN};
  if(tokens.runtime.length<24||tokens.resource.length<32||tokens.admin.length<32||new Set(Object.values(tokens)).size!==3)fail('preflight','env_invalid');
  const providerEnv=Object.create(null);
  for(const name of providerNames){if(env[name].length===0)fail('preflight','env_invalid');if(Buffer.byteLength(env[name],'utf8')>16*1024)fail('preflight','resource_provider_value_too_large');providerEnv[name]=env[name];}
  return {tokens,providerEnv};
}
function strictOwnerOnly(info,directory) {
  if(process.platform==='win32')return;
  if(typeof process.getuid==='function'&&info.uid!==process.getuid())fail('preflight','owner_mismatch');
  if((info.mode&0o077)!==0)fail('preflight',directory?'data_permissions':'file_permissions');
}
async function noSymlinkPath(target) {
  const absolute=resolve(target),root=parse(absolute).root;let current=root;
  for(const part of absolute.slice(root.length).split(sep).filter(Boolean)){current=join(current,part);const info=await lstat(current).catch(()=>fail('preflight','path_missing'));if(info.isSymbolicLink())fail('preflight','path_reparse');}
  return absolute;
}
async function checkExistingParents(target) {
  const absolute=resolve(target),root=parse(absolute).root;let current=root;
  for(const part of absolute.slice(root.length).split(sep).filter(Boolean)){current=join(current,part);let info;try{info=await lstat(current);}catch(e){if(e.code==='ENOENT')return;fail('preflight','path_invalid');}if(info.isSymbolicLink())fail('preflight','path_reparse');if(current!==absolute&&!info.isDirectory())fail('preflight','path_invalid');}
}
async function ordinaryFile(target,{executable=false,max=64*1024,ownerOnly=false}={}) {
  await noSymlinkPath(target);const info=await lstat(target).catch(()=>fail('preflight','path_missing'));if(!info.isFile()||info.size>max)fail('preflight','file_invalid');if(ownerOnly)strictOwnerOnly(info,false);if(executable&&process.platform!=='win32')await access(target,fsConstants.X_OK).catch(()=>fail('preflight','not_executable'));return info;
}
async function readJson(target) {
  await ordinaryFile(target,{ownerOnly:true});let raw;try{raw=new TextDecoder('utf-8',{fatal:true}).decode(await readFile(target));}catch{fail('preflight','file_invalid');}
  if(Buffer.byteLength(raw,'utf8')>64*1024)fail('preflight','size_limit');return parseStrict(raw);
}
function outsideRepos(candidate) { if([ROOT].some(repo=>overlap(repo,candidate)))fail('preflight','path_in_repository'); }
function resolvePath(value,base) { if(typeof value!=='string'||!value.trim())fail('preflight','path_invalid');return resolve(base,value); }
function parseArgs(argv) { if(argv.length!==2||argv[0]!=='--config'||!argv[1]||argv[1].startsWith('--'))fail('preflight','usage_invalid');return resolve(argv[1]); }
async function portFree(port) {
  const server=createServer();await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolveListen);}).catch(e=>{if(['EADDRINUSE','EACCES'].includes(e.code))fail('preflight','port_unavailable');fail('preflight','port_probe_failed',2);});
  await new Promise((resolveClose,reject)=>server.close(e=>e?reject(e):resolveClose()));
}
function childBaseEnv() {
  const names=['PATH','SystemRoot','WINDIR','HOME','USERPROFILE','HOMEDRIVE','HOMEPATH','TMP','TEMP','TMPDIR','LANG','LC_ALL','COMSPEC','PATHEXT'];
  const env=Object.create(null);for(const name of names)if(process.env[name]!==undefined)env[name]=process.env[name];return env;
}
async function prepare(configPath,started) {
  if(performance.now()-started>TOTAL_MS)fail('preflight','preflight_timeout',2);
  await ordinaryFile(configPath,{ownerOnly:true});const config=await readJson(configPath);
  exactKeys(config,['schema','data_root','env_file','runtime_entry','resource_binary'],['runtime_port','resource_port','agent_module','agent_options','resource_provider_env']);
  if(config.schema!=='roster-launch/1')fail('preflight','config_invalid');
  const runtimePort=config.runtime_port??7331,resourcePort=config.resource_port??7340;
  if(!Number.isInteger(runtimePort)||runtimePort<1||runtimePort>65535||!Number.isInteger(resourcePort)||resourcePort<1||resourcePort>65535||runtimePort===resourcePort)fail('preflight','port_invalid');
  const base=dirname(configPath),paths={data:resolvePath(config.data_root,base),envFile:resolvePath(config.env_file,base),runtime:resolvePath(config.runtime_entry,base),resource:resolvePath(config.resource_binary,base),agent:config.agent_module===undefined?null:resolvePath(config.agent_module,base)};
  for(const candidate of [configPath,paths.data,paths.envFile,paths.agent].filter(Boolean))outsideRepos(candidate);
  const external=[configPath,paths.data,paths.envFile,paths.agent].filter(Boolean);for(let i=0;i<external.length;i++)for(let j=i+1;j<external.length;j++)if(overlap(external[i],external[j]))fail('preflight','path_overlap');
  const agentOptions=parseAgentOptions(config.agent_options),providerNames=parseProviderEnvNames(config.resource_provider_env);
  await ordinaryFile(paths.envFile,{ownerOnly:true});const doc=await readJson(paths.envFile);
  const {tokens,providerEnv}=validateServiceAndProviderEnv(doc,providerNames);
  const expectedRuntime=join(RUNTIME_ROOT,'dist','main.js');if(paths.runtime!==expectedRuntime)fail('preflight','runtime_entry_invalid');
  await ordinaryFile(paths.runtime,{max:16*1024*1024});
  for(const dir of [join(RUNTIME_ROOT,'node_modules'),join(RUNTIME_ROOT,'presets')]){await noSymlinkPath(dir);const info=await lstat(dir);if(!info.isDirectory())fail('preflight','runtime_prerequisite_missing');}
  await ordinaryFile(paths.resource,{executable:true,max:2*1024*1024*1024});
  if(paths.agent){outsideRepos(paths.agent);await ordinaryFile(paths.agent,{max:16*1024*1024});}
  const dataInfo=await lstat(paths.data).catch(()=>null);if(dataInfo){if(!dataInfo.isDirectory())fail('preflight','data_root_invalid');await noSymlinkPath(paths.data);strictOwnerOnly(dataInfo,true);}
  await portFree(runtimePort);await portFree(resourcePort);
  if(performance.now()-started>TOTAL_MS)fail('preflight','preflight_timeout',2);
  return {config,paths,tokens,providerEnv,agentOptions,runtimePort,resourcePort,started};
}
async function initDataRoot(path) {
  await checkExistingParents(path);let created=false;try{await mkdir(path,{mode:0o700});created=true;}catch(e){if(e.code!=='EEXIST')fail('preflight','data_root_invalid');}
  await noSymlinkPath(path);let info=await lstat(path);if(!info.isDirectory())fail('preflight','data_root_invalid');if(created&&process.platform!=='win32')await chmod(path,0o700);info=await lstat(path);strictOwnerOnly(info,true);
  const marker=join(path,'.roster-launcher.json'),old=await lstat(marker).catch(()=>null);
  if(old){if(!old.isFile()||old.isSymbolicLink()||old.size>1024)fail('preflight','marker_invalid');const value=parseStrict(await readFile(marker,'utf8'));exactKeys(value,['schema','role']);if(value.schema!=='roster-launch/1'||value.role!=='node-client')fail('preflight','marker_mismatch');}
  else{if((await readdir(path)).length!==0)fail('preflight','data_root_unmanaged');await writeOwned(marker,JSON.stringify({schema:'roster-launch/1',role:'node-client'}));}
}
async function writeOwned(path,text) {const handle=await open(path,'wx',0o600).catch(()=>fail('preflight','lock_conflict'));try{await handle.writeFile(text,'utf8');await handle.sync();}finally{await handle.close();}}
async function acquireLock(root) {const path=join(root,'launcher.lock'),token=randomUUID();await writeOwned(path,JSON.stringify({run_id:token,pid:process.pid}));return {path,token};}
async function releaseLock(lock) {
  if(!lock)return true;try{const info=await lstat(lock.path);if(!info.isFile()||info.isSymbolicLink()||info.size>1024)return false;const value=parseStrict(await readFile(lock.path,'utf8'));exactKeys(value,['run_id','pid']);if(value.run_id!==lock.token||value.pid!==process.pid)return false;await unlink(lock.path);return true;}catch{return false;}
}
async function initServiceData(path) {
  await checkExistingParents(path);let created=false;try{await mkdir(path,{mode:0o700});created=true;}catch(e){if(e.code!=='EEXIST')fail('preflight','data_directory_invalid');}
  await noSymlinkPath(path);const info=await lstat(path);if(!info.isDirectory())fail('preflight','data_directory_invalid');if(created&&process.platform!=='win32')await chmod(path,0o700);strictOwnerOnly(await lstat(path),true);
}
function spawnOwned(name,exe,args,cwd,env) {
  const child=spawn(exe,args,{cwd,env,stdio:'ignore',detached:process.platform!=='win32',windowsHide:true});
  const rec={name,child,pid:null,group:process.platform!=='win32',code:null,signal:null,exited:false,exitPromise:null};
  rec.exitPromise=new Promise(resolveExit=>{child.once('error',()=>{rec.exited=true;resolveExit(rec);});child.once('exit',(code,signal)=>{rec.code=code;rec.signal=signal;rec.exited=true;resolveExit(rec);});});
  child.once('spawn',()=>{rec.pid=child.pid??null;});return rec;
}
function signalChild(rec,sig) {if(!rec.child.pid)return;try{if(rec.group)process.kill(-rec.pid,sig);else if(!rec.exited)rec.child.kill(sig);}catch(e){if(e.code!=='ESRCH')throw e;}}
function wait(ms){return new Promise(r=>setTimeout(r,ms));}
function groupAlive(child){
  if(!child.group||!child.pid)return false;try{process.kill(-child.pid,0);}catch(e){return e.code!=='ESRCH';}if(process.platform!=='linux')return true;
  try{for(const entry of readdirSync('/proc')){if(!/^\d+$/u.test(entry))continue;try{const stat=readFileSync(`/proc/${entry}/stat`,'utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/u);if(fields[2]===String(child.pid)&&fields[0]!=='Z'&&fields[0]!=='X')return true;}catch{}}return false;}catch{return true;}
}
async function waitAll(children,ms){const deadline=performance.now()+ms;while(true){if(children.every(c=>c.exited&&!groupAlive(c)))return true;const left=deadline-performance.now();if(left<=0)return false;await wait(Math.min(50,left));}}
async function terminate(children) {
  for(const c of children)signalChild(c,'SIGTERM');const graceful=await waitAll(children,12_000);
  if(!graceful){for(const c of children)if(!c.exited||c.group)signalChild(c,'SIGKILL');await waitAll(children,2_000);}
  return {forced:!graceful,unresolved:children.filter(c=>!c.exited||groupAlive(c)).map(c=>c.name)};
}
async function jsonHttp(url,timeout=2_000,externalSignal) {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
  const abort=()=>controller.abort();externalSignal?.addEventListener('abort',abort,{once:true});if(externalSignal?.aborted)abort();
  try{const res=await fetch(url,{redirect:'manual',signal:controller.signal});if(!res.ok){if(res.body)void res.body.cancel().catch(()=>{});return null;}if(!res.body)return null;const reader=res.body.getReader(),chunks=[];let size=0;try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>64*1024){void reader.cancel().catch(()=>{});return null;}chunks.push(item.value);}}finally{reader.releaseLock();}return parseStrict(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{return null;}finally{clearTimeout(timer);externalSignal?.removeEventListener('abort',abort);}
}
async function ready(children,deadline,runtimePort,resourcePort,signal) {
  while(performance.now()<deadline&&!signal.aborted){const exited=children.find(c=>c.exited);if(exited)fail(exited.name,'child_exited',3);const ms=Math.max(1,Math.min(2_000,deadline-performance.now()));
    const runtime=await jsonHttp(`http://127.0.0.1:${runtimePort}/health`,ms,signal);if(runtime?.ok===true&&typeof runtime.runtime_id==='string'&&runtime.runtime_id.length){const left=deadline-performance.now();if(left<=0)break;const resource=await jsonHttp(`http://127.0.0.1:${resourcePort}/health`,Math.max(1,Math.min(2_000,left)),signal);if(resource?.status==='ok'&&resource.service==='resource-server')return;}
    await wait(150);
  }fail('launcher','readiness_timeout',3);
}
function childSummary(children){return Object.fromEntries(children.map(c=>[c.name,c.code]));}
export async function launch(argv=process.argv.slice(2)) {
  const started=performance.now();let lock=null,children=[],signalName=null;let signalResolve;const signalPromise=new Promise(r=>signalResolve=r);
  const onInt=()=>{if(!signalName){signalName='SIGINT';signalResolve(signalName);}},onTerm=()=>{if(!signalName){signalName='SIGTERM';signalResolve(signalName);}};
  process.on('SIGINT',onInt);process.on('SIGTERM',onTerm);
  try{
    const configPath=parseArgs(argv),p=await prepare(configPath,started);await initDataRoot(p.paths.data);
    await initServiceData(join(p.paths.data,'runtime'));await initServiceData(join(p.paths.data,'resource'));lock=await acquireLock(p.paths.data);
    const runtimeEnv={...childBaseEnv(),ROSTER_TOKEN:p.tokens.runtime,ROSTER_LISTEN:'127.0.0.1',PORT:String(p.runtimePort),ROSTER_DATA_DIR:join(p.paths.data,'runtime'),ROSTER_AGENT_OPTIONS:p.agentOptions};if(p.paths.agent)runtimeEnv.ROSTER_AGENT_MODULE=p.paths.agent;
    const resourceEnv={...childBaseEnv(),...p.providerEnv,ROSTER_RESOURCE_TOKEN:p.tokens.resource,ROSTER_RESOURCE_ADMIN_TOKEN:p.tokens.admin,ROSTER_LISTEN:'127.0.0.1',PORT:String(p.resourcePort),ROSTER_DATA_DIR:join(p.paths.data,'resource')};
    children.push(spawnOwned('runtime',process.execPath,[p.paths.runtime],RUNTIME_ROOT,runtimeEnv));children.push(spawnOwned('resource',p.paths.resource,[],RESOURCE_ROOT,resourceEnv));
    const deadline=performance.now()+STARTUP_MS,startupAbort=new AbortController(),task=ready(children,deadline,p.runtimePort,p.resourcePort,startupAbort.signal);
    const result=await Promise.race([task.then(()=> 'ready'),signalPromise.then(()=> 'signal')]);if(result==='signal'){startupAbort.abort();await task.catch(()=>{});fail('launcher','startup_interrupted',3);}if(performance.now()>deadline)fail('launcher','readiness_timeout',3);
    jsonResult('ready','launcher',0);const firstExit=Promise.race(children.map(c=>c.exitPromise));const event=await Promise.race([signalPromise.then(signal=>({type:'signal',signal})),firstExit.then(child=>({type:'child',child}))]);
    if(event.type==='child'){const stopped=await terminate(children);const unresolved=[...stopped.unresolved];if(!unresolved.length){if(!await releaseLock(lock))unresolved.push('lock');else lock=null;}jsonResult('failed',event.child.name,3,childSummary(children),unresolved);return 3;}
    const stopped=await terminate(children),unresolved=[...stopped.unresolved];const okay=!stopped.forced&&!unresolved.length&&children.every(c=>c.code===0);
    if(!unresolved.length){if(!await releaseLock(lock))unresolved.push('lock');else lock=null;}const code=okay&&!unresolved.length?0:3;jsonResult(code===0?'stopped':'failed','launcher',code,childSummary(children),unresolved);return code;
  }catch(error){const failure=error instanceof LaunchFailure?error:new LaunchFailure('preflight','local_io_failure',2);let unresolved=[];if(children.length){const stopped=await terminate(children);unresolved=stopped.unresolved;}if(!unresolved.length&&lock){if(await releaseLock(lock))lock=null;else unresolved.push('lock');}const code=children.length?3:failure.exit;jsonResult('failed',failure.component,code,childSummary(children),unresolved);return code;}
  finally{process.removeListener('SIGINT',onInt);process.removeListener('SIGTERM',onTerm);if(lock&&children.length===0)await releaseLock(lock);}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)void launch().then(code=>{process.exitCode=code;}).catch(()=>{process.exitCode=3;});
