/**
 * The one coordinator for actions a session asks the person's client to
 * perform mid-turn: which requests are pending, how each is settled, what a
 * cancel, an idle timeout, a failed delivery or a restart settles it as, and
 * the order the request and resolved events reach the session's log.
 *
 * Both kinds of action ride it. A final-action kind (`open_loom`,
 * `open_url`) is settled by an outcome word; a typed kind (`invoke_command`,
 * `list_commands`) by a settlement from `client-command.ts`. The HTTP route
 * and the stdio request read a host's answer with the one reader here,
 * {@link readHarnessClientActionAnswer}, and hand it to the coordinator of
 * the session it names.
 *
 * The coordinator owns no transport and no store. The session that holds it
 * supplies the event writer, and the run that asks supplies the holder a
 * command's result body is kept by.
 */

import { type FabricValue, hashStringOf } from "@commonfabric/data-model";
import { isObjectNotArray } from "@commonfabric/utils/types";
import {
  HARNESS_CLIENT_ACTION_RESULT_MAX_LENGTH,
  type HarnessClientAction,
  type HarnessClientActionOutcome,
  type HarnessClientActionOutcomeKind,
  isHarnessClientActionOutcomeKind,
  readHarnessClientAction,
} from "../contracts/client-action.ts";
import {
  type HarnessCommandHostSettlement,
  type HarnessCommandResolveBody,
  type HarnessCommandSettlement,
  type HarnessCommandSettlementRecord,
  type HarnessTypedClientAction,
  readHarnessCommandResolveBody,
  readHarnessTypedClientAction,
} from "../contracts/client-command.ts";
import type {
  HarnessChatResolveClientActionParams,
  HarnessChatStructuredEvent,
} from "../contracts/interactive-chat.ts";
import {
  admitHarnessCommandCatalogEntries,
  type HarnessCommandCatalogDrop,
  type HarnessCommandModelSettlement,
  type HarnessCommandResultHolder,
  harnessCommandResultProvenance,
  projectHarnessCommandSettlement,
} from "./command-result.ts";

/**
 * An action `weaver_action` asks the person's client for mid-turn: a
 * final-action kind other than `command`, or a typed command or catalog
 * request. A slash-command line is a final action only; mid-turn, a command
 * is invoked by id with typed arguments.
 */
export type HarnessMidTurnClientAction =
  | Exclude<HarnessClientAction, { kind: "command" }>
  | HarnessTypedClientAction;

/** What became of one typed action, as the model reads it. */
export interface HarnessTypedClientActionOutcome {
  action: HarnessTypedClientAction;
  settlement: HarnessCommandModelSettlement;
}

/** What became of one mid-turn action, as the model reads it. */
export type HarnessMidTurnClientActionOutcome =
  | HarnessClientActionOutcome
  | HarnessTypedClientActionOutcome;

/**
 * The run's door for asking the person's client to act mid-turn. It emits
 * one request per action in order, resolves when every one is settled, and
 * settles any still open as canceled when `signal` aborts. Outcomes come
 * back in input order. `holdCommandResult` keeps an executed command's body
 * in the run's handle table; without it the model gets the outcome and no
 * handle. Only a host that opted in supplies the door.
 */
export type HarnessClientActionRequester = (
  actions: readonly HarnessMidTurnClientAction[],
  signal?: AbortSignal,
  holdCommandResult?: HarnessCommandResultHolder,
) => Promise<HarnessMidTurnClientActionOutcome[]>;

/** Reads one mid-turn action, or undefined when malformed or a `command`. */
export const readHarnessMidTurnClientAction = (
  value: unknown,
): HarnessMidTurnClientAction | undefined => {
  if (!isObjectNotArray(value)) return undefined;
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "invoke_command" || kind === "list_commands") {
    return readHarnessTypedClientAction(value);
  }
  const action = readHarnessClientAction(value);
  return action === undefined || action.kind === "command" ? undefined : action;
};

/** A host's answer to one pending action, as the shared reader admits it. */
export type HarnessClientActionAnswer =
  | { form: "outcome"; params: HarnessChatResolveClientActionParams }
  | {
    form: "settlement";
    params: HarnessCommandResolveBody;

    /** Catalog entries refused on arrival, the rest having been admitted. */
    dropped?: HarnessCommandCatalogDrop;
  };

