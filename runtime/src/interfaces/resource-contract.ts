import { Invocation, Id } from "@roster/contracts";
import { z } from "zod";

// Additive v1 resource descriptor. Provider credentials and upstream endpoints are absent.
export const ResourceAccess = z.object({
  id: Id, name: z.string().max(200), server_id: Id, resource_id: Id,
  component: Id, route: z.literal("proxy"),
  version: z.number().int().positive(),
  operations: z.array(Id).max(100),
}).strict();
export const ResourceInvocation = Invocation.extend({ context: Invocation.shape.context.extend({
  resources: z.array(ResourceAccess).max(100).optional(),
}) });
