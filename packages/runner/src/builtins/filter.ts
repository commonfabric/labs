import { internSchema } from "@commonfabric/data-model-schema";
import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import { getLogger } from "@commonfabric/utils/logger";

import type { Pattern } from "../builder/types.ts";
import type { AddCancel } from "../cancel.ts";
import { type Cell, syncCellForIdentity } from "../cell.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import type { RawBuiltinReturnType } from "../module.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";
import type { Runtime } from "../runtime.ts";
import type { Action } from "../scheduler.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  linkResolutionProbe,
  machineryRead,
} from "../storage/reactivity-log.ts";
import {
  listElementKeys,
  releaseRemovedElements,
} from "./list-element-keys.ts";
import {
  listCoordinatorPlan,
  listElementResultCell,
} from "./list-coordinator-plan.ts";
import {
  type ElementRun,
  type SetupRecord,
  trackListSetupRollback,
} from "./list-element-rollback.ts";
import { listInstanceCoordinator } from "./list-instance-coordinator.ts";
import { LIST_OP_REFERENCED_ARGUMENT_FIELDS } from "./list-op-argument-usage.ts";
import { resumeContainerWait } from "./list-result-container-seed.ts";
import { issueResultContainerSetup } from "./list-result-container.ts";
import {
  createResumeRepublisher,
  resumeSettleRunKind,
} from "./resume-republish.ts";

// Presence probe for the result container: slots resolve as cells, so the
// coordinator can ask "is the container initialized?" without materializing
// element contents. A content-schema get() here would journal real value
// reads of every element result — under flow labels (S16) that smears every
// element's taint into the coordinator's per-tx join and from there onto
// sibling scaffolding (the read-own-output feedback).
const RESULT_PRESENCE_SCHEMA = internSchema({
  type: "array",
  items: { asCell: ["cell"], type: "unknown" },
});

export const FILTER_INPUT_SCHEMA = internSchema({
  type: "object",
  properties: {
    list: { type: "array", items: { asCell: ["cell"], type: "unknown" } },
    op: { asCell: ["cell"] },
  },
  required: ["op"],
});

const logger = getLogger("runner.filter", { enabled: true, level: "warn" });

/**
 * Implementation of built-in filter module. Like map, this is called once at
 * setup and manages its own actions for the scheduler.
 *
 * Runs a predicate pattern per element. The output array contains cell
 * references to the original input elements where the predicate is truthy.
 * Output is always dense (no holes), even when the input is sparse.
 *
 * Identity tracking and reconciliation are identical to map — see map.ts for
 * the full explanation of how getAsNormalizedFullLink() provides stable
 * identity for cell links and positional identity for inline values.
 *
 * Two-pass convergence: when a new element appears, its predicate pattern
 * hasn't run yet, so the predicate cell is undefined and the element is
 * excluded. The predicate then runs, updating its cell, which re-triggers
 * this action. On the second pass the element is correctly included or
 * excluded.
 */
export function filter(
  inputsCell: Cell<{
    list: any[];
    op: Pattern;
    params?: Record<string, any>;
  }>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: AddCancel,
  _cause: any,
  parentCell: Cell<any>,
  runtime: Runtime,
  outputBinding?: NormalizedFullLink,
  awaitSync?: boolean,
): RawBuiltinReturnType {
  return listInstanceCoordinator((identity) =>
    createFilterInstance(
      inputsCell,
      sendResult,
      addCancel,
      _cause,
      parentCell,
      runtime,
      outputBinding,
      awaitSync,
      identity,
    ), addCancel);
}