/** What the reader says when it admits nothing. */
export const HARNESS_CLIENT_ACTION_ANSWER_REQUIREMENT =
  `resolve_client_action requires sessionId, actionId, and either an outcome of done, declined, or failed with a result of at most ${HARNESS_CLIENT_ACTION_RESULT_MAX_LENGTH} characters, or a typed command settlement`;

/**
 * Reads a host's answer: the HTTP route's body and the stdio request's
 * params alike. A body carrying `settlement` settles a typed request and is
 * read by the contract's reader, after a catalog's entries are admitted one
 * by one ({@link admitHarnessCommandCatalogEntries}); any other settles a
 * final action.
 */
export const readHarnessClientActionAnswer = (
  value: unknown,
): HarnessClientActionAnswer | undefined => {
  if (!isObjectNotArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, "settlement")) {
    const { body, dropped } = admitHarnessCommandCatalogEntries(value);
    const params = readHarnessCommandResolveBody(body);
    if (params === undefined) return undefined;
    return {
      form: "settlement",
      params,
      ...(dropped !== undefined ? { dropped } : {}),
    };
  }
  const { sessionId, actionId, outcome, result } = record;
  if (
    typeof sessionId !== "string" || sessionId.length === 0 ||
    typeof actionId !== "string" || actionId.length === 0 ||
    !isHarnessClientActionOutcomeKind(outcome) ||
    (result !== undefined &&
      (typeof result !== "string" ||
        result.length > HARNESS_CLIENT_ACTION_RESULT_MAX_LENGTH))
  ) {
    return undefined;
  }
  return {
    form: "outcome",
    params: {
      sessionId,
      actionId,
      outcome,
      ...(result !== undefined ? { result } : {}),
    },
  };
};

/** The two events the coordinator writes. */
export type HarnessClientActionEvent = Extract<
  HarnessChatStructuredEvent,
  { kind: "client_action_requested" | "client_action_resolved" }
>;

/** What the coordinator needs from the session that holds it. */
export interface HarnessClientActionCoordinatorHooks {
  /**
   * Writes one event to the session's log. `onCommitted` runs once the event
   * is committed and before it is delivered, so state a reader may act on
   * during delivery is in place first.
   */
  emit(
    turnId: string,
    event: HarnessClientActionEvent,
    options?: { onCommitted?: () => void },
  ): Promise<void>;

  /** Mints an action id. */
  newActionId(): string;

  /** How long a call waits with none of its actions settled. */
  idleTimeoutMs: number;
}

/** What became of a host's answer. */
export type HarnessClientActionVerdict =
  | { status: "accepted" }
  | { status: "already_settled" }
  | { status: "unknown" }
  | { status: "mismatched"; message: string };

/** Why the console settled an action nobody answered. */
type ConsoleSettlementCause =
  | "canceled"
  | "timeout"
  | "not_delivered"
  | "delivery_failed";

/** A settlement as the coordinator applies it. */
type ActionSettlement =
  | {
    form: "outcome";
    outcome: HarnessClientActionOutcomeKind;
    result?: string;
  }
  | {
    form: "settlement";
    settlement: HarnessCommandSettlement;
    dropped?: HarnessCommandCatalogDrop;
  };

/** One requested action nobody has settled yet. */
interface PendingClientAction {
  action: HarnessMidTurnClientAction;
  holdCommandResult?: HarnessCommandResultHolder;

  /**
   * Set while a host's answer is having its result held. The answer arrived
   * first, so a timeout or cancel that comes due meanwhile waits for it
   * rather than overtaking it, and a second answer waits to be compared.
   * Never rejects.
   */
  answering?: Promise<void>;

  /** The console settlement that came due while an answer was being held. */
  overdue?: ConsoleSettlementCause;

  settle(
    settlement: ActionSettlement,
    byHost: boolean,
    handle?: string,
  ): Promise<void>;
}

const isTypedAction = (
  action: HarnessMidTurnClientAction | HarnessClientAction,
): action is HarnessTypedClientAction =>
  action.kind === "invoke_command" || action.kind === "list_commands";

