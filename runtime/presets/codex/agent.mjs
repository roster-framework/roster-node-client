import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promptFor } from './prompt.mjs';
import { runCodex } from './process.mjs';
import { coreMcpConfiguration } from './core-mcp.mjs';
import { discussionResponsePrompt } from './discussion-response.mjs';
import {collaborationPrompt, finishCollaboration} from './collaboration.mjs';

export const parameterSchema = {
  type: 'object', additionalProperties: false,
  required: ['project'],
  properties: {
    project: { type: 'string', minLength: 1, description: 'Absolute project directory on the Runtime host' },
    model: { type: 'string', default: '', description: 'Empty selects the CLI default model' },
    instructions: { type: 'string', default: '', maxLength: 20_000 },
    skills: { type: 'array', items: { type: 'string' }, default: [], description: 'Explicit skill instructions supplied by the preset author/user' },
    mode: { type: 'string', enum: ['read-only', 'workspace-write'], default: 'read-only' },
    effort: { type: 'string', enum: ['low', 'medium', 'high'], default: 'medium' },
    timeout_seconds: { type: 'integer', minimum: 30, maximum: 3600, default: 600 },
    require_tool_approval: { type: 'boolean', default: false }
  }
};

export function resultFor(receipt, duration) {
  let report;
  try { report = JSON.parse(receipt.final); } catch {}
  const valid = report && ['success', 'needs_help'].includes(report.status) && typeof report.summary === 'string' && report.summary.trim() && typeof report.minutes === 'string';
  const success = valid && report.status === 'success' && receipt.code === 0 && !receipt.failed && !receipt.stopped;
  const summary = (valid ? report.summary : 'Codex did not return a valid result. Inspect the execution log and CLI installation/login.').slice(0, 20_000);
  const artifacts = success && report.minutes.trim() ? [{ name: 'minutes.md', mime: 'text/markdown', content: report.minutes.slice(0, 100_000) }] : [];
  return { status: success ? 'success' : 'needs_help', summary,
    output: { thread_id: receipt.thread ?? '', usage: receipt.usage ?? {}, exit_code: receipt.code },
    events: [{ type: success ? 'complete' : 'fail', data: { summary } }], artifacts, metrics: { duration_ms: duration } };
}

export function createAgents() { return []; }
export function createAgentTemplates(options = {}) {
  return [{ id: 'codex-cli', version: '2', name: 'Codex CLI',
    description: 'Runtime-owned Codex CLI instance; role and model are instance parameters.',
    parameter_schema: parameterSchema, credential_parameters: [],
    create({ id, name, parameters }) {
      const p = { model: '', instructions: '', skills: [], mode: 'read-only', effort: 'medium', timeout_seconds: 600, require_tool_approval: false, ...parameters };
      return { parameter_schema: parameterSchema, parameters: p,
        spec: { id, name, description: 'Codex CLI', statuses: ['success', 'needs_help'], events: ['complete', 'fail'], skills: [], rules: [], capabilities: [] },
        async execute(input, context) {
          if (context.continuation && options.continuations !== true) throw Error('This Codex preset does not support checkpoint resumption');
          const continuationPrompt = options.continuations === true ? collaborationPrompt(context, input) : '';
          if (!isAbsolute(p.project)) throw Error('Project must be an absolute path on the Runtime host');
          const started = Date.now(), project = await realpath(p.project);
          if (!(await stat(project)).isDirectory()) throw Error('Project must be a directory on the Runtime host');
          if (p.require_tool_approval) {
            if (!context.approveTool) throw Error('Tool approval is unavailable');
            await context.approveTool('codex.exec', { project, mode: p.mode });
          }
          const args = ['exec', '--ignore-user-config', '--json', '--color', 'never', '--skip-git-repo-check', '--sandbox', p.mode,
            '-c', 'approval_policy="never"', '-c', 'skills.max_context_tokens=1000', '-c', 'tool_output_token_limit=3000',
            '-c', `model_reasoning_effort="${p.effort}"`, '--output-schema', fileURLToPath(new URL(options.continuations === true ? './collaboration.schema.json' : './result.schema.json', import.meta.url)), '-C', project];
          if (process.platform === 'win32') args.push('-c', 'windows.sandbox="unelevated"');
          if (p.model) args.push('--model', p.model);
          const coreMcp = coreMcpConfiguration(context.coreMcp, {agentCalls: options.agentCalls === true});
          args.push(...coreMcp.args);
          args.push('-');
          const prompt = promptFor(input, p, {allowWaiting:options.continuations === true}) + (options.agentCalls === true ? '\n\nYou may use roster_call_agent for authorized task or conversation delegation. Use a stable request_id for retries of the same request. A creation receipt confirms acceptance, not completion or an answer. Do not claim a delegated result or parent completion from acceptance alone. Core enforces recipient permissions and current execution lineage; do not retry a denial using another identity. Use roster_create_discussion, roster_read_discussion and roster_append_discussion for authorized shared questions and replies. Choose participants explicitly and use stable thread/message IDs. Core supplies the authenticated author; never supply an actor, author, proof or permission scope. Attach resource references, not secret credentials or resource bodies. Read resources through their separately authorized tools. A saved message is not proof of delivery or an answer. Reply using reply_to_id; one participant reply does not mean all participants agree. Do not poll repeatedly.' + (options.continuations === true ? ' Use the explicit Runtime wait report described below for durable waiting.' : ' Do not claim durable waiting/resumption from these tools.') : '');
          const responsePrompt = discussionResponsePrompt(input, {agentCalls:options.agentCalls === true, coreMcp:context.coreMcp}) + continuationPrompt;
          if (Buffer.byteLength(prompt + responsePrompt) > 64_000) throw Error('Prompt exceeds 64 KB');
          const receipt = await runCodex(options.resolveLaunch ? await options.resolveLaunch() : options.executable || 'codex', args, prompt + responsePrompt, context, p.timeout_seconds, coreMcp.env, {model: p.model});
          if (options.continuations === true) await finishCollaboration(receipt,input,context);
          const result = resultFor(receipt, Date.now() - started);
          context.recordSession?.({ kind: 'note', text: result.summary });
          return result;
        }
      };
    }
  }];
}
