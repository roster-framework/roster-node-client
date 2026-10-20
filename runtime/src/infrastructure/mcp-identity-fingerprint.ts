import {createHmac, randomBytes} from 'node:crypto';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {McpConfig,McpConnectionChangeSpec} from '@roster/contracts';
import type {McpIdentityFingerprint} from '../domain/mcp-identity.js';
import {McpIdentityUnavailable} from '../application/mcp-connections.js';

export class FileMcpIdentityFingerprint implements McpIdentityFingerprint {
  private key:Buffer;
  constructor(directory:string,private environment:NodeJS.ProcessEnv=process.env){
    try{
      const path=join(directory,'mcp-identity.key');
      if(!existsSync(path)){
        const registry=JSON.parse(readFileSync(join(directory,'registry.json'),'utf8'));
        if(registry.mcp_identity!==undefined)throw new McpIdentityUnavailable();
        try{writeFileSync(path,randomBytes(32),{flag:'wx',mode:0o600});}
        catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
      }
      this.key=readFileSync(path);if(this.key.length!==32)throw new McpIdentityUnavailable();
    }catch{throw new McpIdentityUnavailable();}
  }
  private hash(value:unknown){return createHmac('sha256',this.key).update(JSON.stringify(value)).digest('hex');}
  client(config:McpConfig){
    const credential=config.token_env?this.environment[config.token_env]:undefined;
    return {credential,fingerprint:this.hash(['configuration',config.id,config.name,config.url,config.token_env??null,credential??null])};
  }
  configuration(config:McpConfig){return this.client(config).fingerprint;}
  command(command:McpConnectionChangeSpec){return this.hash(['command',command.protocol,command.request_id,command.connection_id,command.expected_revision,command.action,
    command.action==='upsert'?[command.configuration.id,command.configuration.name,command.configuration.url,command.configuration.token_env??null]:null]);}
}
