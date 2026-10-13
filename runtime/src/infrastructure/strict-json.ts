// Validate decoded property names before JSON.parse can silently replace intent.
export function parseStrictJSON(source:string,maxBytes=150_000):unknown {
 if(Buffer.byteLength(source,'utf8')>maxBytes)throw Error('JSON request exceeds limit');
 let at=0;const space=()=>{while(/[\t\n\r ]/.test(source[at]??'x'))at++;};
 function string():string {const start=at;if(source[at++]!=='"')throw Error('Invalid JSON');while(at<source.length){const c=source[at++];if(c==='"')return JSON.parse(source.slice(start,at));if(c==='\\')at++;}throw Error('Invalid JSON');}
 function value(depth:number):void {
  if(depth>32)throw Error('JSON request exceeds nesting limit');space();const c=source[at];
  if(c==='{'){at++;space();const keys=new Set<string>();if(source[at]==='}'){at++;return;}for(;;){space();const key=string();if(keys.has(key)||['__proto__','constructor','prototype'].includes(key))throw Error('Duplicate or unsafe JSON property');keys.add(key);space();if(source[at++]!==':')throw Error('Invalid JSON');value(depth+1);space();const token=source[at++];if(token==='}')return;if(token!==',')throw Error('Invalid JSON');}}
  if(c==='['){at++;space();if(source[at]===']'){at++;return;}for(;;){value(depth+1);space();const token=source[at++];if(token===']')return;if(token!==',')throw Error('Invalid JSON');}}
  if(c==='"'){string();return;}const match=source.slice(at).match(/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/);if(!match)throw Error('Invalid JSON');at+=match[0].length;
 }
 value(0);space();if(at!==source.length)throw Error('Invalid JSON');return JSON.parse(source);
}
