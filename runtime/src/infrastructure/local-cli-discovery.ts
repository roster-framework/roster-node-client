import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import type { CliLaunch, LocalCliDiscovery, LocalCliID, LocalCliStatus } from '../domain/local-cli.js';

// Status probes only: no model requests or credential file reads.
export async function probeCli(launch: CliLaunch, args: string[], timeout = 5000): Promise<number | null> {
  return new Promise(resolve => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ROSTER_')));
    const child = spawn(launch.command, [...launch.prefix, ...args], { env, shell: false, windowsHide: true, stdio: 'ignore' });
    let done = false;
    const finish = (code: number | null) => { if (!done) { done = true; clearTimeout(timer); resolve(code); } };
    const timer = setTimeout(() => { child.kill(); finish(null); }, timeout);
    child.once('error', () => finish(null));
    child.once('close', code => finish(code));
  });
}
export async function cliCandidates(id: LocalCliID, env = process.env, platform = process.platform, home = homedir()): Promise<CliLaunch[]> {
  const candidates: CliLaunch[] = [];
  const explicit = env[id === 'codex' ? 'ROSTER_CODEX_EXECUTABLE' : 'ROSTER_CLAUDE_EXECUTABLE'];
  if (explicit) return [{ command: explicit, prefix: [] }];
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(dir => isAbsolute(dir));
  dirs.push(join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'));
  if (platform === 'win32' && env.APPDATA) dirs.push(join(env.APPDATA, 'npm'));
  for (const dir of [...new Set(dirs)]) {
    candidates.push({ command: join(dir, id + (platform === 'win32' ? '.exe' : '')), prefix: [] });
    const pkg = id === 'codex' ? ['@openai', 'codex', 'bin', 'codex.js'] : ['@anthropic-ai', 'claude-code', 'cli.js'];
    for (const root of [join(dir, 'node_modules'), join(dir, '..', 'lib', 'node_modules')]) {
      if (id === 'claude') candidates.push({command:join(root,'@anthropic-ai','claude-code','bin',platform === 'win32' ? 'claude.exe' : 'claude'),prefix:[]});
      candidates.push({ command: process.execPath, prefix: [join(root, ...pkg)] });
    }
  }
  if (platform === 'win32' && id === 'codex' && env.LOCALAPPDATA) {
    const root = join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      for (const entry of (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).slice(0, 32))
        candidates.push({ command: join(root, entry.name, 'codex.exe'), prefix: [] });
    } catch {}
  }
  return candidates;
}
export class HostLocalCliDiscovery implements LocalCliDiscovery {
  private launches = new Map<LocalCliID, CliLaunch>();
  private statuses: readonly LocalCliStatus[] = [];
  private expires = 0;
  private pending?: Promise<readonly LocalCliStatus[]>;
  constructor(private env = process.env, private probe = probeCli) {}
  launch(id: LocalCliID): CliLaunch {
    const value = this.launches.get(id);
    if (!value) throw new Error('Local CLI unavailable; check Runtime host installation and login');
    return { command: value.command, prefix: [...value.prefix] };
  }
  async inspect(): Promise<readonly LocalCliStatus[]> {
    if (Date.now() < this.expires) return structuredClone(this.statuses);
    if (!this.pending) this.pending = this.refresh().finally(() => { this.pending = undefined; });
    return structuredClone(await this.pending);
  }
  private async refresh(): Promise<readonly LocalCliStatus[]> {
    const next = new Map<LocalCliID, CliLaunch>();
    const results = await Promise.all((['codex', 'claude'] as const).map(async id => {
      let found: CliLaunch | undefined;
      let present = false, attempts = 0;
      for (const candidate of await cliCandidates(id, this.env)) {
        try { await access(candidate.prefix[0] ?? candidate.command, constants.F_OK); present = true; }
        catch { if (!this.env[id === 'codex' ? 'ROSTER_CODEX_EXECUTABLE' : 'ROSTER_CLAUDE_EXECUTABLE']) continue; }
        if (++attempts > 8) break;
        if (await this.probe(candidate, ['--version']) === 0) { found = candidate; break; }
      }
      const auth = found ? await this.probe(found, id === 'codex' ? ['login', 'status'] : ['auth', 'status']) : null;
      if (found) next.set(id, found);
      const state = !found ? present ? 'unavailable' : 'not_found' : auth === 0 ? 'ready' : auth === 1 ? 'login_required' : 'unavailable';
      return { id, template_id: id === 'codex' ? 'codex-cli' : 'claude-code-cli', state,
        installed: !!found || present, authenticated: auth === 0 ? true : auth === 1 ? false : null,
        checked_at: new Date().toISOString(), next_action: state === 'ready' ? 'select_template' : state === 'login_required' ? 'login_on_runtime_host' : state === 'not_found' ? 'install_on_runtime_host' : 'check_runtime_host' } satisfies LocalCliStatus;
    }));
    this.launches = next; this.statuses = results; this.expires = Date.now() + 30_000;
    return results;
  }
}
