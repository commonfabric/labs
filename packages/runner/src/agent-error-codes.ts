/**
 * The error codes an agent run ends with, shared with the verb-refusal
 * taxonomy. The `agent` builtin settles a request with one, a runner writes
 * one as an `AgentRun` record's `errorCode`, and a pattern reads it from the
 * builtin's `error`.
 */

/** A request the builtin or a runner cannot act on as submitted. */
export const INVALID_INPUT = "INVALID_INPUT";

/** A run ended by a model-turn, wall-time, or budget limit. */
export const LIMIT_REACHED = "LIMIT_REACHED";

/** A model or tool that failed. */
export const PROVIDER_FAILURE = "PROVIDER_FAILURE";

/** A run whose runner stopped writing and whose one requeue is spent. */
export const RUNNER_LOST = "RUNNER_LOST";

/** A cancel the requester sent. */
export const CANCELLED = "CANCELLED";

/** A result the boundary would not release; the reason is withheld. */
export const REFUSED = "REFUSED";

/** Every code, in the order the record schema enumerates them. */
export const AGENT_RUN_ERROR_CODES = [
  INVALID_INPUT,
  LIMIT_REACHED,
  PROVIDER_FAILURE,
  RUNNER_LOST,
  CANCELLED,
  REFUSED,
] as const;

/** One of {@link AGENT_RUN_ERROR_CODES}. */
export type AgentRunErrorCode = (typeof AGENT_RUN_ERROR_CODES)[number];
