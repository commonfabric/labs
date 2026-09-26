/**
 * The `agent` builtin: a pattern's request for an agent run.
 *
 * The request leaves the graph the way an llm request does — staged as a
 * sink request in the transaction that runs the node, measured at the commit
 * boundary, and acted on only after that commit is durable — with one
 * difference: what the post-commit effect does is create an `AgentRun`
 * record rather than call a model. The record is the handoff to a runner
 * process holding the requester's identity, and the builtin's result cell
 * follows the record from there: `pending` until the record reaches a
 * terminal state, `result` a link to the document the run's harness wrote,
 * `error` the record's error code. Inputs reach the record as links, never
 * as values, so what the sink gate measures is the task text and nothing
 * else.
 */

import type { BuiltInAgentParams } from "@commonfabric/api";
import type { Schema } from "@commonfabric/api/schema";
import { hashOf } from "@commonfabric/data-model";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";

import { INVALID_INPUT, REFUSED } from "../agent-error-codes.ts";
import type { JSONSchema } from "../builder/types.ts";
import { type Cell, isCell } from "../cell.ts";
import { renderCellReference } from "../cell-reference.ts";
import type { CfcConfClause } from "../cfc/clause.ts";
import { atomsOutsideCeiling } from "../cfc/observation.ts";
import { collectConsumedLabel } from "../cfc/prepare.ts";
import { createFrozenRequestSnapshot } from "../cfc/request-snapshot.ts";
import { enqueueSinkRequestPostCommitEffect } from "../cfc/sink-request.ts";
import {
  effectTargetKey,
  markEffectCompletion,
} from "../executor/effect-completion.ts";
import {
  delegatedCarriageOf,
  waveRunContextOf,
  waveSettlementOf,
} from "../executor/wave.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { getCellOrThrow } from "../query-result-proxy.ts";
import {
  type Runtime,
  type ServerRunInfo,
  spaceCellSchema,
} from "../runtime.ts";
import type { Action } from "../scheduler.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  AGENT_INPUT_NAME_PATTERN,
  AGENT_RUN_TERMINAL_STATES,
  AgentParamsSchema,
  AgentQueueIndexSchema,
  AgentResultSchema,
  AgentRunRecordSchema,
} from "./agent-schemas.ts";
import { ownedCell, recordRuntimeOwnedStore } from "./runtime-owned-store.ts";

/** The sink every agent request is staged under. */
export const AGENT_SINK = "agent";

/** The `AgentRun` record as the runtime reads it. */
export type AgentRunRecord = Schema<typeof AgentRunRecordSchema>;

/** The fields of the builtin's result cell, each bound to one transaction. */
type ResultFields = {
  pending: Cell<boolean>;
  result: Cell<unknown>;
  error: Cell<string | undefined>;
  requestHash: Cell<string | undefined>;
  run: Cell<unknown>;
  host: Cell<string | undefined>;
};

/** What the builtin keeps between runs of its action. */
type AgentNodeState = {
  resultCell?: Cell<any>;
  cellScope?: NormalizedFullLink["scope"];
  previousCallHash?: string;

  /**
   * The hash of the request the node most recently staged. A settlement
   * arriving for an older request finds a different value here and leaves
   * the result cell to the newer one.
   */
  currentHash?: string;
};

/**
 * The link an input cell contributes to the request snapshot: its address,
 * without the schema the handle happens to carry, so two handles to one
 * document hash alike.
 */
type InputLinkSnapshot = {
  space: MemorySpace;
  id: string;
  path: readonly string[];
  scope?: NormalizedFullLink["scope"];
};

/** The home-space agent queue as the runtime reads it. */
export type AgentQueueIndex = {
  entries?: { run: Cell<unknown>; host: string; address?: string }[];
  agentRunner?: {
    host: string;
    tools: string[];
    registrationId?: string;
    registeredAt: string;
    lastClaimAt?: string;
  };
};

