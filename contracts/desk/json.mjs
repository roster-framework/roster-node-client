// Validate structure before native parsing; never silently accept duplicate metadata keys.
export function parseDeskJSON(source,maxBytes=2*1024*1024) {
  if(typeof source!=='string'||new TextEncoder().encode(source).length>maxBytes)throw Error('Desk JSON exceeds limit');
  let at=0;const space=()=>{while(/[\t\n\r ]/.test(source[at]||'x'))at++;};
  function string(){const start=at;if(source[at++]!=='"')throw Error('Invalid Desk JSON');while(at<source.length){const c=source[at++];if(c==='"')return JSON.parse(source.slice(start,at));if(c==='\\')at++;}throw Error('Invalid Desk JSON');}
  function value(depth){if(depth>64)throw Error('Desk JSON exceeds depth limit');space();const c=source[at];
    if(c==='{'){at++;space();const keys=new Set();if(source[at]==='}'){at++;return;}for(;;){space();const key=string();if(keys.has(key))throw Error('Duplicate Desk JSON key');keys.add(key);space();if(source[at++]!==':')throw Error('Invalid Desk JSON');value(depth+1);space();const token=source[at++];if(token==='}')return;if(token!==',')throw Error('Invalid Desk JSON');}}
    if(c==='['){at++;space();if(source[at]===']'){at++;return;}for(;;){value(depth+1);space();const token=source[at++];if(token===']')return;if(token!==',')throw Error('Invalid Desk JSON');}}
    if(c==='"'){string();return;}const match=source.slice(at).match(/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/);if(!match)throw Error('Invalid Desk JSON');at+=match[0].length;
  }
  value(0);space();if(at!==source.length)throw Error('Invalid Desk JSON');return JSON.parse(source);
}
