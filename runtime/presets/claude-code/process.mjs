import { spawn } from 'node:child_process';
import { processLifecycle } from '../process-lifecycle.mjs';
import { childEnvironment } from '../codex/prompt.mjs';

export function runClaude(launch, args, prompt, cwd, context, timeoutSeconds, capabilityEnvironment = {}) {
  return new Promise((resolve, reject) => {
    if (context.signal.aborted) return reject(Error('Execution cancelled'));
    const child = spawn(launch.command, [...launch.prefix, ...args], {cwd, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', env: {...childEnvironment(), ...capabilityEnvironment}, stdio: ['pipe','pipe','pipe']});
    let output = '', settled = false;
    const lifecycle = processLifecycle(child, context.signal, timeoutSeconds);
    const stop = lifecycle.stop;
    const finish = async (error, code) => {
      if(settled)return; settled=true;
      await lifecycle.close();
      if(error)reject(Error('Claude Code could not start; check Runtime installation'));
      else {
        for(const secret of Object.values(capabilityEnvironment)) if(secret)output=output.split(secret).join('[REDACTED]');
        let result; try{result=JSON.parse(output);}catch{}
        resolve({code,stopped:lifecycle.stopped,result});
      }
    };
    child.on('error',error=>finish(error)); child.on('close',code=>finish(undefined,code));
    child.stdout.on('data',chunk=>{output+=chunk.toString();if(Buffer.byteLength(output)>1_000_000){output='';stop();}});
    child.stderr.on('data',()=>{});
    child.stdin.on('error',()=>{}); child.stdin.end(prompt);
  });
}
