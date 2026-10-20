// `codex exec --json` reports one terminal turn aggregate, not provider calls.
// Never infer the effective default model, HTTP attempts or billing from it.
export function codexUsageObserver(context, model = '') {
  let terminal;
  const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const publish = (state, usage) => {
    const input = count(usage?.input_tokens);
    let cached = count(usage?.cached_input_tokens);
    if (input !== null && cached !== null && cached > input) cached = null;
    const report = {version: 1, invocation_id: 'codex-cli-turn', provider: 'codex-cli',
      model: model || 'cli-default', phase: 'unknown', state,
      input_tokens: input, output_tokens: count(usage?.output_tokens), cached_input_tokens: cached};
    const fingerprint = JSON.stringify(report);
    if (terminal !== undefined) {
      if (terminal !== fingerprint) throw Error('Conflicting Codex terminal usage');
      return;
    }
    terminal = fingerprint;
    context.recordModelUsage?.(report);
  };
  return {
    observe(event) {
      if (event.type === 'turn.completed') publish('completed', event.usage);
      if (event.type === 'turn.failed') publish('failed');
    },
    finish() {
      // Interrupted or malformed streams must not turn missing usage into zero.
      if (terminal === undefined) publish('failed');
    }
  };
}
