import {
  FabricUnavailable,
  isUnavailable,
  UNAVAILABLE_SYNCING,
  unavailableError,
  type UnavailableObservationKind,
  type UnavailableVariant,
} from "@commonfabric/data-model/availability";

import { isPlainObject } from "@commonfabric/utils/types";
import { internSchema } from "@commonfabric/data-model-schema";

import { type Cell, getCellWithStatus } from "./cell.ts";
import type { Runtime } from "./runtime.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";
import { linkResolutionProbe } from "./storage/reactivity-log.ts";
import { isCellLink } from "./link-utils.ts";

const definedValueSchema = internSchema({
  not: { type: "undefined" },
});

const REASON_PRECEDENCE: Readonly<Record<UnavailableObservationKind, number>> =
  {
    error: 0,
    pending: 1,
    syncing: 2,
    "schemaMismatch": 0,
  };

/** Returns whether `candidate` outranks `current` under propagation policy. */
export function dataUnavailableReasonPrecedes(
  candidate: UnavailableObservationKind,
  current: UnavailableObservationKind,
): boolean {
  return REASON_PRECEDENCE[candidate] < REASON_PRECEDENCE[current];
}

/**
 * Selects the higher-precedence unavailable value, preserving the first value
 * when both reasons have equal precedence.
 */
export function preferDataUnavailable(
  current: FabricUnavailable | undefined,
  candidate: unknown,
): UnavailableVariant | undefined {
  if (!isUnavailable(candidate)) {
    return current as UnavailableVariant | undefined;
  }
  if (current === undefined) return candidate;
  return dataUnavailableReasonPrecedes(candidate.reason, current.reason)
    ? candidate
    : current as UnavailableVariant;
}

/** Converts schema traversal's availability status into its control value. */
export function dataUnavailableFromTransformFailure(status: {
  unavailableReason?: "syncing" | "error";
  unavailableError?: Error;
}): UnavailableVariant | undefined {
  if (status.unavailableReason === "syncing") {
    return UNAVAILABLE_SYNCING;
  }
  if (status.unavailableReason === "error") {
    return unavailableError(
      status.unavailableError ??
        new Error("Linked document synchronization failed"),
      "sync",
    );
  }
  return undefined;
}

/**
 * Selects a concrete marker from an already-materialized raw value. Arrays and
 * plain objects are walked depth-first in serialized order; Fabric instances,
 * cells, and other class instances remain opaque leaves.
 */
export function selectDataUnavailable(
  value: unknown,
): UnavailableVariant | undefined {
  const seen = new WeakSet<object>();
  let selected: UnavailableVariant | undefined;

  const visit = (candidate: unknown): void => {
    if (isUnavailable(candidate)) {
      selected = preferDataUnavailable(selected, candidate);
      return;
    }
    if (Array.isArray(candidate)) {
      if (seen.has(candidate)) return;
      seen.add(candidate);
      for (const child of candidate) visit(child);
      return;
    }
    if (isPlainObject(candidate)) {
      const record = candidate as Record<string, unknown>;
      if (seen.has(record)) return;
      seen.add(record);
      for (const child of Object.values(record)) visit(child);
    }
  };

  visit(value);
  return selected;
}

/**
 * Selects the unavailable marker controlling a raw built-in invocation while
 * following cell links from their exact serialized input positions.
 *
 * Reasons use runner-wide precedence, ties retain depth-first argument order,
 * and unresolved replica coverage becomes `syncing`. Structural lookalikes
 * remain ordinary data.
 */
