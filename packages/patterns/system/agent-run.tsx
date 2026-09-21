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
 * client writes, through this pattern's `cancel` stream.
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

/** A record as a pattern holds it: the requester's own instance. */
export type AgentRunRecord = PerUser<AgentRun>;

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
  run: Writable<AgentRunRecord>;
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
  { run: Writable<AgentRunRecord> }
>((_event, { run }) => {
  const current = run.get();
  if (current === undefined) return;
  if (isTerminalAgentRunState(current.state)) return;
  if (current.cancelRequestedAt !== undefined) return;
  run.key("cancelRequestedAt").set(new Date().toISOString());
});

export default pattern<AgentRunViewInput, AgentRunViewOutput>(({ run }) => {
  const terminal = computed(() => isTerminalAgentRunState(run.get()?.state));
  const cancel = requestCancel({ run });
  return {
    [NAME]: computed(() => `Agent run: ${run.get()?.state ?? "unknown"}`),
    [UI]: (
      <cf-vstack gap="1">
        <cf-hstack gap="2" align="center">
          <strong>{computed(() => run.get()?.state ?? "unknown")}</strong>
          <span>{computed(() => run.get()?.task ?? "")}</span>
        </cf-hstack>
        <span style={{ fontSize: "12px", color: "#666" }}>
          {computed(() => {
            const value = run.get();
            if (value === undefined) return "";
            const usage = value.usage?.totalTokens;
            return [
              `submitted ${value.submittedAt}`,
              value.errorCode ? `error ${value.errorCode}` : "",
              usage !== undefined ? `${usage} tokens` : "",
            ].filter((part) => part !== "").join(" · ");
          })}
        </span>
        {terminal
          ? null
          : <cf-button size="sm" onClick={cancel}>Cancel</cf-button>}
      </cf-vstack>
    ),
    run,
    terminal,
    cancel,
  };
});
