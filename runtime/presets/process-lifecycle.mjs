import { spawn } from 'node:child_process';

// A CLI receipt cannot finish cancellation before process-tree escalation.
// Output parsing and provider-specific results stay in their own adapters.
export function processLifecycle(child, signal, timeoutSeconds) {
  let stopped = false, closed = false, cleanup = Promise.resolve();
  const killGroup = kind => {
    if (!child.pid) return;
    try { process.kill(-child.pid, kind); } catch (error) {
      if (error.code !== 'ESRCH') child.kill(kind);
    }
  };
  const stop = () => {
    if (stopped || closed) return;
    stopped = true;
    if (process.platform === 'win32' && child.pid) {
      cleanup = new Promise(resolve => {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => { child.kill(); resolve(); });
        killer.once('close', code => { if (code !== 0) child.kill(); resolve(); });
      });
    } else {
      killGroup('SIGTERM');
      cleanup = new Promise(resolve => {
        // The root may close its pipes while descendants still run. Keep this
        // timer alive independently of the root's close event.
        setTimeout(() => { killGroup('SIGKILL'); resolve(); }, 2000);
      });
    }
  };
  const timer = setTimeout(stop, timeoutSeconds * 1000);
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  return {
    stop,
    get stopped() { return stopped; },
    close() {
      closed = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      return cleanup;
    },
  };
}