export function selectUnavailableInput(
  value: unknown,
  resolution?: {
    runtime: Runtime;
    tx: IExtendedStorageTransaction;
    base: Cell<unknown>;
  },
  options: {
    skipTopLevelKeys?: readonly string[];
  } = {},
): UnavailableVariant | undefined {
  const seen = new WeakSet<object>();
  const seenLinks = new Set<string>();
  const skipped = new Set(options.skipTopLevelKeys ?? []);
  let selected: UnavailableVariant | undefined;

  const visit = (
    candidate: unknown,
    path: readonly PropertyKey[],
  ): void => {
    if (isUnavailable(candidate)) {
      selected = preferDataUnavailable(selected, candidate);
      return;
    }

    if (isCellLink(candidate)) {
      if (resolution !== undefined) {
        // Probe through the serialized input position, rather than directly
        // through the target cell. Keeping the local source side of a
        // cross-space link distinguishes missing replica coverage (syncing)
        // from an authored/local undefined value.
        const source = path.length === 0
          ? resolution.base
          : resolution.base.key(...path);
        const status = getCellWithStatus(
          source.asSchema(definedValueSchema).withTx(resolution.tx),
        );
        if ("error" in status) {
          const unavailable = dataUnavailableFromTransformFailure(status);
          if (unavailable === undefined) return;
          selected = preferDataUnavailable(
            selected,
            unavailable,
          );
          return;
        }

        // Resolve from the exact source position. Nested relative links are
        // relative to the document reached there, not necessarily to the
        // built-in's root input document.
        const target = source.withTx(resolution.tx).resolveAsCell();
        const link = target.getAsNormalizedFullLink();
        const linkKey = JSON.stringify([
          link.space,
          link.scope,
          link.id,
          link.path,
        ]);
        if (seenLinks.has(linkKey)) return;
        seenLinks.add(linkKey);
        visit(target.withTx(resolution.tx).getRaw(), path);
      }
      return;
    }

    if (Array.isArray(candidate)) {
      if (seen.has(candidate)) return;
      seen.add(candidate);
      for (let index = 0; index < candidate.length; index++) {
        visit(candidate[index], [...path, index]);
      }
      return;
    }

    if (isPlainObject(candidate)) {
      const record = candidate as Record<string, unknown>;
      if (seen.has(record)) return;
      seen.add(record);
      for (const [key, child] of Object.entries(record)) {
        if (path.length === 0 && skipped.has(key)) continue;
        visit(child, [...path, key]);
      }
    }
  };

  visit(value, []);
  return selected;
}

/**
 * Reads a cell without letting its schema hide a top-level unavailable value.
 *
 * The initial raw read is only a link-topology probe. A concrete marker is then
 * read normally so it remains a real data dependency; otherwise the ordinary
 * schema-aware read supplies the usable value unless `readValue` is false.
 * A marker-only probe leaves successful contents to the caller's read policy.
 * Lazy control builtins opt into
 * surfacing unresolved replica coverage as `syncing`; list coordinators leave
 * an unmaterialized child as undefined so their existing settle-and-republish
 * machinery can distinguish it from an explicit unavailable marker.
 */
export function readAvailabilityAwareCell<T>(
  tx: IExtendedStorageTransaction,
  cell: Cell<T>,
  options: { surfaceReplicaSyncing?: boolean; readValue?: boolean } = {},
): T | UnavailableVariant | undefined {
  const resolved = cell.withTx(tx).resolveAsCell();
  const raw = tx.runWithAmbientReadMeta(
    linkResolutionProbe,
    () => resolved.withTx(tx).getRaw({ lastNode: "value", nonRecursive: true }),
  );
  if (isUnavailable(raw)) {
    return resolved.withTx(tx).getRaw({
      lastNode: "value",
      nonRecursive: true,
    }) as UnavailableVariant;
  }

  if (raw === undefined && options.surfaceReplicaSyncing) {
    // A raw miss is ambiguous: it can be an authored/authoritative undefined,
    // or a linked selector whose local replica coverage is still loading.
    // Probe the source position through a schema which admits every defined
    // value so traversal can register the action's readiness waiter without
    // changing the cell's ordinary authored schema. Non-syncing failures fall
    // through to the existing get() behavior below (including authored
    // undefined).
    const status = getCellWithStatus(
      cell.withTx(tx).asSchema(definedValueSchema),
    );
    if ("error" in status) {
      const unavailable = dataUnavailableFromTransformFailure(status);
      if (unavailable !== undefined) return unavailable;
    }
  }
  return options.readValue === false ? undefined : cell.withTx(tx).get();
}