/** The settlement the console gives an action nobody answered. */
const consoleSettlement = (
  action: HarnessMidTurnClientAction,
  cause: ConsoleSettlementCause,
): ActionSettlement => {
  if (!isTypedAction(action)) {
    // A final action has no word for "delivered, then abandoned"; both
    // delivery causes read as not delivered.
    return cause === "canceled"
      ? { form: "outcome", outcome: "declined", result: "canceled" }
      : cause === "timeout"
      ? { form: "outcome", outcome: "failed", result: "timeout" }
      : { form: "outcome", outcome: "failed", result: "not delivered" };
  }
  return {
    form: "settlement",
    settlement: cause === "not_delivered"
      // The request's own delivery failed and its resolved event follows at
      // once, so the client is told to drop it before it can act on it.
      ? { status: "failed_to_deliver", reason: "not delivered", landed: "no" }
      : { status: "interrupted", reason: cause },
  };
};

/**
 * Why a typed settlement does not answer the action it names, or undefined
 * when it does. A command request is answered by an outcome, a decline, or a
 * failure to deliver; a catalog request by a catalog or a failure to
 * deliver. The Weaver may make an invocation's approval stricter, never
 * laxer.
 */
const settlementMismatch = (
  action: HarnessMidTurnClientAction,
  settlement: HarnessCommandHostSettlement,
): string | undefined => {
  if (!isTypedAction(action)) {
    return "a final action is settled by an outcome, not a typed settlement";
  }
  if (action.kind === "list_commands") {
    return (settlement.status === "executed" && "catalog" in settlement) ||
        settlement.status === "failed_to_deliver"
      ? undefined
      : "a catalog request is settled by a catalog or a failure to deliver";
  }
  if (settlement.status === "executed" && "catalog" in settlement) {
    return "a command request is not settled by a catalog";
  }
  const attribution = "attribution" in settlement
    ? settlement.attribution
    : undefined;
  if (
    action.invocation.approval === "person" &&
    attribution?.approval === "automatic"
  ) {
    return "a command that asked for the person's approval did not run without it";
  }
  return undefined;
};

/**
 * One session's pending and settled client actions. The session record holds
 * one coordinator for its life, so an answer reaches the action whichever
 * turn or transport it arrives on.
 */
export class HarnessClientActionCoordinator {
  readonly #hooks: HarnessClientActionCoordinatorHooks;

  /** Actions awaiting the person, by actionId, in memory only. */
  readonly #pending = new Map<string, PendingClientAction>();

  /**
   * Every actionId this process has settled, so a repeat answer is told apart
   * from an id never minted. `answer` is the fingerprint of the settlement a
   * host itself gave a typed action: a client that lost the console's
   * acknowledgment resends the same answer after reconnecting, and a resend
   * matching it is accepted without effect, while a different one is told
   * the action is settled. Grows by one entry per settlement for the
   * session's life; harden with a bounded window if sessions ever run for
   * days.
   */
  readonly #settled = new Map<string, { answer?: string }>();

  constructor(hooks: HarnessClientActionCoordinatorHooks) {
    this.#hooks = hooks;
  }

