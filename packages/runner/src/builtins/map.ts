import { internSchema } from "@commonfabric/data-model-schema";
import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import { getLogger } from "@commonfabric/utils/logger";

import { type Pattern } from "../builder/types.ts";
import { type AddCancel } from "../cancel.ts";
import { type Cell, syncCellForIdentity } from "../cell.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import type { RawBuiltinReturnType } from "../module.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";
import type { Runtime } from "../runtime.ts";
import { type Action } from "../scheduler.ts";
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
import { resumeSettleRunKind } from "./resume-republish.ts";
import { exposedResultCell } from "./scope-policy.ts";

export const MAP_INPUT_SCHEMA = internSchema({
  type: "object",
  properties: {
    // `processDefaultValue()` treats `asCell` as an opaque cell boundary, so
    // `type: "unknown"` only documents the inner value shape here.
    list: { type: "array", items: { asCell: ["cell"], type: "unknown" } },
    op: { asCell: ["cell"] },
  },
  required: ["op"],
});

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

const logger = getLogger("runner.map", { enabled: true, level: "warn" });

/**
 * Implementation of built-in map module. Unlike regular modules, this will be
 * called once at setup and thus sets up its own actions for the scheduler.
 *
 * This supports both legacy map calls and closure-transformed map calls:
 * - Legacy mode (params === undefined): Passes { element, index, array } to pattern
 * - Closure mode (params !== undefined): Passes { element, index, array, params } to pattern
 *
 * The goal is to keep the output array current without recomputing too much.
 *
 * Elements are tracked by the normalized link address of their cell (via
 * `getAsNormalizedFullLink()`). The `asSchema` traverse with
 * `asCell: ["cell"]` already resolves cell links to target entities, so:
 *
 * - Cell links: `list[i]` resolves to a cell pointing at the target entity.
 *   Its normalized link is stable across position changes, enabling reuse.
 * - Inline values: `list[i]` resolves to a cell pointing at the array position.
 *   Its normalized link includes the positional index, so identity = position.
 *   Shifted inline values get new runs (acceptable trade-off).
 *
 * @param list - A doc containing an array of values to map over.
 * @param op - A pattern to apply to each value.
 * @param params - Optional object containing captured variables from outer scope (closure mode).
 * @returns A doc containing the mapped values.
 */
