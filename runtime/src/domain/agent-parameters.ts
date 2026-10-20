export type AgentParameterSchema = Readonly<Record<string, unknown>>;
export type AgentParameterValues = Readonly<Record<string, unknown>>;

// The author supplies the schema; the adapter only validates and applies its defaults.
export interface AgentParameterValidator {
  declaration?(schema: AgentParameterSchema): void;
  resolve(schema: AgentParameterSchema, values: AgentParameterValues): AgentParameterValues;
}

export function snapshotAgentParameters(values: AgentParameterValues): AgentParameterValues {
  function check(value: unknown, depth: number): void {
    if (depth > 32) throw new Error('Agent parameters exceed nesting limit');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (value && typeof value === 'object' &&
        (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
      for (const child of Object.values(value)) check(child, depth + 1);
      return;
    }
    throw new Error('Agent parameters must contain JSON values only');
  }
  check(values, 0);
  const encoded = JSON.stringify(values);
  if (!encoded || encoded.length > 100_000)
    throw new Error('Agent parameters must be a bounded JSON object');
  const copy: unknown = JSON.parse(encoded);
  if (!copy || typeof copy !== 'object' || Array.isArray(copy))
    throw new Error('Agent parameters must be a JSON object');
  function freeze(value: unknown, depth: number): void {
    if (depth > 32) throw new Error('Agent parameters exceed nesting limit');
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child, depth + 1);
      Object.freeze(value);
    }
  }
  freeze(copy, 0);
  return copy as AgentParameterValues;
}
