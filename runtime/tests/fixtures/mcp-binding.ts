import {McpConnections} from '../../src/application/mcp-connections.js';
import {FileMcpIdentityFingerprint} from '../../src/infrastructure/mcp-identity-fingerprint.js';
import type {FileRuntimeStorage} from '../../src/infrastructure/filesystem.js';

export async function fixtureMcpBinding(directory:string,storage:FileRuntimeStorage,id='files',tools=['read']){
  const service=new McpConnections('runtime',storage,{inspect:async()=>tools},new FileMcpIdentityFingerprint(directory));
  const receipt=await service.change({protocol:'roster-mcp-change/1',request_id:'fixture-'+id,connection_id:id,expected_revision:null,action:'upsert',configuration:{id,name:id,url:'https://fixture.example/mcp'}});
  return {service,revision:receipt.revision};
}