export function map(
  inputsCell: Cell<{
    list: any[];
    op: Pattern;
    params?: Record<string, any>;
  }>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: AddCancel,
  _cause: any,
  parentCell: Cell<any>,
  runtime: Runtime, // Runtime will be injected by the registration function
  outputBinding?: NormalizedFullLink,
  awaitSync?: boolean,
): RawBuiltinReturnType {
  return listInstanceCoordinator((identity) =>
    createMapInstance(
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
function createMapInstance(
  inputsCell: Cell<{
    list: any[];
    op: Pattern;
    params?: Record<string, any>;
  }>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: AddCancel,
  _cause: any,
  parentCell: Cell<any>,
  runtime: Runtime, // Runtime will be injected by the registration function
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

  // The Action the runner registers with the scheduler. `reconcile` below is
  // wrapped before registration, so its own identity is not the scheduler's
  // key: asynchronous work that must re-trigger the reconcile invalidates
  // this one.
  let registeredAction: Action | undefined;
  const rearmReconcile = (): void => {
    if (registeredAction) runtime.scheduler.invalidateAction(registeredAction);
  };

  // The wait this coordinator takes on its result container, which it takes
  // once per container.
  const containerWait = resumeContainerWait(
    runtime,
    logger,
    `map/resume-seed/${parentCell.sourceURI}`,
    identity,
  );

  // Identity-based tracking: maps element address key → { resultCell, lastIndex }
  // for reuse across position changes. We pass list[i] directly each time, so
  // there's no need to store the element cell separately.
  const elementRuns = new Map<string, ElementRun>();

  // Cleared when the coordinator is torn down, so the asynchronous resume work
  // below stops writing to a container nothing owns any more. The same teardown
  // releases the children the coordinator still holds; the ones whose elements
  // left the list were released when they left.
  let active = true;
  addCancel(() => {
    active = false;
    releaseRemovedElements(runtime, elementRuns, new Set());
  });

  // Only the initial (resume) reconcile should defer its per-element sub-pattern
  // runs until storage sync completes: with a synced-hold, its first
  // reconcile runs against synced data, and the per-element runs it starts
  // carry the same intent. Elements added by later (post-resume) reconciles
  // are fresh and must not wait.
  let resumeBatchAwaitSync = !!awaitSync;

  // Hold the durable container while the input list itself confirms. On a resume
  // reconcile the input can be undefined or a transient empty default standing in
  // while the real list streams in; setting [] then would clobber the durable
  // container the resume loaded. Await the resolved input and, once it confirms,
  // clear the container only if the input is genuinely empty — a non-empty input
  // re-triggers the normal reconcile via its journaled read, so it converges
  // either way.
  const awaitInputThenSettle = (inputListCell: Cell<any>): void => {
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
              actionId: `map/resume-settle/${parentCell.sourceURI}`,
              kind: resumeSettleRunKind(runtime),
              scopeKeyIdentity: identity,
            });
            const raw = inputsCell.key("list").withTx(settleTx).resolveAsCell()
              .withTx(settleTx).getRaw();
            if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) {
              settleTx.runWithAmbientReadMeta(
                { ...linkResolutionProbe, ...machineryRead },
                () =>
                  result!.asSchema(RESULT_PRESENCE_SCHEMA).withTx(settleTx).set(
                    [],
                  ),
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
    // Captured before the loop consumes it: this reconcile's element runs use
    // the current value; the flag is cleared only once a non-empty resume batch
    // has been processed (below), so a transient empty first reconcile doesn't
    // burn it.
    const elementAwaitSync = resumeBatchAwaitSync;
    // The identity-bearing prefix — op, list materialization, scope, the
    // result container — is the plan the resume pre-sync shares, naming the
    // children this reconcile runs before the parent instantiates; its
    // reads and their rationale live in list-coordinator-plan.ts.
    const plan = listCoordinatorPlan(
      runtime,
      tx,
      "map",
      inputsCell,
      MAP_INPUT_SCHEMA,
      parentCell,
      outputBinding,
    );
    const { opPattern, argumentUsage, listCell, list } = plan;
    const listScope = plan.scope;

    // Whether this reconcile issues the container's links: a container it
    // mints needs them, and one whose last issuance did not commit owes them.
    let issueLinks = containerSetup.needsSetup;
    if (!result || result.getAsNormalizedFullLink().scope !== listScope) {
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

    const createRunInput = (element: Cell<any>, index: number) => ({
      ...(argumentUsage.usesElement ? { element } : {}),
      ...(argumentUsage.usesIndex ? { index } : {}),
      ...(argumentUsage.usesArray ? { array: listCell } : {}),
      ...(argumentUsage.usesParams ? { params: inputsCell.key("params") } : {}),
    });

    // If the result's value is undefined, set it to the empty array.
    // Container reads run under the link-resolution-probe scope: the
    // presence probe and set() diffing materialize prior slot targets for
    // identity comparison only — the coordinator never consumes element
    // content, and the written links carry their per-slot labels via the
    // link-write machinery. Without the scope, the asCell slot dereference
    // journals a content read of every prior element result, feeding the
    // coordinator's own output taint back into its next reconcile's J and
    // smearing it onto fresh elements' scaffolding (S16 pointwise).
    // machineryRead rides along (template-population §6): the same
    // scaffolding reads must not consume `*`-path membership templates on
    // plumbing containers now that the generic mint route is on (SC-8).
    const probeScoped = <T>(fn: () => T): T =>
      tx.runWithAmbientReadMeta(
        { ...linkResolutionProbe, ...machineryRead },
        fn,
      );
    // Resume against confirmed state, not the not-yet-loaded value: on the
    // resume reconcile an undefined container is its durable value still
    // streaming in (a map that has run persisted at least []). Reconciling
    // now would write a stale-basis result that conflicts on commit and
    // re-runs against the same absent value until it happens to sync — the
    // reload commit storm. Wait for the container's pull instead; the wait
    // re-arms this reconcile once the pull settles, and it is taken once per
    // container, so the reconcile that follows reconciles against whatever the
    // container reads by then. Same shape in filter.ts/flatmap.ts.
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
    // Resume preservation: on a resume reconcile the input list itself may not be
    // confirmed yet — undefined, or a transient empty default while the real list
    // streams in. Setting [] now would clobber the durable container the resume
    // loaded (map's output is link-shaped, so its slots survive a pending element,
    // but a pending input would still blank the whole container). Hold it and
    // await the input; a non-empty input then re-triggers this reconcile via its
    // journaled read, and a confirmed empty input clears the container. Outside
    // resume the flag is clear, so a list set undefined at runtime still runs the
    // cleanup below.
    const priorSlots = probeScoped(() => resultWithLog.get());
    const priorLen = Array.isArray(priorSlots) ? priorSlots.length : 0;
    if (
      elementAwaitSync && priorLen > 0 &&
      (list === undefined || (Array.isArray(list) && list.length === 0))
    ) {
      awaitInputThenSettle(listCell);
      return;
    }

    // A fresh (non-resume) reconcile has no container yet; seed [] so the first
    // render has a value. On resume this is unreachable — the defer guard above
    // either holds for the still-loading container or sees the durable value, so
    // priorSlots is never undefined here.
    if (priorSlots === undefined) {
      probeScoped(() => resultWithLog.set([]));
    }
    // If the list is undefined it means the input isn't available yet.
    // Correspondingly, the result should be []. TODO: Maybe it's important to
    // distinguish empty inputs from undefined inputs?
    if (list === undefined) {
      probeScoped(() => resultWithLog.set([]));
      releaseRemovedElements(runtime, elementRuns, new Set());
      return;
    }

    if (!Array.isArray(list)) {
      throw new Error("map currently only supports arrays");
    }

    // The resume batch has now been observed; later reconciles are post-resume.
    if (list.length > 0) resumeBatchAwaitSync = false;

    // The whole current key set has to exist before any element is touched:
    // it is what says which children the list has stopped holding.
    const elementKeys = listElementKeys(list);
    releaseRemovedElements(
      runtime,
      elementRuns,
      new Set(elementKeys.values()),
      listScope,
    );

    const newArrayValue = new Array<any>(list.length);
    for (let i = 0; i < list.length; i++) {
      // Skip sparse holes — don't create pattern runs for them
      if (!(i in list)) continue;

      const elementKey = elementKeys.get(i)!;

      if (elementRuns.has(elementKey)) {
        const existing = elementRuns.get(elementKey)!;
        const previousIndex = existing.lastIndex;
        if (
          existing.needsSetup ||
          (argumentUsage.usesIndex && existing.lastIndex !== i)
        ) {
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
          // The whole setup, every time, because issuing it takes the debt for
          // it: an overlapping reconcile that wrote the links and has not
          // settled hands them to this one, and a partial issuance would leave
          // nobody owing them. Links already durable cost a comparison, since
          // a write of the value a leaf already holds does not reach storage.
          linkElementCell(existing.resultCell.withTx(tx));
          rollback.setupIssued(existing);
        }
        existing.lastIndex = i;
        if (previousIndex !== i) rollback.indexChanged(existing, previousIndex);
        newArrayValue[i] = exposedResultCell(runtime, tx, existing.resultCell);
      } else {
        const boundResultCell = listElementResultCell(
          runtime,
          tx,
          "map",
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
        newArrayValue[i] = exposedResultCell(runtime, tx, resultCell);
      }
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
