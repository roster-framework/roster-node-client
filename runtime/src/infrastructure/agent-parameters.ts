import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import type { AgentParameterSchema, AgentParameterValues, AgentParameterValidator } from '../domain/agent-parameters.js';
import { snapshotAgentParameters } from '../domain/agent-parameters.js';

export class JsonSchemaAgentParameters implements AgentParameterValidator {
  private readonly validator = new Ajv({strict: true, useDefaults: true,
    coerceTypes: false, removeAdditional: false, allErrors: false, addUsedSchema: false});
  constructor() { addFormats.default(this.validator); }

  declaration(schema: AgentParameterSchema): void {
    const declaration = snapshotAgentParameters(schema);
    if(declaration.type!=='object' || declaration.additionalProperties!==false)
      throw new Error('Agent parameter schema must declare a closed object');
    try { this.validator.compile(declaration); }
    catch { throw new Error('Agent parameter declaration rejected'); }
  }

  resolve(schema: AgentParameterSchema, values: AgentParameterValues): AgentParameterValues {
    const declaration = snapshotAgentParameters(schema);
    if (declaration.type !== 'object' || declaration.additionalProperties !== false)
      throw new Error('Agent parameter schema must declare a closed object');
    const input = structuredClone(snapshotAgentParameters(values));
    try {
      const validate = this.validator.compile(declaration);
      if (!validate(input)) throw new Error('Invalid agent parameters');
    } catch {
      // Do not echo provided values, defaults or validator error payloads.
      throw new Error('Agent parameter declaration or values rejected');
    }
    return snapshotAgentParameters(input);
  }
}