  /**
   * Takes a host's answer for one action, already read by
   * {@link readHarnessClientActionAnswer}. An executed command's body is held
   * before the action settles, so its resolved event and the model both carry
   * the token.
   */
  async resolve(
    answer: HarnessClientActionAnswer,
  ): Promise<HarnessClientActionVerdict> {
    const { actionId } = answer.params;
    const pending = this.#pending.get(actionId);
    if (pending === undefined) return this.#settledVerdict(answer);
    if (answer.form === "outcome") {
      if (isTypedAction(pending.action)) {
        return {
          status: "mismatched",
          message: "a typed command request is settled by a settlement",
        };
      }
      await pending.settle(
        {
          form: "outcome",
          outcome: answer.params.outcome,
          ...(answer.params.result !== undefined
            ? { result: answer.params.result }
            : {}),
        },
        true,
      );
      return { status: "accepted" };
    }
    const { settlement } = answer.params;
    const mismatch = settlementMismatch(pending.action, settlement);
    if (mismatch !== undefined) {
      return { status: "mismatched", message: mismatch };
    }
    if (pending.answering !== undefined) {
      // Another answer is being held: this one is a resend or a conflict,
      // which the action's state once that one is done decides.
      await pending.answering;
      return await this.resolve(answer);
    }
    const holding = this.#holdResult(pending, settlement);
    pending.answering = holding.then(() => undefined, () => undefined);
    let handle: string | undefined;
    try {
      handle = await holding;
    } catch (error) {
      // Nothing was settled: the action stays open for a resend, unless a
      // timeout or cancel came due while the result was being held.
      pending.answering = undefined;
      const overdue = pending.overdue;
      if (overdue !== undefined && this.#pending.get(actionId) === pending) {
        await pending.settle(consoleSettlement(pending.action, overdue), false);
      }
      throw error;
    }
    pending.answering = undefined;
    // A failed delivery settles every written action at once, and does not
    // wait for an answer being held.
    if (this.#pending.get(actionId) !== pending) {
      return this.#settledVerdict(answer);
    }
    await pending.settle(
      {
        form: "settlement",
        settlement,
        ...(answer.dropped !== undefined ? { dropped: answer.dropped } : {}),
      },
      true,
      handle,
    );
    return { status: "accepted" };
  }

