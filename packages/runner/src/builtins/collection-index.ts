/** Owns per-occurrence reactive index maintenance and reconciles membership. */

import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";

import { createNodeFactory } from "../builder/module.ts";
import { pattern } from "../builder/pattern.ts";
import type { Pattern } from "../builder/types.ts";
import type { AddCancel } from "../cancel.ts";
import { type Cell, syncCellForIdentity } from "../cell.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import type { RawBuiltinReturnType } from "../module.ts";
import { snapshotQueryResult } from "../query-result-proxy.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";
import type { Runtime } from "../runtime.ts";
import type { Action } from "../scheduler.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  ignoreReadForScheduling,
  machineryRead,
} from "../storage/reactivity-log.ts";
import type { CollectionIndexMemberInput } from "./collection-index-member.ts";
import {
  type CollectionIndexMembership,
  maintainCollectionIndexMembership,
  type MaintainedCollectionIndex,
} from "./collection-index-membership.ts";
import { listSlotResolutions } from "./list-coordinator-plan.ts";
import {
  listElementKeys,
  releaseRemovedElements,
} from "./list-element-keys.ts";
import {
  type ElementRun,
  type SetupRecord,
  trackListSetupRollback,
} from "./list-element-rollback.ts";
import { listInstanceCoordinator } from "./list-instance-coordinator.ts";
import { issueResultContainerSetup } from "./list-result-container.ts";
import { ownedCell } from "./runtime-owned-store.ts";
import {
  cellIdentityKey,
  narrowestCellScope,
  outputSpotFromBinding,
  scopedCell,
} from "./scope-policy.ts";

/** Shared graph for a member whose inputs carry its owning index addresses. */
let memberPattern: Pattern | undefined;

/** Builds the graph for one source occurrence. */
function getMemberPattern() {
  return memberPattern ??= pattern<CollectionIndexMemberInput>(
    (input) =>
      createNodeFactory({
        type: "ref",
        implementation: "collectionIndexMember",
      })(input),
    {
      type: "object",
      properties: {
        extracted: { asCell: ["cell"], type: "unknown" },
        element: { asCell: ["cell"], type: "unknown" },
        // Setup watches retain shared addresses without traversing every bucket.
        state: { asCell: ["cell"], type: "unknown" },
        index: { asCell: ["cell"], type: "unknown" },
        occurrence: { type: "string" },
        mode: { enum: ["group", "key"] },
      },
      required: [
        "extracted",
        "element",
        "state",
        "index",
        "occurrence",
        "mode",
      ],
    },
    true,
  );
}

/** Shared graph for the independently demanded key enumeration. */
let keysPattern: Pattern | undefined;

/** Builds the graph that projects occupied membership into public keys. */
function getKeysPattern() {
  return keysPattern ??= pattern<
    { state: CollectionIndexMembership; tagged?: boolean }
  >(
    (input) =>
      createNodeFactory({
        type: "ref",
        implementation: "collectionIndexKeys",
        resultSchema: { type: "array", items: true },
      })(input),
    { type: "object", additionalProperties: true },
    true,
  );
}

/** Parallel source and tagged-selector arrays supplied by compiler lowering. */
export interface CollectionIndexInput {
  /** Tagged keys, aligned with the original source collection. */
  list: { isCell: boolean; value: unknown }[];

  /** Source occurrences whose original addresses are published in buckets. */
  elements: unknown[];

  /** Grouped or unique-key lookup behavior. */
  mode: "group" | "key";
}

/** Reconciles membership and starts owned children for the current occurrences. */
export function collectionIndex(
  inputs: Cell<CollectionIndexInput>,
  sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
  addCancel: AddCancel,
  _cause: unknown,
  parent: Cell<unknown>,
  runtime: Runtime,
  outputBinding?: NormalizedFullLink,
  awaitSync?: boolean,
): RawBuiltinReturnType {
  return listInstanceCoordinator((identity) =>
    createCollectionIndexInstance(
      inputs,
      sendResult,
      addCancel,
      parent,
      runtime,
      outputBinding,
      awaitSync,
      identity,
    ), addCancel);
}

