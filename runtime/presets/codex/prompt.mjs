export function childEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !(key.startsWith('ROSTER_') || key.startsWith('CODEX_') && key !== 'CODEX_HOME' || key === 'OPENAI_API_KEY')));
}

export function promptFor(input, parameters, options = {}) {
  const history = JSON.stringify(input.context?.history ?? []);
  if (Buffer.byteLength(history) > 24_000) throw Error('History exceeds 24 KB; reduce the supplied history');
  // Resource bodies and knowledge are queried on demand, never automatically injected.
  const prompt = [parameters.instructions, ...(parameters.skills ?? []),
    input.context?.core_instructions?.text,
    input.context?.subscription_delivery?.instruction,
    'Return status success only after completing the requested work. '+(options.allowWaiting === true ? 'Use waiting only for an explicit shared question requiring a reply; otherwise return needs_help with the blocker and next action. ' : 'Otherwise return needs_help with the blocker and next action. ')+'Do not claim tests or file changes that did not happen.',
    'If meeting minutes are requested, return Markdown in the minutes field. Do not write minutes.md to disk; Runtime publishes that artifact. Read-only meetings may read project files.',
    'When Roster MCP tools are available, discover authorized resource connections and query needed materials or past sessions on demand. Do not invent resource contents or bypass a denied operation.',
    'Request: ' + (input.context?.request ?? input.prompt ?? ''),
    'Input: ' + JSON.stringify(input.input ?? {}),
    'History: ' + history].filter(Boolean).join('\n\n');
  if (Buffer.byteLength(prompt) > 64_000) throw Error('Prompt exceeds 64 KB');
  return prompt;
}
