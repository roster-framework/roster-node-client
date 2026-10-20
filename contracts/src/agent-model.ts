import { z } from "zod";
import {validModelParameters} from '../desk/configuration.mjs';

export const AgentEngine = z.enum([
  "langgraph-node",
  "langgraph-python",
  "crewai-python",
]);
export const ModelProvider = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9_-]*$/);
export const ModelParameters = z
  .record(z.string(), z.json())
  .refine(
    (v) =>
      validModelParameters(v),
    "Invalid inference parameters; credentials, transport and agent controls belong to runtime configuration",
  );
export type ModelParameterValues = z.infer<typeof ModelParameters>;