/** Owns setup records for one serving principal and session. */
function createCollectionIndexInstance(
  inputs: Cell<CollectionIndexInput>,
  sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
  addCancel: AddCancel,
  parent: Cell<unknown>,
  runtime: Runtime,
  outputBinding?: NormalizedFullLink,
  awaitSync?: boolean,
  identity?: ScopeKeyIdentity,
): RawBuiltinReturnType {
  const runs = new Map<string, ElementRun>();
  const setup: SetupRecord = { needsSetup: true };
  let output: Cell<MaintainedCollectionIndex> | undefined;
  let active = true;
  let registeredAction: Action | undefined;
  const confirmed = new Set<string>();
  const pending = new Set<string>();
  let requiredConfirmations = new Set<string>();
  addCancel(() => {
    active = false;
    releaseRemovedElements(runtime, runs, new Set());
  });

  /** Holds resume reconciliation until each durable input has confirmed. */
  const isConfirmed = (cells: Cell<unknown>[]): boolean => {
    if (!awaitSync) return true;
    let ready = true;
    for (const cell of cells) {
      const key = cellIdentityKey(cell).dedupKey;
      requiredConfirmations.add(key);
      if (confirmed.has(key)) continue;
      ready = false;
      if (pending.has(key)) continue;
      pending.add(key);
      runtime.storageManager.trackUntilSettled(
        syncCellForIdentity(cell.withTx(), identity).finally(() =>
          pending.delete(key)
        ).then(() => {
          if (!active || !requiredConfirmations.has(key)) return;
          confirmed.add(key);
          if (registeredAction) {
            runtime.scheduler.invalidateAction(registeredAction);
          }
        }).catch((error: unknown) => {
          if (!active || !requiredConfirmations.has(key)) return;
          runtime.scheduler.reportError(
            new Error("Confirming index maintenance state failed", {
              cause: error,
            }),
            registeredAction ?? reconcile,
          );
        }),
      );
    }
    return ready;
  };

  const reconcile: Action = (tx) => {
    requiredConfirmations = new Set();
    try {
      const rollback = trackListSetupRollback(tx, runtime, runs);
      const args = inputs.withTx(tx);
      const mode = args.key("mode").get();
      const keys = listSlotResolutions(runtime, tx, inputs);
      const source = listSlotResolutions(runtime, tx, inputs, "elements");
      if (!isConfirmed([keys.listCell, source.listCell])) return;
      if (
        (keys.rawList !== undefined && !Array.isArray(keys.rawList)) ||
        (source.rawList !== undefined && !Array.isArray(source.rawList))
      ) {
        throw new TypeError("Collection indexing requires arrays");
      }
      const missingInput = keys.rawList === undefined ||
        source.rawList === undefined;
      if (!missingInput && keys.slots.length !== source.slots.length) return;
      // A confirmed absent input has no members. Reconcile it through the
      // same durable removal and child-release path as an empty array.
      const elements = (missingInput ? [] : source.slots).map((link) =>
        runtime.getCellFromLink(link, undefined, tx)
      );
      const extracted = (missingInput ? [] : keys.slots).map((link) =>
        runtime.getCellFromLink(link, undefined, tx)
      );
      const scope = narrowestCellScope(runtime, tx, [
        inputs.key("list"),
        inputs.key("elements"),
        ...elements,
        ...extracted,
      ]);
      const outputSpot = outputSpotFromBinding(outputBinding);
      if (!outputSpot) {
        throw new Error("Collection indexing requires an output binding");
      }
      const index = ownedCell<MaintainedCollectionIndex>(
        runtime,
        tx,
        parent,
        { collectionIndex: parent.entityId, outputSpot, mode },
        undefined,
        scope,
      );
      const state = ownedCell<CollectionIndexMembership>(
        runtime,
        tx,
        parent,
        { collectionIndexState: index },
        undefined,
        scope,
      );
      if (!isConfirmed([index, state])) return;
      if (!output || !output.equalLinks(index)) {
        const previous = output;
        output = index.withTx();
        const installed = output;
        rollback.resultReplaced(() => {
          if (output === installed) output = previous;
        });
        setup.needsSetup = true;
      }
      const needed = new Set<string>();
      const enumerations = (["keys", "keyEntries"] as const).map((surface) => {
        const runKey = JSON.stringify([surface, scope, mode]);
        needed.add(runKey);
        let entry = runs.get(runKey);
        if (!entry) {
          const child = scopedCell(
            runtime,
            tx,
            runtime.getCell(
              parent.space,
              surface === "keys"
                ? { collectionIndexKeys: index }
                : { collectionIndexKeyEntries: index },
              undefined,
              tx,
            ),
            scope,
          ).withTx();
          entry = { resultCell: child, lastIndex: -1, needsSetup: true };
          runs.set(runKey, entry);
          rollback.created(runKey, entry);
          entry.needsSetup = true;
        }
        return { surface, entry };
      });
      const occurrences = listElementKeys(elements);
      const neededOccurrences = new Set(occurrences.values());
      tx.runWithAmbientReadMeta(
        { ...ignoreReadForScheduling, ...machineryRead },
        () => {
          const descriptor = index.getRaw();
          if (descriptor === undefined) {
            index.set({
              kind: "collection-index",
              mode,
              keys: enumerations[0].entry.resultCell,
              keyEntries: enumerations[1].entry.resultCell,
              buckets: {},
            });
          } else if (!Object.hasOwn(descriptor, "keyEntries")) {
            index.key("keyEntries").set(enumerations[1].entry.resultCell);
          }
          if (state.getRaw() === undefined) {
            state.set({
              assignments: {},
              members: {},
              occupied: {},
            });
          }
          const assignments = snapshotQueryResult(
            state.key("assignments").get(),
          );
          for (const assignment of Object.values(assignments)) {
            if (assignment && !neededOccurrences.has(assignment.occurrence)) {
              maintainCollectionIndexMembership(
                tx,
                state,
                index,
                mode,
                assignment.occurrence,
                undefined,
                index,
              );
            }
          }
        },
      );
      for (const { surface, entry } of enumerations) {
        if (!entry.needsSetup) continue;
        const keysResultCell = entry.resultCell;
        // Child setup reads its stored result links as graph structure. The
        // coordinator does not consume the enumeration those links name.
        tx.runWithAmbientReadMeta(
          { ...ignoreReadForScheduling, ...machineryRead },
          () =>
            runtime.runner.run(
              tx,
              getKeysPattern(),
              { state, tagged: surface === "keyEntries" },
              keysResultCell,
              {
                doNotUpdateOnPatternChange: true,
                awaitSyncBeforeInitialRun: awaitSync,
                parentPieceRootId: parent.getAsNormalizedFullLink().id,
              },
            ),
        );
        setResultCell(entry.resultCell.withTx(tx), parent);
        setPatternCell(entry.resultCell.withTx(tx), parent.key("pattern"));
        rollback.setupIssued(entry);
      }
      if (setup.needsSetup) {
        issueResultContainerSetup(
          tx,
          index,
          parent,
          sendResult,
          rollback,
          setup,
        );
      }
      for (const [position, occurrence] of occurrences) {
        const key = JSON.stringify([
          scope,
          mode,
          occurrence,
          cellIdentityKey(extracted[position]).linkKey,
        ]);
        needed.add(key);
        let entry = runs.get(key);
        if (!entry) {
          const child = scopedCell(
            runtime,
            tx,
            runtime.getCell(
              parent.space,
              { collectionIndexMember: index, key },
              undefined,
              tx,
            ),
            scope,
          ).withTx();
          entry = { resultCell: child, lastIndex: position, needsSetup: true };
          runs.set(key, entry);
          rollback.created(key, entry);
          entry.needsSetup = true;
        }
        if (entry.needsSetup) {
          runtime.runner.run(
            tx,
            getMemberPattern(),
            {
              extracted: extracted[position],
              element: elements[position],
              state,
              index,
              occurrence,
              mode,
            },
            entry.resultCell,
            {
              doNotUpdateOnPatternChange: true,
              awaitSyncBeforeInitialRun: awaitSync,
              parentPieceRootId: parent.getAsNormalizedFullLink().id,
            },
          );
          setResultCell(entry.resultCell.withTx(tx), parent);
          setPatternCell(entry.resultCell.withTx(tx), parent.key("pattern"));
          rollback.setupIssued(entry);
        }
      }
      releaseRemovedElements(runtime, runs, needed, scope);
    } finally {
      for (const key of confirmed) {
        if (!requiredConfirmations.has(key)) confirmed.delete(key);
      }
    }
  };
  return {
    action: reconcile,
    onActionRegistered: (action) => {
      registeredAction = action;
    },
  };
}