/**
 * The agent queue of `homeSpace`'s owner: the `{run, host, address}` entries of every
 * record they submitted, and their `agentRunner` entry. It is the
 * `agentQueue` field of the home default pattern
 * (`packages/patterns/system/home.tsx`), the same cell
 * `wish({ query: "#agent_queue" })` resolves to. It reads as absent in a
 * home space whose default pattern does not exist or predates the field.
 */
export function agentQueueIndexCell(
  runtime: Runtime,
  homeSpace: MemorySpace,
  tx?: IExtendedStorageTransaction,
): Cell<AgentQueueIndex> {
  return runtime.getCell(homeSpace, homeSpace, spaceCellSchema, tx)
    .key("defaultPattern")
    .resolveAsCell()
    // The space cell's schema does not name the default pattern's fields.
    // deno-lint-ignore no-explicit-any
    .key("agentQueue" as any)
    .asSchema(AgentQueueIndexSchema) as unknown as Cell<AgentQueueIndex>;
}

/**
 * The `AgentRun` record for `requestHash` under the node `cause` names, in
 * the piece's space and the requester's instance. Its identity is the
 * request's, so the same request in the same instance names the same record.
 */
export function agentRunRecordCell(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  parentCell: Cell<any>,
  cause: unknown,
  requestHash: string,
): Cell<AgentRunRecord> {
  return runtime.getCell(
    parentCell.space,
    { agentRun: cause, requestHash },
    AgentRunRecordSchema,
    tx,
    "user",
  );
}

/**
 * Helper for `agent()`, which reports whether `queue` lists the `AgentRun`
 * record whose id is `recordId`.
 */
function listsRecord(
  queue: Cell<AgentQueueIndex>,
  recordId: string,
): boolean {
  return (queue.key("entries").get() ?? []).some((entry) =>
    entry.run.getAsNormalizedFullLink().id === recordId
  );
}

/**
 * Helper for `agent()`, which resolves what a pattern passed under `inputs`
 * to cell handles. The parameter schema reads every entry as a cell, so a
 * value a pattern wrote inline arrives as a handle to where it sits in the
 * node's argument, and the request carries that address like any other.
 */
function resolveInputHandles(
  inputs: Record<string, unknown> | undefined,
): Record<string, Cell<any>> {
  const handles: Record<string, Cell<any>> = {};
  for (const [name, value] of Object.entries(inputs ?? {})) {
    handles[name] = isCell(value) ? value : getCellOrThrow(value);
  }
  return handles;
}

/** Helper for `agent()`, which reports a rejected write to the operator. */
function reportRejection(what: string, requestHash: string, error: Error) {
  console.error(`[agent] ${what}`, { requestHash, rejection: error.message });
}

/** Helper for `agent()`, which snapshots one input handle as its address. */
function inputLinkSnapshot(cell: Cell<any>): InputLinkSnapshot {
  const link = cell.getAsNormalizedFullLink();
  return {
    space: link.space,
    id: link.id,
    path: [...link.path],
    ...(link.scope !== undefined ? { scope: link.scope } : {}),
  };
}

/** Helper for `agent()`, which binds the result cell's fields to `tx`. */
function resultFields(
  resultCell: Cell<any>,
  tx: IExtendedStorageTransaction,
): ResultFields {
  return {
    pending: resultCell.key("pending").withTx(tx),
    result: resultCell.key("result").withTx(tx),
    error: resultCell.key("error").withTx(tx),
    requestHash: resultCell.key("requestHash").withTx(tx),
    run: resultCell.key("run").withTx(tx),
    host: resultCell.key("host").withTx(tx),
  };
}

/**
 * Helper for `agent()`, which settles the result cell on a request that is
 * over without a run: no result, no record, the error the pattern reads.
 */
function settleWithoutRun(
  fields: ResultFields,
  error: string,
  requestHash: string | undefined,
): void {
  fields.pending.set(false);
  fields.result.set(undefined);
  fields.run.set(undefined);
  fields.host.set(undefined);
  fields.error.set(error);
  fields.requestHash.set(requestHash);
}