  /**
   * Helper for `resolve()`, which holds an executed command's body in the
   * run's handle table and answers its token. A command with no body to hold,
   * or a run that keeps no table, yields no token.
   */
  async #holdResult(
    pending: PendingClientAction,
    settlement: HarnessCommandHostSettlement,
  ): Promise<string | undefined> {
    if (
      pending.holdCommandResult === undefined ||
      pending.action.kind !== "invoke_command" ||
      settlement.status !== "executed" || !("outcome" in settlement) ||
      settlement.outcome.body === undefined
    ) {
      return undefined;
    }
    const provenance = harnessCommandResultProvenance(
      pending.action.invocation,
      settlement.attribution,
      settlement.outcome,
    );
    if (provenance === undefined) return undefined;
    return await pending.holdCommandResult({
      value: settlement.outcome.body,
      provenance,
    });
  }

  /** Helper for `resolve()`, which answers an id with nothing pending. */
  #settledVerdict(
    answer: HarnessClientActionAnswer,
  ): HarnessClientActionVerdict {
    const settled = this.#settled.get(answer.params.actionId);
    if (settled === undefined) return { status: "unknown" };
    return settled.answer !== undefined && answer.form === "settlement" &&
        settled.answer === settlementFingerprint(answer.params.settlement)
      ? { status: "accepted" }
      : { status: "already_settled" };
  }

  /**
   * Emits one request per action, then waits until every one is settled.
   * Everything waits for the person: the only other ways out are the idle
   * timeout (reset by each settlement, so a person working through a queue is
   * never cut off mid-way) and the turn's abort signal, which covers both a
   * turn cancel and a session close. A host's answer that arrived before
   * either is kept: while its result is still being held, the timeout or
   * cancel waits for it, and settles the action only if holding fails. Each
   * settlement, whatever its cause, emits one `client_action_resolved`.
   *
   * The client may answer a request while that request's own event is still
   * being delivered. That settlement records its outcome at once and queues
   * its resolved event behind the delivery, but does not wait for the write:
   * the event queue is held by the delivery, and a client that awaits its
   * answer from inside the delivery would otherwise wait on itself. The call
   * still awaits that write, so a failed one fails the call, except when a
   * request's own delivery fails: the call then fails with that error and the
   * write lands behind it. Only that answer is exempt; a delivery handler that
   * awaits any other request writing an event (another action's answer, a
   * cancel, a close) still waits on itself.
   */
  async request(
    turnId: string,
    actions: readonly HarnessMidTurnClientAction[],
    signal: AbortSignal | undefined,
    holdCommandResult?: HarnessCommandResultHolder,
  ): Promise<HarnessMidTurnClientActionOutcome[]> {
    if (signal?.aborted) {
      return actions.map((action) =>
        modelOutcome(action, consoleSettlement(action, "canceled"), undefined)
      );
    }
    const entries = actions.map((action) => ({
      action,
      actionId: this.#hooks.newActionId(),
    }));
    const outcomes = new Map<string, HarnessMidTurnClientActionOutcome>();
    const emits: Promise<void>[] = [];
    // Ids whose `client_action_requested` is in the log. Only these get a
    // `client_action_resolved`: a resolution for a request nobody wrote, or
    // one that precedes its request, would leave the log disagreeing with
    // what the client was shown.
    const requested = new Set<string>();
    // The id whose request is committed and still being delivered.
    let delivering: string | undefined;
    let emitting = true;
    let remaining = entries.length;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => finish = resolve);

    const settleOpen = (cause: ConsoleSettlementCause) =>
      entries.map((entry) => {
        const pending = this.#pending.get(entry.actionId);
        if (pending?.answering !== undefined) {
          pending.overdue ??= cause;
          return undefined;
        }
        return pending?.settle(consoleSettlement(entry.action, cause), false);
      });
    const armTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        void settleOpen("timeout");
      }, this.#hooks.idleTimeoutMs);
    };
    const settleOne = (
      entry: (typeof entries)[number],
      settlement: ActionSettlement,
      byHost: boolean,
      handle: string | undefined,
    ): Promise<void> => {
      // Synchronous, so a second answer for the same id meets a settled
      // action even while this one's event is still being written.
      this.#pending.delete(entry.actionId);
      const settled: { answer?: string } = byHost &&
          settlement.form === "settlement"
        ? { answer: settlementFingerprint(settlement.settlement) }
        : {};
      this.#settled.set(entry.actionId, settled);
      outcomes.set(
        entry.actionId,
        modelOutcome(entry.action, settlement, handle),
      );
      remaining -= 1;
      if (remaining > 0) armTimer();
      else if (timer !== undefined) clearTimeout(timer);
      let committed = false;
      const emitted = requested.has(entry.actionId)
        ? this.#hooks.emit(
          turnId,
          resolvedEvent(turnId, entry.actionId, settlement, handle),
          { onCommitted: () => committed = true },
        )
        : Promise.resolve();
      // A failed write is not swallowed: it fails the tool call through
      // `emits`, and the handler only keeps a rejection that lands before the
      // call awaits `emits` from surfacing as unhandled. A settlement whose
      // event never reached the log is no longer one a resend is told was
      // taken: a restart records the action interrupted.
      emitted.catch(() => {
        if (!committed) delete settled.answer;
      });
      emits.push(emitted);
      if (remaining === 0) finish();
      return entry.actionId === delivering ? Promise.resolve() : emitted;
    };
    const onAbort = () => {
      // While requests are still being written the abort is applied once
      // they stop, so no resolution is queued ahead of a later request.
      if (emitting) return;
      void settleOpen("canceled");
    };

    for (const entry of entries) {
      this.#pending.set(entry.actionId, {
        action: entry.action,
        ...(holdCommandResult !== undefined ? { holdCommandResult } : {}),
        settle: (settlement, byHost, handle) =>
          settleOne(entry, settlement, byHost, handle),
      });
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    // The id whose request was being written when the writing stopped.
    let failing: string | undefined;
    try {
      for (const { actionId, action } of entries) {
        // A cancel stops the writing: the rest are never requested, and
        // settle below as canceled without an event.
        if (signal?.aborted) break;
        // An idle timeout armed by an earlier answer can settle the rest
        // while one is still being delivered; a settled action is never shown.
        if (!this.#pending.has(actionId)) continue;
        failing = actionId;
        try {
          await this.#hooks.emit(turnId, {
            kind: "client_action_requested",
            turnId,
            actionId,
            action,
          }, {
            onCommitted: () => {
              requested.add(actionId);
              delivering = actionId;
            },
          });
        } finally {
          delivering = undefined;
        }
      }
    } catch (error) {
      // A request that is in the log is settled (the person may already
      // hold it); one never written is dropped so it cannot be answered. The
      // request whose delivery failed is told to the client as not delivered,
      // its resolved event following at once; one delivered before it may
      // already be running, so it is interrupted with its effect unknown.
      emitting = false;
      const written = entries.filter(({ actionId }) => requested.has(actionId));
      await Promise.allSettled(
        written.map((entry) =>
          this.#pending.get(entry.actionId)?.settle(
            consoleSettlement(
              entry.action,
              entry.actionId === failing ? "not_delivered" : "delivery_failed",
            ),
            false,
          )
        ),
      );
      for (const { actionId } of entries) this.#pending.delete(actionId);
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      throw error;
    }
    emitting = false;
    // The signal may have fired while the requests were being written.
    if (signal?.aborted) onAbort();
    else if (remaining > 0) armTimer();
    try {
      await finished;
      await Promise.all(emits);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    return entries.map((entry) => outcomes.get(entry.actionId)!);
  }

  /**
   * Takes up a session restored from its stored log: every action the log
   * settled is remembered as settled, and every one it requested and never
   * resolved is settled as interrupted. Pending actions live in memory, so
   * after a restart nothing can answer them, and they are never replayed as
   * commands; without a resolved event a client replaying the log would offer
   * the person a request that can only run and then be refused.
   */
  async restore(
    events: readonly HarnessChatStructuredEvent[],
  ): Promise<void> {
    const open = new Map<
      string,
      { turnId: string; action: HarnessMidTurnClientAction }
    >();
    for (const event of events) {
      if (event.kind === "client_action_requested") {
        open.set(event.actionId, {
          turnId: event.turnId,
          action: event.action as HarnessMidTurnClientAction,
        });
      } else if (event.kind === "client_action_resolved") {
        open.delete(event.actionId);
        this.#settled.set(
          event.actionId,
          event.settlement !== undefined &&
            event.settlement.status !== "interrupted"
            ? { answer: recordFingerprint(event.settlement) }
            : {},
        );
      }
    }
    for (const [actionId, { turnId, action }] of open) {
      this.#settled.set(actionId, {});
      const settlement: ActionSettlement = isTypedAction(action)
        ? {
          form: "settlement",
          settlement: { status: "interrupted", reason: "restart" },
        }
        : { form: "outcome", outcome: "failed", result: "interrupted" };
      await this.#hooks.emit(
        turnId,
        resolvedEvent(turnId, actionId, settlement, undefined),
      );
    }
  }
}