/** Creates bookkeeping and deferred work for one resolution identity. */
function createFilterInstance(
  inputsCell: Cell<{
    list: any[];
    op: Pattern;
    params?: Record<string, any>;
  }>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: AddCancel,
  _cause: any,
  parentCell: Cell<any>,
  runtime: Runtime,
  outputBinding?: NormalizedFullLink,
  awaitSync?: boolean,
  identity?: ScopeKeyIdentity,
): RawBuiltinReturnType {
  let result: Cell<any[]> | undefined;
  // The containing piece's root: every element sub-piece this coordinator
  // starts is that piece's structure, so its actions' demand roots carry
  // the parent's chain (server-execution v2 Phase 7's demand-root chain;
  // RunnerRunOptions.parentPieceRootId) — a serving runtime resolves the
  // element's demanded instances through the OUTER root a client watches
  // instead of falling to the service identity (P7 review finding 4).
  const parentPieceRootId = parentCell.getAsNormalizedFullLink().id;

  // Whether the writes that make `result` reachable are owed. The coordinator
  // keeps the container across reconciles, so one that stages those writes and
  // then does not commit leaves it holding a container nothing links to; the
  // next reconcile issues them again. See list-element-rollback.ts.
  const containerSetup: SetupRecord = { needsSetup: false };

  // An element's links back to this coordinator. They are setup writes like the
  // element's pattern run: issued when the element is created, and again when
  // the transaction carrying them did not commit. Without them the element's
  // document names no owning piece, so nothing can start that piece for an
  // event addressed to it.
  const linkElementCell = (cell: Cell<any>): void => {
    setResultCell(cell, parentCell);
    setPatternCell(cell, parentCell.key("pattern"));
  };

  // Identity-based tracking: maps element address key → element run.
  // resultCell holds the predicate boolean for this element.
  const elementRuns = new Map<string, ElementRun>();

  // Cleared when the coordinator is torn down, so the asynchronous resume work
  // below stops writing to a result container nothing owns any more. The same
  // teardown releases the children the coordinator still holds; the ones whose
  // elements left the list were released when they left.
  let active = true;
  addCancel(() => {
    active = false;
    releaseRemovedElements(runtime, elementRuns, new Set());
  });

  // Only the initial (resume) reconcile defers its per-element sub-pattern runs
  // until sync completes; elements from later (post-resume) reconciles are fresh
  // and must not wait. Cleared once a non-empty resume batch is processed.
  let resumeBatchAwaitSync = !!awaitSync;

  // Rebuild the filtered list from the per-element predicate results: keep an
  // input element when its predicate settled truthy, exclude it when the
  // predicate settled a defined falsy value, and treat an undefined predicate as
  // still streaming in. See resume-republish.ts for the convergence machinery.
  // The Action the runner registered for this coordinator (a wrapper around
  // `reconcile`) — the identity the scheduler is keyed by, so the one a
  // re-arm must name.
  let registeredAction: Action | undefined;
  const rearmReconcile = (): void => {
    if (registeredAction) runtime.scheduler.invalidateAction(registeredAction);
  };

  // The wait this coordinator takes on its result container, which it takes
  // once per container.
  const containerWait = resumeContainerWait(
    runtime,
    logger,
    `filter/resume-seed/${parentCell.sourceURI}`,
    identity,
  );

  const { awaitingResult, awaitPendingThenRepublish } = createResumeRepublisher(
    {
      runtime,
      logger,
      isActive: () => active,
      getResult: () => result,
      inputsCell,
      identity,
      inputSchema: FILTER_INPUT_SCHEMA,
      resultSchema: RESULT_PRESENCE_SCHEMA,
      elementRuns,
      aggregateNoun: "filtered list",
      elementNoun: "predicate",
      contribute: (included, inputElement, out) => {
        if (included) out.push(inputElement);
        else if (included === undefined) return "pending";
      },
      rearmReconcile,
    },
  );

  // Hold the durable list while the input list itself confirms. On a resume
  // reconcile the input can be undefined or a transient empty default standing in
  // while the real list streams in; setting [] then would clobber the durable
  // aggregate. Await the resolved input and, once it confirms, clear the result
  // only if the input is genuinely empty — a non-empty input re-triggers the
  // normal reconcile via its journaled read, so it converges either way.
  const awaitInputThenSettle = (
    inputListCell: Cell<any>,
  ): void => {
    runtime.storageManager.trackUntilSettled(
      syncCellForIdentity(inputListCell, identity)
        .then(() =>
          !active ? undefined : runtime.editWithRetry((settleTx) => {
            if (!active || !result) return;
            if (identity !== undefined) settleTx.tx.scopeKeyIdentity = identity;
            // Out-of-band recovery write; the kind decision (bookkeeping
            // on the serving posture, derivation on clients — the settle
            // writes DERIVED content) is shared across map/filter/flatMap
            // in resumeSettleRunKind (r3756175819).
            runtime.stampServerRun(settleTx, {
              actionId: `filter/resume-settle/${parentCell.sourceURI}`,
              kind: resumeSettleRunKind(runtime),
              scopeKeyIdentity: identity,
            });
            const { list } = inputsCell.asSchema(FILTER_INPUT_SCHEMA)
              .withTx(settleTx).get();
            if (
              list === undefined || (Array.isArray(list) && list.length === 0)
            ) {
              settleTx.runWithAmbientReadMeta(
                { ...linkResolutionProbe, ...machineryRead },
                () =>
                  result!.asSchema(RESULT_PRESENCE_SCHEMA).withTx(settleTx)
                    .set([]),
              );
            }
          }).then(({ error }) => {
            if (error) {
              logger.warn("resume-input", "settling the resumed input failed", {
                error,
              });
            }
          })
        )
        .catch((error) =>
          logger.warn("resume-input", "the resumed input list sync rejected", {
            error,
          })
        ),
    );
  };

  const reconcile: Action = (tx: IExtendedStorageTransaction) => {
    const rollback = trackListSetupRollback(tx, runtime, elementRuns);
    const elementAwaitSync = resumeBatchAwaitSync;
    // The identity-bearing prefix — op, list materialization, scope, the
    // result container — is the plan the resume pre-sync shares, naming the
    // children this reconcile runs before the parent instantiates; its
    // reads and their rationale live in list-coordinator-plan.ts.
    const plan = listCoordinatorPlan(
      runtime,
      tx,
      "filter",
      inputsCell,
      FILTER_INPUT_SCHEMA,
      parentCell,
      outputBinding,
    );
    const { opPattern, argumentUsage, list } = plan;
    const outputScope = plan.scope;

    // Whether this reconcile issues the container's links: a container it
    // mints needs them, and one whose last issuance did not commit owes them.
    let issueLinks = containerSetup.needsSetup;
    if (!result || result.getAsNormalizedFullLink().scope !== outputScope) {
      const previousResult = result;
      // The container outlives this reconcile's transaction; a cell bound to
      // it would pin the settled transaction and its journal for the life of
      // the coordinator. Rebind per use instead.
      result = plan.container.withTx();
      const installedResult = result;
      // Give back only what this reconcile installed. An overlapping reconcile
      // that has already replaced the container owns it, and its bookkeeping
      // matches durable writes of its own.
      rollback.resultReplaced(() => {
        if (result === installedResult) result = previousResult;
      });
      issueLinks = true;
    }
    // A container this coordinator holds is reachable only through the links
    // below, and the reconcile that last issued them may not have committed.
    if (issueLinks) {
      issueResultContainerSetup(
        tx,
        result.withTx(tx),
        parentCell,
        sendResult,
        rollback,
        containerSetup,
      );
    }
    // The coordinator's view of the result container is links-only
    // (RESULT_PRESENCE_SCHEMA): get() probes presence and set() diffs
    // prior slots as links, never materializing element contents. A
    // content-schema view here journals value reads of every element
    // result on each reconcile — under flow labels (S16) that smears
    // every element's taint into the coordinator's per-tx join.
    const resultWithLog = result.asSchema(RESULT_PRESENCE_SCHEMA)
      .withTx(tx);
    // (S16) Declare the result container so prepare re-derives its `structure`
    // label (membership/order, §8.5.6.1) from this tx's J — the selection
    // criteria the coordinator read (predicate results) — EVERY reconcile,
    // decoupled from value writes. The membership taint settles on a later pass
    // than the container's root value write, and incremental changes are
    // slot/no-op writes that never re-stamp the root, so the taint would
    // otherwise never land (the dual of the input-read over-taint this fix
    // removes). Idempotent per reconcile; map deliberately does NOT declare.
    tx.recordCfcStructureContainer(result.getAsNormalizedFullLink());
    // Container reads/writes run under the link-resolution-probe scope (S16):
    // the presence probe and set() diffing materialize prior slots for identity
    // comparison only — per-slot labels ride the link-write machinery, not these
    // reads. See map.ts. Without it the asCell slot dereference journals a
    // content read of every prior element, smearing element taint into the
    // coordinator's per-tx join. The predicate read below stays unprobed: filter
    // membership genuinely depends on it (D4: "predicate results it read carry").
    // machineryRead rides along (template-population §6, SC-8): scaffolding
    // must not consume `*`-path membership templates on plumbing containers.
    const probeScoped = <T>(fn: () => T): T =>
      tx.runWithAmbientReadMeta(
        { ...linkResolutionProbe, ...machineryRead },
        fn,
      );
    const createRunInput = (element: Cell<any>, index: number) => ({
      ...(argumentUsage.usesElement ? { element } : {}),
      ...(argumentUsage.usesIndex ? { index } : {}),
      ...(argumentUsage.usesArray ? { array: inputsCell.key("list") } : {}),
      ...(argumentUsage.usesParams ? { params: inputsCell.key("params") } : {}),
    });

    // Resume against confirmed state, not the not-yet-loaded value: on the
    // resume reconcile an undefined container is its durable value still
    // streaming in (a filter that has run persisted at least []). Reconciling
    // now would write a stale-basis result that conflicts on commit and
    // re-runs against the same absent value until it happens to sync — the
    // reload commit storm. Wait for the container's pull instead; the wait
    // re-arms this reconcile once the pull settles, and it is taken once per
    // container, so the reconcile that follows reconciles against whatever the
    // container reads by then. Same shape in map.ts/flatmap.ts.
    if (
      elementAwaitSync &&
      containerWait.mayWait(result) &&
      probeScoped(() => resultWithLog.get()) === undefined
    ) {
      const container = result;
      containerWait.begin(
        container,
        () => active && result === container,
        rearmReconcile,
      );
      return;
    }
    // The durable aggregate currently in the container, read links-only
    // (presence schema), so this is a length comparison rather than a content
    // read of every element.
    const priorSlots = probeScoped(() => resultWithLog.get());
    const priorLen = Array.isArray(priorSlots) ? priorSlots.length : 0;

    // Resume preservation: on a resume reconcile the input list itself may not be
    // confirmed yet — undefined, or a transient empty default while the real list
    // streams in. Setting [] now would clobber the durable aggregate the
    // container already holds. Hold it and await the input; a non-empty input
    // then re-triggers this reconcile via its journaled read, and a confirmed
    // empty input clears the result. Outside resume the flag is clear, so a list
    // set undefined at runtime still runs the cleanup below.
    if (
      elementAwaitSync && priorLen > 0 &&
      (list === undefined || (Array.isArray(list) && list.length === 0))
    ) {
      awaitInputThenSettle(inputsCell.key("list").withTx(tx).resolveAsCell());
      return;
    }

    // A fresh (non-resume) reconcile has no container yet; seed [] so the first
    // render has a value. On resume this is unreachable — the defer guard above
    // either holds for the still-loading container or sees the durable value, so
    // priorSlots is never undefined here.
    if (priorSlots === undefined) {
      probeScoped(() => resultWithLog.set([]));
    }
    if (list === undefined) {
      probeScoped(() => resultWithLog.set([]));
      releaseRemovedElements(runtime, elementRuns, new Set());
      return;
    }

    if (!Array.isArray(list)) {
      throw new Error("filter currently only supports arrays");
    }

    // The whole current key set has to exist before any element is touched:
    // it is what says which predicates the list has stopped holding. A
    // released predicate's result never arrives, so releasing it also keeps it
    // out of the hold below.
    const elementKeys = listElementKeys(list);
    releaseRemovedElements(
      runtime,
      elementRuns,
      new Set(elementKeys.values()),
      outputScope,
    );

    if (list.length > 0) resumeBatchAwaitSync = false;

    const newArrayValue: any[] = [];
    // Every predicate the resume pass attaches, whatever it currently reads.
    // The values read here are local: a child that ran in this session has
    // written one, and the document behind it may still be catching up. Waiting
    // on the batch is what tells the reconciles that follow which documents
    // cannot yet carry a write.
    const resumeCells: Cell<any>[] = [];
    // Collected when an element is excluded only because its predicate result is
    // still streaming in (reads undefined). Their docs are awaited below so the
    // list can be republished once they confirm — distinct from a predicate that
    // has settled falsy, which reads false and is excluded immediately.
    const pendingCells: Cell<any>[] = [];
    for (let i = 0; i < list.length; i++) {
      // Skip sparse holes — don't create predicate runs for them
      if (!(i in list)) continue;

      const elementKey = elementKeys.get(i)!;

      if (elementRuns.has(elementKey)) {
        const existing = elementRuns.get(elementKey)!;
        const previousIndex = existing.lastIndex;
        if (
          existing.needsSetup ||
          (argumentUsage.usesIndex && existing.lastIndex !== i)
        ) {
          if (awaitingResult(existing.resultCell)) {
            // This predicate's document has not caught up, so setup written
            // now cannot land: the commit is rejected as stale and the retry
            // reads the same document again. Owe the setup until the wait ends.
            existing.needsSetup = true;
          } else {
            runtime.runner.run(
              tx,
              opPattern,
              createRunInput(list[i], i),
              existing.resultCell,
              {
                doNotUpdateOnPatternChange: true,
                awaitSyncBeforeInitialRun: elementAwaitSync,
                parentPieceRootId,
                referencedArgumentFields: LIST_OP_REFERENCED_ARGUMENT_FIELDS,
              },
            );
            // The whole setup, every time, because issuing it takes the debt
            // for it: an overlapping reconcile that wrote the links and has
            // not settled hands them to this one, and a partial issuance would
            // leave nobody owing them. Links already durable cost a
            // comparison, since a write of the value a leaf already holds does
            // not reach storage.
            linkElementCell(existing.resultCell.withTx(tx));
            rollback.setupIssued(existing);
          }
        }
        existing.lastIndex = i;
        if (previousIndex !== i) rollback.indexChanged(existing, previousIndex);
      } else {
        const boundResultCell = listElementResultCell(
          runtime,
          tx,
          "filter",
          result,
          elementKey,
        );
        // The stored cell outlives this reconcile's transaction: it lives in
        // `elementRuns` and in the cancel closure below, both of which last as
        // long as the coordinator. A cell bound to the transaction would pin
        // the settled transaction, its journal, and everything it read.
        const resultCell = boundResultCell.withTx();
        runtime.runner.run(
          tx,
          opPattern,
          createRunInput(list[i], i),
          resultCell,
          {
            doNotUpdateOnPatternChange: true,
            awaitSyncBeforeInitialRun: elementAwaitSync,
            parentPieceRootId,
            referencedArgumentFields: LIST_OP_REFERENCED_ARGUMENT_FIELDS,
          },
        );
        linkElementCell(boundResultCell);

        const entry = { resultCell, lastIndex: i, needsSetup: false };
        elementRuns.set(elementKey, entry);
        rollback.created(elementKey, entry);
      }

      // Read predicate result — creates subscription for reactivity.
      // Truthy/falsy coercion, not strict boolean.
      const childCell = elementRuns.get(elementKey)!.resultCell;
      if (elementAwaitSync) resumeCells.push(childCell);
      const included = childCell.withTx(tx).get();
      if (included) {
        newArrayValue.push(list[i]); // Original element cell reference
      } else if (included === undefined) {
        pendingCells.push(childCell);
      }
    }

    // Wait for the whole resume batch before the aggregate moves. Its
    // documents are the ones still catching up, and republishing from them once
    // they confirm is what keeps a partial view out of the durable container.
    if (resumeCells.length > 0) {
      awaitPendingThenRepublish(resumeCells);
      return;
    }

    // A predicate attached after the resume pass whose result is still
    // streaming in reads undefined and would exclude its element, shrinking
    // the aggregate below the durable value the container already holds.
    // Republishing that shrink is the reload flicker — a populated list blinks
    // to empty and refills. Hold the durable value and wait for the pending
    // predicates to confirm their docs, then republish against the confirmed
    // values. A predicate whose value arrived is included; one confirmed
    // undefined is excluded — so a genuine shrink still converges instead of
    // freezing.
    if (
      priorLen > 0 && newArrayValue.length < priorLen && pendingCells.length > 0
    ) {
      awaitPendingThenRepublish(pendingCells);
      return;
    }
    probeScoped(() => resultWithLog.set(newArrayValue));
  };

  // Child-starting coordinator: its reconcile must run on resume to
  // re-attach the per-element children.
  return {
    action: reconcile,
    onActionRegistered: (action) => {
      registeredAction = action;
    },
  };
}