/**
 * Helper for `agent()`, which derives the result cell from the record: the
 * request is pending until the record reaches a terminal state, `result`
 * links to the record's result once it has completed, and `error` carries
 * the record's error code — or its outcome, where a runner wrote none —
 * when it ended any other way.
 */
function deriveFromRecord(
  fields: ResultFields,
  resultCell: Cell<any>,
  record: Cell<AgentRunRecord>,
  value: Pick<AgentRunRecord, "state" | "result" | "outcome" | "errorCode">,
  requestHash: string,
  host: string,
): void {
  const terminal = AGENT_RUN_TERMINAL_STATES.has(value.state);
  fields.pending.set(!terminal);
  fields.requestHash.set(requestHash);
  fields.run.setRawUntyped(record.getAsLink({ base: resultCell }), true);
  fields.host.set(host);
  if (value.state === "completed" && value.result !== undefined) {
    fields.result.setRawUntyped(
      record.key("result").getAsLink({ base: resultCell }),
      true,
    );
  } else {
    fields.result.set(undefined);
  }
  fields.error.set(
    terminal && value.state !== "completed"
      ? value.errorCode ?? value.outcome ?? value.state
      : undefined,
  );
}

/**
 * Submits an agent request and follows its run.
 *
 * `task` is context for the run; `inputs` are the cells it may read, passed
 * as links; `resultSchema` is what its structured result is validated
 * against; `maxConfidentiality` bounds what it may observe; `tools` selects
 * from the names the deployment publishes. The result cell holds `pending`,
 * `result` (a link to the result document), `error`, `requestHash`, and
 * `run` (a link to the `AgentRun` record).
 *
 * Off the `agentBuiltin` flag, every request settles with an error naming
 * the flag and nothing is staged.
 */
