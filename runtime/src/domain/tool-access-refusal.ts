// Safe decision codes only. Transport bodies, credentials and tool arguments
// never become part of a refusal or its audit record.
export type ToolAccessRefusalReason =
  | "execution_scope_denied"
  | "execution_authority_mismatch"
  | "core_credential_missing"
  | "core_credential_rejected"
  | "core_policy_denied"
  | "core_origin_untrusted"
  | "core_trust_unavailable"
  | "core_authority_unavailable";

export class ToolAccessRefusal extends Error {
  constructor(readonly reason: ToolAccessRefusalReason) {
    super(reason);
    this.name = "ToolAccessRefusal";
  }
}
