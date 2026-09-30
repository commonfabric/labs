/**
 * Maintains collection aggregates as a tree of ordinary reactive child runs.
 * Membership reconciliation reads identities; value changes recompute a leaf
 * and its ancestors. Child ownership and rollback use the list machinery.
 * Every combine is associative and commutative, so the tree's order and
 * grouping cannot change a result; `docs/features/collection-aggregates.md`
 * explains why.
 */

import { utf8Compare } from "@commonfabric/utils/utf8";

import { createNodeFactory } from "../builder/module.ts";
import { pattern } from "../builder/pattern.ts";
import type { AddCancel } from "../cancel.ts";
import type { Cell } from "../cell.ts";
import { MAX_PATH_RESOLUTION_LENGTH } from "../link-resolution.ts";
import {
  isNormalizedFullLink,
  type NormalizedFullLink,
} from "../link-types.ts";
import type { RawBuiltinReturnType } from "../module.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  linkResolutionProbe,
  machineryRead,
} from "../storage/reactivity-log.ts";
import {
  type AggregateCandidate,
  chooseAggregateCandidate,
} from "./aggregate-extremum.ts";
import {
  type AggregateSum,
  aggregateSumLeaf,
  aggregateSumValue,
  combineAggregateSums,
} from "./aggregate-sum.ts";
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
import { issueResultContainerSetup } from "./list-result-container.ts";
import { ownedCell } from "./runtime-owned-store.ts";
import { resolveCellReference } from "./resolve-cell-reference.ts";
import {
  cellIdentityKey,
  narrowestCellScope,
  outputSpotFromBinding,
  scopedCell,
} from "./scope-policy.ts";

/** Supported aggregate operations; predicate count consumes mapped booleans. */
export type AggregateOperation =
  | "count"
  | "countTruthy"
  | "sum"
  | "min"
  | "max"
  | "minBy"
  | "maxBy";

/** One subtree's partial result. */
interface AggregateState {
  /** Number of included leaves for predicate count. */
  count?: number;

  /** Exact summation state. */
  sum?: AggregateSum;

  /** Selected element for an extremum; absent for an empty subtree. */
  candidate?: AggregateCandidate<Cell<unknown>>;
}

/** Shared immutable graph; constructed after runtime module initialization. */
let nodePattern:
  | ReturnType<typeof pattern<Record<string, unknown>>>
  | undefined;

/** Builds the graph for one aggregate tree node. */
function getNodePattern() {
  return nodePattern ??= pattern<Record<string, unknown>>(
    (input) =>
      createNodeFactory({ type: "ref", implementation: "aggregateNode" })(
        input,
      ),
    { type: "object", additionalProperties: true },
    true,
  );
}

/** Executes one leaf, binary combine, or final-value projection. */
export function aggregateNode(
  inputs: Cell<Record<string, unknown>>,
  sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
  _addCancel: AddCancel,
  _cause: unknown,
  _parent: Cell<unknown>,
  runtime: Runtime,
): RawBuiltinReturnType {
  return (tx) => {
    const args = inputs.withTx(tx);
    const operation = args.key("operation").get() as AggregateOperation;
    const mode = args.key("mode").get();
    const selectingElement = operation === "minBy" || operation === "maxBy";
    const publish = (state: AggregateState) => {
      if (operation === "sum") sendResult(tx, aggregateSumValue(state.sum!));
      else if (operation === "countTruthy") sendResult(tx, state.count!);
      else if (selectingElement) {
        sendResult(
          tx,
          state.candidate?.element,
        );
      } else {
        sendResult(
          tx,
          state.candidate?.score ??
            (operation === "min" ? Infinity : -Infinity),
        );
      }
    };
    const empty = (): AggregateState =>
      operation === "sum"
        ? { sum: aggregateSumLeaf(0) }
        : operation === "countTruthy"
        ? { count: 0 }
        : {};
    const combine = (
      left: AggregateState,
      right: AggregateState,
    ): AggregateState =>
      operation === "sum"
        ? { sum: combineAggregateSums(left.sum!, right.sum!) }
        : operation === "countTruthy"
        ? { count: left.count! + right.count! }
        : {
          candidate: chooseAggregateCandidate(
            left.candidate,
            right.candidate,
            operation === "min" || operation === "minBy",
            operation === "min" || operation === "max",
          ),
        };
    let state: AggregateState;
    if (mode === "leaf") {
      state = empty();
      const values = args.key("values").get() as number[];
      const keys = args.key("keys").get() as string[];
      for (let index = 0; index < values.length; index++) {
        const value = values[index];
        if (value === undefined) return;
        if (operation === "countTruthy") {
          state = combine(state, { count: value ? 1 : 0 });
        } else {
          if (typeof value !== "number") {
            throw new TypeError(`${operation} requires numeric values`);
          }
          state = combine(
            state,
            operation === "sum" ? { sum: aggregateSumLeaf(value) } : {
              candidate: {
                score: value,
                key: keys[index],
                ...(selectingElement
                  ? { element: args.key("elements").key(index) }
                  : {}),
              },
            },
          );
        }
      }
    } else if (mode === "empty") {
      state = empty();
    } else {
      const readState = (side: "left" | "right") => {
        const source = args.key(side);
        const state = source.get() as AggregateState | undefined;
        if (!selectingElement || !state?.candidate) return state;
        const elementSlot = source.key("candidate").key("element");
        const storedElement = elementSlot.getRawUntyped();
        // Legacy combine states store a normalized address as ordinary data.
        // Precise acquisition requires a live reference slot, so those states
        // must be recomputed before enabling the precise profile.
        if (isNormalizedFullLink(storedElement)) {
          if (tx.getCfcState().flowLabelsMode === "persist") {
            throw new Error(
              "Legacy aggregate references require recomputation before precise CFC",
            );
          }
          return {
            candidate: {
              score: state.candidate.score,
              key: state.candidate.key,
              element: runtime.getCellFromLink(storedElement, undefined, tx),
            },
          };
        }
        // Score and identity are values. The element remains a live reference
        // slot so child-state serialization retains its acquisition evidence.
        return {
          candidate: {
            score: state.candidate.score,
            key: state.candidate.key,
            element: elementSlot,
          },
        };
      };
      const left = readState("left");
      const right = readState("right");
      if (!left || !right) return;
      state = combine(left, right);
    }
    if (selectingElement && state.candidate) {
      state.candidate.element = resolveCellReference(
        runtime,
        tx,
        state.candidate.element!,
      );
    }
    if (args.key("final").get()) publish(state);
    else sendResult(tx, state);
  };
}

