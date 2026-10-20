import {realpath,stat,readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {promptFor} from '../codex/prompt.mjs';
import {coreMcpConfiguration} from '../codex/core-mcp.mjs';
import {runClaude} from './process.mjs';

export const parameterSchema = {type:'object',additionalProperties:false,required:['project'],properties:{
  project:{type:'string',minLength:1,description:'Absolute directory on the Runtime host'},
  model:{type:'string',default:'',description:'Empty uses the Claude Code default model'},
  instructions:{type:'string',default:'',maxLength:20000}, skills:{type:'array',items:{type:'string'},default:[]},
  mode:{type:'string',enum:['read-only','workspace-write'],default:'read-only'},
  timeout_seconds:{type:'integer',minimum:30,maximum:3600,default:600},
  max_turns:{type:'integer',minimum:1,maximum:100,default:20}, require_tool_approval:{type:'boolean',default:false}
}};

export function resultFor(receipt,duration) {
  const report=receipt.result?.structured_output;
  const valid=report&&['success','needs_help'].includes(report.status)&&typeof report.summary==='string'&&report.summary.trim()&&typeof report.minutes==='string';
  const success=valid&&report.status==='success'&&receipt.code===0&&!receipt.stopped&&receipt.result?.is_error===false&&receipt.result?.type==='result';
  const summary=(valid?report.summary:'Claude Code did not complete. Check installation, login, permissions and execution logs.').slice(0,20000);
  return {status:success?'success':'needs_help',summary,
    output:{session_id:receipt.result?.session_id??'',usage:receipt.result?.usage??{},exit_code:receipt.code},
    events:[{type:success?'complete':'fail',data:{summary}}],
    artifacts:success&&report.minutes.trim()?[{name:'minutes.md',mime:'text/markdown',content:report.minutes.slice(0,100000)}]:[],metrics:{duration_ms:duration}};
}

export function createAgentTemplates(options={}) {
  return [{id:'claude-code-cli',version:'1',name:'Claude Code CLI',description:'Local Claude Code using its own login; role and model are instance parameters.',parameter_schema:parameterSchema,credential_parameters:[],
    create({id,name,parameters}) {
      const p={model:'',instructions:'',skills:[],mode:'read-only',timeout_seconds:600,max_turns:20,require_tool_approval:false,...parameters};
      return {parameter_schema:parameterSchema,parameters:p,
        spec:{id,name,description:'Claude Code CLI',statuses:['success','needs_help'],events:['complete','fail'],skills:[],rules:[],capabilities:[]},
        async execute(input,context) {
          if(!isAbsolute(p.project))throw Error('Project must be an absolute Runtime host path');
          const project=await realpath(p.project);if(!(await stat(project)).isDirectory())throw Error('Project must be a directory');
          if(p.require_tool_approval){if(!context.approveTool)throw Error('Tool approval unavailable');await context.approveTool('claude.exec',{project,mode:p.mode});}
          const started=Date.now();
          const capability=coreMcpConfiguration(context.coreMcp); // Shared URL/capability validation only.
          const variable='ROSTER_CLAUDE_EXECUTION_MCP_TOKEN';
          const env=context.coreMcp?{[variable]:Object.values(capability.env)[0]}:{};
          const mcp=context.coreMcp?{mcpServers:{roster:{type:'http',url:context.coreMcp.url,headers:{Authorization:'Bearer ${'+variable+'}'}}}}:{mcpServers:{}};
          const schema=JSON.parse(await readFile(new URL('../codex/result.schema.json',import.meta.url),'utf8'));
          const args=['-p','--output-format','json','--json-schema',JSON.stringify(schema),'--max-turns',String(p.max_turns),
            '--setting-sources','','--strict-mcp-config','--mcp-config',JSON.stringify(mcp),
            '--permission-mode',p.mode==='workspace-write'?'acceptEdits':'default',
            '--tools',p.mode==='workspace-write'?'Read,Grep,Glob,Edit,Write,Bash':'Read,Grep,Glob'];
          if(p.model)args.push('--model',p.model);
          const launch=options.resolveLaunch?await options.resolveLaunch():{command:options.executable||'claude',prefix:[]};
          const result=resultFor(await runClaude(launch,args,promptFor(input,p),project,context,p.timeout_seconds,env),Date.now()-started);
          context.log(result.summary);context.recordSession?.({kind:'note',text:result.summary});return result;
        }
      };
    }
  }];
}
