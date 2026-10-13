import type {IncomingMessage} from 'node:http';
import {parseStrictJSON} from '../infrastructure/strict-json.js';
export {parseStrictJSON} from '../infrastructure/strict-json.js';

export async function strictRequestJSON(request:IncomingMessage):Promise<unknown> {
 if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type']??''))throw Error('JSON content type required');
 const parts:Buffer[]=[];let size=0;
 for await(const part of request){size+=part.length;if(size>150_000)throw Error('JSON request exceeds limit');parts.push(Buffer.from(part));}
 return parseStrictJSON(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));
}