/** Builds and reconciles an identity-ordered aggregate tree. */
export function aggregate(
  inputs: Cell<
    { list: unknown[]; operation: AggregateOperation; elements?: unknown[] }
  >,
  sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
  addCancel: AddCancel,
  _cause: unknown,
  parent: Cell<unknown>,
  runtime: Runtime,
  outputBinding?: NormalizedFullLink,
  awaitSync?: boolean,
): RawBuiltinReturnType {
  const runs = new Map<string, ElementRun>();
  const setup: SetupRecord = { needsSetup: true };
  let result: Cell<unknown> | undefined;
  let resumeBatchAwaitSync = !!awaitSync;
  let active = true;
  addCancel(() => {
    active = false;
    releaseRemovedElements(runtime, runs, new Set());
  });
  return {
    action: async (tx) => {
      const elementAwaitSync = resumeBatchAwaitSync;
      if (elementAwaitSync) {
        // Resolve cold link targets in disposable read transactions so absence
        // observed before sync cannot pin the reconcile's snapshot.
        for (const field of ["list", "elements"] as const) {
          let target: Cell<unknown> = inputs.withTx(tx).key(field);
          for (let depth = 0;; depth++) {
            await target.sync();
            if (!active) return;
            const planTx = runtime.edit();
            let resolved: Cell<unknown>;
            try {
              if (tx.tx?.scopeKeyIdentity !== undefined && planTx.tx) {
                planTx.tx.scopeKeyIdentity = tx.tx.scopeKeyIdentity;
              }
              resolved = inputs.withTx(planTx).key(field).resolveAsCell()
                .withTx();
            } finally {
              planTx.abort("aggregate resume: read-only link resolution");
            }
            if (resolved.equalLinks(target)) break;
            if (depth >= MAX_PATH_RESOLUTION_LENGTH) {
              throw new Error("Aggregate input link resolution limit reached");
            }
            target = resolved.withTx(tx);
          }
        }
      }
      const rollback = trackListSetupRollback(tx, runtime, runs);
      const operation = inputs.withTx(tx).key("operation").get();
      const listCell = inputs.key("list").withTx(tx).resolveAsCell();
      const rawList = listCell.getRaw() as unknown;
      const slots = operation === "count"
        ? []
        : listSlotResolutions(runtime, tx, inputs).slots;
      if (rawList !== undefined && !Array.isArray(rawList)) {
        throw new TypeError(`${operation} requires an array`);
      }
      const cells = slots.map((link) =>
        runtime.getCellFromLink(link, undefined, tx)
      );
      const selectingElement = operation === "minBy" || operation === "maxBy";
      const elementSlots = selectingElement
        ? listSlotResolutions(runtime, tx, inputs, "elements").slots
        : slots;
      if (selectingElement && elementSlots.length !== slots.length) return;
      const elementCells = selectingElement
        ? elementSlots.map((link) =>
          runtime.getCellFromLink(link, undefined, tx)
        )
        : cells;
      const scope = narrowestCellScope(runtime, tx, [
        inputs.key("list"),
        ...cells,
        ...(selectingElement ? elementCells : []),
      ]);
      const outputSpot = outputSpotFromBinding(outputBinding);
      if (!outputSpot) throw new Error("Aggregate requires an output binding");
      if (!result || result.getAsNormalizedFullLink().scope !== scope) {
        const previous = result;
        result = ownedCell(
          runtime,
          tx,
          parent,
          { aggregate: parent.entityId, outputSpot },
          undefined,
          scope,
        ).withTx();
        const installed = result;
        rollback.resultReplaced(() => {
          if (result === installed) result = previous;
        });
        setup.needsSetup = true;
      }
      if (elementAwaitSync) {
        await result.withTx(tx).sync();
        if (!active) return;
        resumeBatchAwaitSync = false;
      }
      if (setup.needsSetup) {
        issueResultContainerSetup(
          tx,
          result.withTx(tx),
          parent,
          sendResult,
          rollback,
          setup,
        );
      }
      if (rawList === undefined) {
        tx.runWithAmbientReadMeta(
          { ...linkResolutionProbe, ...machineryRead },
          () => result!.withTx(tx).setRawUntyped(undefined, true),
        );
        releaseRemovedElements(runtime, runs, new Set());
        return;
      }
      if (operation === "count") {
        result.withTx(tx).setRawUntyped(
          rawList.reduce((count) => count + 1, 0),
          true,
        );
        releaseRemovedElements(runtime, runs, new Set());
        return;
      }
      const keys = listElementKeys(elementCells);
      const ordered = [...keys].sort((a, b) => utf8Compare(a[1], b[1]));
      const needed = new Set<string>();
      const makeNode = (
        key: string,
        args: Record<string, unknown>,
      ): Cell<unknown> => {
        key = JSON.stringify([scope, operation, key]);
        needed.add(key);
        let entry = runs.get(key);
        if (!entry) {
          const child = scopedCell(
            runtime,
            tx,
            runtime.getCell(
              parent.space,
              { aggregateNode: result, key },
              undefined,
              tx,
            ),
            scope,
          ).withTx();
          entry = { resultCell: child, lastIndex: 0, needsSetup: true };
          runs.set(key, entry);
          rollback.created(key, entry);
          entry.needsSetup = true;
        }
        if (entry.needsSetup) {
          runtime.runner.run(
            tx,
            getNodePattern(),
            { ...args, operation },
            entry.resultCell,
            {
              doNotUpdateOnPatternChange: true,
              awaitSyncBeforeInitialRun: elementAwaitSync,
              parentPieceRootId: parent.getAsNormalizedFullLink().id,
            },
          );
          setResultCell(entry.resultCell.withTx(tx), parent);
          setPatternCell(entry.resultCell.withTx(tx), parent.key("pattern"));
          rollback.setupIssued(entry);
        }
        return entry.resultCell;
      };
      const build = (start: number, end: number): Cell<unknown> => {
        const final = start === 0 && end === ordered.length;
        if (start === end) return makeNode("empty", { mode: "empty", final });
        if (end - start <= 32) {
          const block = ordered.slice(start, end);
          return makeNode(
            JSON.stringify([
              "leaf",
              final,
              block.map((
                [index, key],
              ) => [key, cellIdentityKey(cells[index]).linkKey]),
            ]),
            {
              mode: "leaf",
              final,
              keys: block.map(([, key]) => key),
              values: block.map(([index]) => cells[index]),
              ...(selectingElement
                ? { elements: block.map(([index]) => elementCells[index]) }
                : {}),
            },
          );
        }
        const middle = start + Math.floor((end - start) / 2);
        const left = build(start, middle);
        const right = build(middle, end);
        return makeNode(
          JSON.stringify([
            "branch",
            final,
            cellIdentityKey(left).linkKey,
            cellIdentityKey(right).linkKey,
          ]),
          {
            mode: "combine",
            final,
            left,
            right,
          },
        );
      };
      const root = build(0, ordered.length);
      // Publish the root address without following its selected element.
      // The coordinator depends on membership, not on winner changes.
      tx.runWithAmbientReadMeta(
        { ...linkResolutionProbe, ...machineryRead },
        () =>
          result!.withTx(tx).setRawUntyped(
            root.getAsLink({ base: result }),
            true,
          ),
      );
      releaseRemovedElements(runtime, runs, needed);
    },
  };
}
