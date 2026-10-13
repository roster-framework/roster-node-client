import type {McpConfig, McpConnectionChangeSpec} from '@roster/contracts';

/** Host-private fingerprints; never a public connection identifier. */
export interface McpIdentityFingerprint {
  configuration(config: McpConfig): string;
  client(config: McpConfig): {fingerprint:string; credential?:string};
  command(command: McpConnectionChangeSpec): string;
}

/** Host-private resolved credential, never placed in prompts or journal records. */
export type McpClientBinding = {configuration:McpConfig; revision:string; credential?:string};
