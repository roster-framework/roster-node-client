import { spawn } from 'node:child_process';
import { processLifecycle } from '../process-lifecycle.mjs';
import { childEnvironment } from './prompt.mjs';
import { coreToolObservation } from './mcp-observation.mjs';
import { codexUsageObserver } from './usage.mjs';

export function runCodex(executable, args, prompt, context, timeoutSeconds, capabilityEnvironment = {}, telemetry = {}) {
  return new Promise((resolve, reject) => {
    if (context.signal.aborted) return reject(Error('Execution cancelled'));
    // POSIX process groups keep CLI-launched tools in the same cancellation boundary.
    const launch = typeof executable === 'string' ? {command: executable, prefix: []} : executable;
    const child = spawn(launch.command, [...launch.prefix, ...args], { shell: false, windowsHide: true, detached: process.platform !== 'win32', env: {...childEnvironment(), ...capabilityEnvironment}, stdio: ['pipe', 'pipe', 'pipe'] });
    const redact = text => Object.values(capabilityEnvironment).reduce((value, secret) => secret ? value.split(secret).join('[REDACTED]') : value, text);
    let buffer = '', final = '', failed = false, thread, usage, settled = false;
    const observedTools = new Set();
    const usageObserver = codexUsageObserver(context, telemetry.model);
    let observationError;
    const lifecycle = processLifecycle(child, context.signal, timeoutSeconds);
    const stop = lifecycle.stop;
    const finish = async (error, code) => {
      if (settled) return;
      settled = true;
      await lifecycle.close();
      try { usageObserver.finish(); } catch (failure) { observationError ??= failure; }
      if (error || observationError) reject(error || observationError);
      else resolve({ code, final, failed, thread, usage, stopped: lifecycle.stopped });
    };
    child.on('error', error => finish(error));
    child.stdin.on('error', () => {});
    child.stderr.on('data', () => {}); // Do not expose commands, secrets or hidden reasoning.
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 1_000_000) { failed = true; buffer = ''; stop(); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        try { usageObserver.observe(event); } catch (error) { observationError = error; stop(); return; }
        const observation = coreToolObservation(event, observedTools);
        if (observation) context.recordSession?.({kind: 'log', text: observation});
        if (event.type === 'thread.started') thread = event.thread_id;
        if (event.type === 'turn.completed') usage = event.usage;
        if (event.type === 'turn.failed' || event.type === 'error') failed = true;
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          final = redact(event.item.text);
          context.log(final.slice(0, 20_000));
        }
      }
    });
    child.on('close', code => finish(undefined, code));
    child.stdin.end(prompt);
  });
}
