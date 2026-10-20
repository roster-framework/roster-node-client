import {record,bytes} from './value.mjs';
const reserved=/api.?key|credential|authorization|header|(?:base|server|api).*url|endpoint|client|callback|configurable|(?:access|auth|session|bearer).*token|^(?:token|configuration|model|model.?provider|provider|engine|tools?|messages?|prompt|response.?format|custom_openai|__proto__|prototype|constructor)$/i;
function options(value,depth=0) {
 if(depth>8)return false;
 if(value===null||typeof value==='boolean'||typeof value==='string')return true;
 if(typeof value==='number')return Number.isFinite(value);
 if(Array.isArray(value))return value.length<=100&&value.every(v=>options(v,depth+1));
 return typeof value==='object'&&Object.entries(value).every(([k,v])=>k.length<=100&&!reserved.test(k)&&options(v,depth+1));
}
export function validModelParameters(value) {
 return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length<=64&&JSON.stringify(value).length<=16000&&options(value);
}
export function validateDeskConfiguration(value) {
 record(value,['engine','provider','model','base_url','credential_env','model_parameters','instructions','skills','rules','tool_approval'],'agent configuration');
 if(value.engine!==undefined&&!['langgraph-node','langgraph-python','crewai-python'].includes(value.engine))throw Error('Invalid engine');
 if(value.provider!==undefined&&(typeof value.provider!=='string'||!/^[a-z][a-z0-9_-]{0,99}$/.test(value.provider)))throw Error('Invalid provider');
 if(value.model!==undefined&&(typeof value.model!=='string'||!value.model.trim()||value.model.length>300))throw Error('Invalid model');
 if(value.base_url!==undefined){const u=new URL(value.base_url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('Invalid model endpoint');}
 if(value.credential_env!==undefined&&(typeof value.credential_env!=='string'||!/^(?:[A-Z][A-Z0-9_]*|)$/.test(value.credential_env)))throw Error('Invalid credential reference');
 if(value.model_parameters!==undefined&&!validModelParameters(value.model_parameters))throw Error('Invalid inference parameters');
 if(value.instructions!==undefined&&(typeof value.instructions!=='string'||bytes(value.instructions)>20000))throw Error('Invalid agent instructions');
 for(const key of ['skills','rules'])if(value[key]!==undefined&&(!Array.isArray(value[key])||value[key].length>100||value[key].some(v=>typeof v!=='string'||bytes(v)>20000)))throw Error('Invalid '+key);
 if(value.tool_approval!==undefined){record(value.tool_approval,['mode','tools'],'approval policy');if(!['none','all','selected'].includes(value.tool_approval.mode)||(value.tool_approval.tools!==undefined&&(!Array.isArray(value.tool_approval.tools)||value.tool_approval.tools.some(v=>typeof v!=='string'))))throw Error('Invalid approval policy');}
 return value;
}
export function validateDeskCredentials(values) {
 if(!values||typeof values!=='object'||Array.isArray(values)||!Object.keys(values).length||Object.keys(values).length>20)throw Error('Invalid credentials');
 for(const [name,value]of Object.entries(values))if(!/^[A-Z][A-Z0-9_]{0,99}_(?:API_KEY|TOKEN|SECRET)$/.test(name)||/^(?:ROSTER|NODE|PYTHON|GIT|NPM)_/.test(name)||typeof value!=='string'||!value.trim()||value.length>4096||/[\r\n\0]/.test(value))throw Error('Invalid credential reference or value');
 return values;
}
