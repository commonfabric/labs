/** Stable failure codes exposed at cf-harness control boundaries. */
export type HarnessControlErrorCode =
  | "invalid-request"
  | "provider-configuration-required"
  | "provider-auth-required"
  | "provider-mismatch"
  | "provider-unavailable"
  | "internal-error"
  | "operation-canceled";

/** A machine-classifiable, bounded failure safe to return at host boundaries. */
export class HarnessControlError extends Error {
  constructor(
    readonly code: HarnessControlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HarnessControlError";
  }
}

/**
 * Refuses a resume that cannot be reconciled with the run it names: a
 * requested setting contradicts the recorded one, or the record lacks
 * something a resume needs. Both tiers of resume checking raise this — the
 * CLI's, and the engine constructor's — so that a host reading a structured
 * failure is told which setting was refused wherever the check that refused
 * it lives, and tells a refusal apart from a host that broke.
 */
export const harnessResumeRefusal = (message: string): HarnessControlError =>
  new HarnessControlError("provider-mismatch", message);

/** Names the requested operation when a recorded run cannot be used. */
export const harnessRecordedRunRefusal = (
  mode: "resume" | "continue",
  detail: string,
): HarnessControlError => harnessResumeRefusal(`${mode} ${detail}`);