export function agent(
  inputsCell: Cell<BuiltInAgentParams>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: any,
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  const inputs = inputsCell.asSchema(AgentParamsSchema);
  const state: AgentNodeState = {};

  return (tx: IExtendedStorageTransaction) => {
    tx.resetNarrowestReadScope();
    const params = inputs.withTx(tx).get() ?? {};
    const { task, resultSchema, maxConfidentiality, tools } = params;
    const rawInputs = inputs.key("inputs").withTx(tx).get() as
      | Record<string, unknown>
      | undefined;
    const outputScope = tx.getNarrowestReadScope();
    const served = runtime.servingPosture &&
      runtime.experimental.serverExecution;
    // The identity this run acts as: the demanding principal's on a serving
    // runtime, the runtime's own elsewhere. Every later transaction of this
    // request is bound to it, so the user-scoped record resolves to the same
    // instance the staging run addressed.
    const identity: ScopeKeyIdentity = tx.tx.scopeKeyIdentity ??
      runtime.scopeKeyIdentity;

    if (!state.resultCell || state.cellScope !== outputScope) {
      state.resultCell = ownedCell(
        runtime,
        tx,
        parentCell,
        { agent: { result: cause } },
        AgentResultSchema,
        outputScope,
      );
      state.resultCell.sync();
      state.cellScope = outputScope;
      state.previousCallHash = undefined;
    }
    const resultCell = state.resultCell;
    sendResult(tx, resultCell);
    const fields = resultFields(resultCell, tx);

    if (runtime.experimental.agentBuiltin !== true) {
      settleWithoutRun(
        fields,
        "The agent built-in is off: the `agentBuiltin` experimental flag " +
          "(docs/development/EXPERIMENTAL_OPTIONS.md) is not enabled on " +
          "this runtime.",
        undefined,
      );
      return;
    }

    if (
      typeof task !== "string" || task.length === 0 ||
      resultSchema === undefined
    ) {
      // No request: nothing is in flight to abandon, since a staged request
      // is committed with its record and the record outlives this run.
      state.previousCallHash = undefined;
      fields.pending.set(false);
      fields.result.set(undefined);
      fields.error.set(undefined);
      fields.run.set(undefined);
      fields.host.set(undefined);
      fields.requestHash.set(undefined);
      return;
    }

    const invalidInputName = Object.keys(rawInputs ?? {}).find((name) =>
      !AGENT_INPUT_NAME_PATTERN.test(name)
    );
    if (invalidInputName !== undefined) {
      state.previousCallHash = undefined;
      state.currentHash = undefined;
      settleWithoutRun(
        fields,
        `${INVALID_INPUT}: agent input name must match ${AGENT_INPUT_NAME_PATTERN}, got \`${invalidInputName}\``,
        undefined,
      );
      return;
    }
    const inputHandles = resolveInputHandles(rawInputs);

    const requestSnapshot = createFrozenRequestSnapshot({
      task,
      inputs: Object.fromEntries(
        Object.entries(inputHandles).map((
          [name, cell],
        ) => [name, inputLinkSnapshot(cell)]),
      ),
      resultSchema: resultSchema as JSONSchema,
      ...(maxConfidentiality !== undefined ? { maxConfidentiality } : {}),
      ...(tools !== undefined ? { tools } : {}),
    });
    const hash = hashOf(requestSnapshot).toString();
    const effectId = `${AGENT_SINK}:${hash}`;
    const effectKey = effectTargetKey(effectId, resultCell, identity);

    const host = runtime.hostForSpace(parentCell.space).origin;

    /**
     * Runs `step` with the staging run's delegated carriage once `committed`
     * is durable. A serving runtime's wave can still withdraw an accepted
     * commit, and a withdrawn commit runs nothing.
     */
    const afterCommit = (
      committed: IExtendedStorageTransaction,
      step: (carriage: ServerRunInfo["delegated"]) => Promise<void>,
    ): void => {
      const settlement = served
        ? waveSettlementOf(committed) ?? waveSettlementOf(tx)
        : undefined;
      const carriage = delegatedCarriageOf(
        waveRunContextOf(committed) ?? waveRunContextOf(tx),
      );
      const work = Promise.resolve(settlement).then((verdict) =>
        verdict?.error ? undefined : step(carriage)
      );
      runtime.trackAsyncWork(work, parentCell);
    };

    /**
     * Records that this node hands the request off, and returns the function
     * that forgets it again. A handoff whose
     * transaction does not become durable is not in flight, so the next run
     * hands the request off again. On a serving runtime that includes a
     * transaction the wave withdraws after accepting it. Handing a request
     * off twice is harmless, since its record is found by its hash, created
     * once, and listed once.
     */
    const takeHandoff = (): () => void => {
      state.previousCallHash = hash;
      const forgetRequest = () => {
        if (state.previousCallHash === hash) state.previousCallHash = undefined;
      };
      tx.addCommitCallback((committedTx, commitResult) => {
        if (commitResult.error) return forgetRequest();
        const settlement = waveSettlementOf(committedTx) ??
          waveSettlementOf(tx);
        void settlement?.then(({ error }) => {
          if (error) forgetRequest();
        });
      });
      return forgetRequest;
    };

    /**
     * Lists the record in the requester's home-space index, or ends it
     * `refused` when it cannot be listed: a record no index names is a
     * request nothing will ever claim, and the result cell derives the
     * refusal from the record.
     */
    const listRecord = async (
      homeSpace: MemorySpace,
      carriage: ServerRunInfo["delegated"],
    ): Promise<void> => {
      /**
       * Writes the record's index entry, and returns why it did not land.
       * A serving runtime's wave can still withdraw the write after
       * accepting it. A contribution the wave drops is retryable in place,
       * and the write adds the entry only if it is not listed, so a first
       * drop issues the write once more against the state that dropped it.
       */
      const index = async (reissue: boolean): Promise<Error | undefined> => {
        const indexed = await runtime.editWithRetry((tx) => {
          // The index write is the runtime's own bookkeeping, made after the
          // request's run is over. Into a home space that is not the served
          // one it crosses on the staging run's carriage, which a serving wave
          // admits for an actor that owns or was granted the target space
          // (serving-loop.md §3d, "Multi-space seals").
          runtime.stampServerRun(tx, {
            actionId: `${AGENT_SINK}/index/${effectKey}`,
            kind: "bookkeeping",
            ...runtime.delegationForWriteTo(homeSpace, carriage),
          });
          tx.tx.scopeKeyIdentity = identity;
          const record = agentRunRecordCell(
            runtime,
            tx,
            parentCell,
            cause,
            hash,
          );
          const recordId = record.getAsNormalizedFullLink().id;
          const queue = agentQueueIndexCell(runtime, homeSpace, tx);
          // A home space with no queue has nowhere to list the record, and
          // writing the path anyway would leave a `defaultPattern` value where
          // the home pattern's own creation expects none.
          if (queue.withTx(tx).get() === undefined) {
            throw new Error("the home space holds no agent queue");
          }
          if (listsRecord(queue.withTx(tx), recordId)) return tx;
          const entries = queue.key("entries").withTx(tx);
          // The record's id determines the entry's address, so concurrent
          // index writes cannot reuse an element from the same list position.
          // The stored array can carry a different item schema. The writer's
          // canonical contract declares that each run resolves per user.
          const entry = entries.elementById(recordId).asSchema(
            AgentQueueIndexSchema.properties.entries.items,
          ) as Cell<{ run: Cell<unknown>; host: string; address?: string }>;
          entry.set({
            run: record,
            host,
            address: renderCellReference(record.getAsNormalizedFullLink()),
          });
          entries.addUnique(entry);
          return tx;
        });
        if (indexed.error) return indexed.error;
        const withdrawn = (await waveSettlementOf(indexed.ok))?.error;
        return reissue &&
            withdrawn?.waveWithdrawalCause === "contribution-dropped"
          ? index(false)
          : withdrawn;
      };
      const indexError = await agentQueueIndexCell(runtime, homeSpace).sync()
        .then(
          () => index(true),
          (error) => error instanceof Error ? error : new Error(String(error)),
        );
      if (indexError) {
        reportRejection(
          "Indexing the run record was rejected.",
          hash,
          indexError,
        );
        const refused = await runtime.editWithRetry((tx) => {
          markEffectCompletion(tx, effectKey);
          tx.tx.scopeKeyIdentity = identity;
          const record = agentRunRecordCell(
            runtime,
            tx,
            parentCell,
            cause,
            hash,
          );
          // A record another node has listed since, or a runner has claimed
          // through that listing, is no longer this effect's to end.
          const listed = listsRecord(
            agentQueueIndexCell(runtime, homeSpace, tx),
            record.getAsNormalizedFullLink().id,
          );
          if (listed || record.withTx(tx).key("state").get() !== "queued") {
            return;
          }
          recordRuntimeOwnedStore(tx, parentCell, record);
          const recordTx = record.withTx(tx);
          recordTx.key("state").set("refused");
          recordTx.key("stateSince").set(new Date().toISOString());
          recordTx.key("outcome").set("refused");
          recordTx.key("errorCode").set(REFUSED);
        });
        if (refused.error) {
          reportRejection(
            "Ending the unindexed record was rejected.",
            hash,
            refused.error,
          );
        }
      }
    };

    // The record's existence is the memo: reading it here is also what
    // re-runs this action when a runner moves it.
    const record = agentRunRecordCell(runtime, tx, parentCell, cause, hash);
    const recordValue = record.withTx(tx).get() as
      | AgentRunRecord
      | undefined;
    if (recordValue !== undefined && recordValue.state !== undefined) {
      runtime.effectMemoObserver?.({ kind: "hit", id: effectId });
      deriveFromRecord(fields, resultCell, record, recordValue, hash, host);
      // The process that created a record can stop before listing it, so a
      // node that finds one still `queued` without having handed it off
      // lists it, or ends it. Listing a record already listed writes
      // nothing.
      const homeSpace = runtime.homeSpacePrincipalFor(tx);
      if (
        recordValue.state === "queued" && hash !== state.previousCallHash &&
        homeSpace !== undefined
      ) {
        const forgetRequest = takeHandoff();
        // A request the release check refuses is not listed, and the result
        // cell keeps following the record. The node's next run tries again.
        enqueueSinkRequestPostCommitEffect(
          tx,
          AGENT_SINK,
          effectId,
          requestSnapshot,
          "agent-list",
          (committedTx) =>
            afterCommit(
              committedTx,
              (carriage) => listRecord(homeSpace, carriage),
            ),
          { idempotencyKey: effectKey, onReleaseRejected: forgetRequest },
        );
      }
      return;
    }

    // A request that settled without a run stays settled: the error is
    // recorded against its hash, and only a different request stages again.
    // One already staged and still in flight is not staged twice.
    const settledWithoutRun = fields.error.get() !== undefined &&
      fields.requestHash.get() === hash;
    if (settledWithoutRun || hash === state.previousCallHash) return;

    // The record is found through the requester's home-space index, so a run
    // with no requesting identity to resolve that space for has nowhere to
    // queue: it is refused here rather than left as a record nothing finds.
    const homeSpace = runtime.homeSpacePrincipalFor(tx);
    if (homeSpace === undefined) {
      state.previousCallHash = undefined;
      settleWithoutRun(
        fields,
        `${INVALID_INPUT}: the agent request has no requesting identity whose ` +
          "home space could index its run",
        hash,
      );
      return;
    }

    // The request is measured against the pattern's own ceiling here, before
    // anything is staged, over the label this transaction has consumed so
    // far — the same set the commit boundary measures — and on the raw
    // label, with no exchange rule run. The deployment's ceiling for the
    // `agent` sink is the commit boundary's to apply. A reference to a
    // labeled cell is a read of the pointer's label, which the runtime sets
    // to the target's, so inputs count here as much as the task text does.
    if (maxConfidentiality !== undefined) {
      const outside = atomsOutsideCeiling(
        collectConsumedLabel(tx).confidentiality,
        maxConfidentiality as readonly CfcConfClause[],
      );
      if (outside.length > 0) {
        state.previousCallHash = undefined;
        settleWithoutRun(
          fields,
          "the agent request carries confidentiality outside its " +
            "`maxConfidentiality` ceiling",
          hash,
        );
        return;
      }
    }

    takeHandoff();
    state.currentHash = hash;

    fields.pending.set(true);
    fields.result.set(undefined);
    fields.error.set(undefined);
    fields.requestHash.set(hash);
    fields.run.setRawUntyped(record.getAsLink({ base: resultCell }), true);
    fields.host.set(host);

    /**
     * Creates the record, re-reading the request under the effect's own
     * transaction so the record carries that read's labels, and refusing
     * to create one for a request the node has since replaced.
     */
    const createRecord = async (
      carriage: ServerRunInfo["delegated"],
    ): Promise<void> => {
      const queue = agentQueueIndexCell(runtime, homeSpace);
      try {
        await queue.sync();
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        reportRejection("Loading the home agent queue failed.", hash, cause);
        await settleAbandoned(
          new Error(`${AGENT_SINK} request was refused before it started`, {
            cause,
          }),
        );
        return;
      }
      if (tools !== undefined && tools.length > 0) {
        const runner = queue.key("agentRunner").get();
        if (runner !== undefined) {
          const missing = tools.filter((tool) => !runner.tools.includes(tool));
          if (missing.length > 0) {
            state.previousCallHash = undefined;
            await settleAbandoned(
              new Error(
                `${INVALID_INPUT}: the registered agent runner does not offer ` +
                  `${missing.map((tool) => `\`${tool}\``).join(", ")}`,
              ),
            );
            return;
          }
        }
      }
      const { error } = await runtime.editWithRetry((tx) => {
        markEffectCompletion(tx, effectKey);
        tx.tx.scopeKeyIdentity = identity;
        const live = inputs.withTx(tx).get();
        const liveHandles = resolveInputHandles(
          inputs.key("inputs").withTx(tx).get() as
            | Record<string, unknown>
            | undefined,
        );
        const liveSnapshot = createFrozenRequestSnapshot({
          task: live.task,
          inputs: Object.fromEntries(
            Object.entries(liveHandles).map((
              [name, cell],
            ) => [name, inputLinkSnapshot(cell)]),
          ),
          resultSchema: live.resultSchema as JSONSchema,
          ...(live.maxConfidentiality !== undefined
            ? { maxConfidentiality: live.maxConfidentiality }
            : {}),
          ...(live.tools !== undefined ? { tools: live.tools } : {}),
        });
        const replaced = hashOf(liveSnapshot).toString() !== hash;
        const record = agentRunRecordCell(
          runtime,
          tx,
          parentCell,
          cause,
          hash,
        );
        // Nothing to create for a request the node has since replaced, or
        // one whose record already holds a state. The state is read on its
        // own: a record missing a required field reads as absent when read
        // whole, and would be overwritten.
        const existingState = record.withTx(tx).key("state").get();
        if (replaced || existingState !== undefined) return;
        recordRuntimeOwnedStore(tx, parentCell, record);
        const now = new Date().toISOString();
        record.withTx(tx).set({
          requestHash: hash,
          request: resultCell,
          piece: parentCell,
          space: runtime.getCell(
            parentCell.space,
            parentCell.space,
            spaceCellSchema,
            tx,
          ),
          task: live.task,
          inputs: liveHandles,
          resultSchema: live.resultSchema,
          ...(live.maxConfidentiality !== undefined
            ? { maxConfidentiality: live.maxConfidentiality }
            : {}),
          ...(live.tools !== undefined ? { tools: live.tools } : {}),
          submittedAt: now,
          state: "queued",
          stateSince: now,
        });
      });
      if (error) {
        reportRejection("Creating the run record was rejected.", hash, error);
        await settleAbandoned(
          new Error(`${AGENT_SINK} request was refused before it started`, {
            cause: error,
          }),
        );
        return;
      }
      await listRecord(homeSpace, carriage);
    };

    /**
     * Settles a request that never went out — its staging transaction was
     * abandoned, or its release check refused it after commit — so the
     * result cell says so rather than staying pending forever. The message
     * names the sink and stops there; the refusal's detail faces the
     * operator. A request the node has since replaced leaves the cell to the
     * newer one.
     */
    const settleAbandoned = async (error: Error): Promise<void> => {
      await runtime.idle();
      const { error: writeError } = await runtime.editWithRetry((tx) => {
        markEffectCompletion(tx, effectKey);
        tx.tx.scopeKeyIdentity = identity;
        // Read at write time: a newer request can stage while this one
        // waits for the scheduler, and from then on the cell is its.
        if (state.currentHash !== hash) return;
        sendResult(tx, resultCell);
        settleWithoutRun(resultFields(resultCell, tx), error.message, hash);
      });
      if (state.previousCallHash === hash) state.previousCallHash = undefined;
      if (writeError) {
        reportRejection(
          "Writing the request's refusal was rejected.",
          hash,
          writeError,
        );
      }
    };

    enqueueSinkRequestPostCommitEffect(
      tx,
      AGENT_SINK,
      effectId,
      requestSnapshot,
      "agent-start",
      (committedTx) => afterCommit(committedTx, createRecord),
      {
        idempotencyKey: effectKey,
        onRejected: (error) => {
          runtime.trackAsyncWork(settleAbandoned(error), parentCell);
        },
        // The release check refusing after commit is the other way a staged
        // request never goes out; without this the result stays pending.
        onReleaseRejected: () => {
          const error = new Error(
            `${AGENT_SINK} request was not released after commit`,
          );
          runtime.trackAsyncWork(settleAbandoned(error), parentCell);
        },
      },
    );
  };
}
