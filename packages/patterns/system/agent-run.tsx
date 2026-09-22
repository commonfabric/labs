/**
 * One agent run: the pattern-facing type of the `AgentRun` record the
 * `agent` builtin creates, and a view over a record with a `cancel` stream.
 *
 * The canonical schema is `AgentRunRecordSchema` in
 * `packages/runner/src/builtins/agent-schemas.ts`, because the runner sits
 * below this package and cannot import from it;
 * `packages/runner/test/agent-schemas-parity.test.ts` holds the two shapes
 * together.
 */
import {
  computed,
  handler,
  NAME,
  pattern,
  type PerUser,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

/** The states a record passes through; the last four are terminal. */
export type AgentRunState =
  | "queued"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "refused"
  | "cancelled";

/** How a finished run ended. */
export type AgentRunOutcome = "completed" | "failed" | "refused" | "cancelled";

/** The error taxonomy a run ends with, shared with verb refusals. */
export type AgentRunErrorCode =
  | "INVALID_INPUT"
  | "LIMIT_REACHED"
  | "PROVIDER_FAILURE"
  | "RUNNER_LOST"
  | "CANCELLED"
  | "REFUSED";

/**
 * Model usage as the harness reports it. An absent counter stays absent, and
 * reported and estimated cost are separate fields.
 */
export type AgentRunUsage = {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  estimatedCostUsd?: number;
  estimateWithheldReason?: string;
};

/**
 * The record of one agent request, held per user in the requesting space.
 *
 * Three writers share it and never overlap. The `agent` builtin's post-commit
 * effect writes the request fields once, at creation: `requestHash` through
 * `stateSince` below. The user's runner writes everything from `claim` on —
 * `claim`, `attempts`, the terminal fields — and moves `state` and
 * `stateSince` as it goes. `cancelRequestedAt` is the one field any other
 * client writes, through this pattern's `cancel` stream or `cf agent cancel`.
 */
export type AgentRun = {
  // Written by the builtin's effect when the request commits.
  requestHash: string;
  request: unknown;
  piece: unknown;
  space: unknown;
  task: string;
  inputs: Record<string, unknown>;
  resultSchema: unknown;
  maxConfidentiality?: unknown[];
  tools?: string[];
  submittedAt: string;
  state: AgentRunState;
  stateSince: string;

  // Written by the runner, from the claim on.
  claim?: { runner: string; leaseUntil: string };
  attempts?: number;
  result?: unknown;
  outcome?: AgentRunOutcome;
  errorCode?: AgentRunErrorCode;
  startedAt?: string;
  finishedAt?: string;
  modelTurns?: number;
  toolCalls?: number;
  usage?: AgentRunUsage;
  usageCoverage?: "direct" | "including-descendants";
  runRef?: string;

  // Written by a client asking for the run to stop.
  cancelRequestedAt?: string;
};

/**
 * A record as a pattern holds it: a handle to the requester's own instance.
 * The record is a user-scoped document, and the scope sits on the handle,
 * where it caps which link the handle may follow; a scope on the value would
 * instead address the user instance of the slot that holds the handle.
 */
export type AgentRunRecord = PerUser<Writable<AgentRun>>;

const TERMINAL_STATES: readonly AgentRunState[] = [
  "completed",
  "failed",
  "refused",
  "cancelled",
];

/** Whether `state` is one no later write moves a record out of. */
export const isTerminalAgentRunState = (
  state: AgentRunState | undefined,
): boolean => state !== undefined && TERMINAL_STATES.includes(state);

type AgentRunViewInput = {
  run: AgentRunRecord;

  /** The shared observation time for relative age, in epoch milliseconds. */
  nowMs?: number;
};

export type AgentRunViewOutput = {
  [NAME]: string;
  [UI]: VNode;
  run: AgentRunRecord;
  terminal: boolean;
  cancel: Stream<void>;
};

/**
 * Asks the runner to stop the run. The request is a durable field rather
 * than the event itself, because the runner is another process and an event
 * reaches only the runtime that runs this handler. A finished run, or one
 * already asked to stop, is left as it is.
 */
export const requestCancel = handler<
  void,
  { run: AgentRunRecord }
>((_event, { run }) => {
  const current = run.get();
  if (current === undefined) return;
  if (isTerminalAgentRunState(current.state)) return;
  if (current.cancelRequestedAt !== undefined) return;
  run.key("cancelRequestedAt").set(new Date().toISOString());
});

/** Formats elapsed time without consulting an ambient clock. */
export function formatAgentRunAge(submittedAt: string, nowMs?: number): string {
  const submittedMs = Date.parse(submittedAt);
  if (
    !Number.isFinite(submittedMs) || nowMs === undefined ||
    !Number.isFinite(nowMs)
  ) {
    return "unknown";
  }
  const minutes = Math.floor(Math.max(0, nowMs - submittedMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default pattern<AgentRunViewInput, AgentRunViewOutput>(
  ({ run, nowMs }) => {
    const terminal = computed(() => isTerminalAgentRunState(run.get()?.state));
    const cancellationRequested = computed(() =>
      run.get()?.cancelRequestedAt !== undefined
    );
    const canCancel = computed(() => !terminal && !cancellationRequested);
    const cancelling = computed(() => !terminal && cancellationRequested);
    const cancel = requestCancel({ run });
    const usageText = computed(() => {
      const usage = run.get()?.usage;
      if (usage === undefined) return "Usage unavailable";
      return [
        usage.totalTokens !== undefined ? `${usage.totalTokens} tokens` : "",
        usage.costUsd !== undefined
          ? `Reported cost: $${usage.costUsd.toFixed(6)}`
          : "",
        usage.estimatedCostUsd !== undefined
          ? `Estimated cost: $${usage.estimatedCostUsd.toFixed(6)}`
          : "",
        usage.estimateWithheldReason !== undefined
          ? `Estimate withheld: ${usage.estimateWithheldReason}`
          : "",
      ].filter((part) => part !== "").join(" · ") || "Usage unavailable";
    });
    return {
      [NAME]: computed(() => `Agent run: ${run.get()?.state ?? "unknown"}`),
      [UI]: (
        <cf-vstack gap="2">
          <cf-hstack gap="2" align="center">
            <cf-badge>{computed(() => run.get()?.state ?? "unknown")}</cf-badge>
            <strong>
              {computed(() => run.get()?.task ?? "")}
            </strong>
          </cf-hstack>
          <small>
            {computed(() => {
              const value = run.get();
              if (value === undefined) return "";
              return `Age: ${
                formatAgentRunAge(value.submittedAt, nowMs)
              } · submitted ${value.submittedAt}`;
            })}
          </small>
          <span>{usageText}</span>
          <span>
            {computed(() => {
              const errorCode = run.get()?.errorCode;
              return errorCode === undefined ? "" : `error ${errorCode}`;
            })}
          </span>
          {cancelling ? <span>Cancellation requested</span> : null}
          {canCancel
            ? <cf-button size="sm" onClick={cancel}>Cancel</cf-button>
            : null}
        </cf-vstack>
      ),
      run,
      terminal,
      cancel,
    };
  },
);