/**
 * Identifies a settlement by what its resolved event records of it, with the
 * handle left out, so an answer is compared the same way before and after a
 * restart and whatever order its keys were sent in. The record omits a
 * command's body, so two answers differing only in a body of the same size
 * compare equal; a resend carries the same body in any case.
 */
const recordFingerprint = (record: HarnessCommandSettlementRecord): string => {
  const { handle: _handle, ...rest } = record as Record<string, unknown>;
  return hashStringOf(rest as FabricValue);
};

/** {@link recordFingerprint} of the record a host's settlement writes. */
const settlementFingerprint = (settlement: HarnessCommandSettlement): string =>
  recordFingerprint(
    projectHarnessCommandSettlement(settlement, undefined).record,
  );

/** The resolved event one settlement writes. */
const resolvedEvent = (
  turnId: string,
  actionId: string,
  settlement: ActionSettlement,
  handle: string | undefined,
): HarnessClientActionEvent => {
  if (settlement.form === "outcome") {
    return {
      kind: "client_action_resolved",
      turnId,
      actionId,
      outcome: settlement.outcome,
      ...(settlement.result !== undefined ? { result: settlement.result } : {}),
    };
  }
  const projection = projectHarnessCommandSettlement(
    settlement.settlement,
    handle,
    undefined,
    settlement.dropped,
  );
  return {
    kind: "client_action_resolved",
    turnId,
    actionId,
    outcome: projection.outcome,
    ...(projection.result !== undefined ? { result: projection.result } : {}),
    settlement: projection.record,
  };
};

/** What the model reads of one settled action. */
const modelOutcome = (
  action: HarnessMidTurnClientAction,
  settlement: ActionSettlement,
  handle: string | undefined,
): HarnessMidTurnClientActionOutcome => {
  if (settlement.form === "outcome") {
    return {
      action: action as HarnessClientAction,
      outcome: settlement.outcome,
      ...(settlement.result !== undefined ? { result: settlement.result } : {}),
    };
  }
  return {
    action: action as HarnessTypedClientAction,
    settlement: projectHarnessCommandSettlement(
      settlement.settlement,
      handle,
      action.kind === "list_commands" ? action.request.detail : undefined,
      settlement.dropped,
    ).model,
  };
};
