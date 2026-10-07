/**
 * Availability guards and zero-node aliases for built-in result channels.
 * Channel associations follow reactive cell identity within a pattern build.
 */

import type {
  CompileDiagnosticsOfFunction,
  CompileResultSource,
  HasErrorFunction,
  HasSchemaMismatchFunction,
  IsPendingFunction,
  IsSyncingFunction,
  ObserveAvailabilityFunction,
  PartialResultOfFunction,
  PartialResultSource,
  ResultOfFunction,
} from "@commonfabric/api";
import {
  hasError as hasErrorValue,
  hasSchemaMismatch as hasSchemaMismatchValue,
  isPending as isPendingValue,
  isSyncing as isSyncingValue,
} from "@commonfabric/data-model/availability";
import { toCell } from "../back-to-cell.ts";

/** Pure concrete-brand guard for the pending unavailable variant. */
export const isPending: IsPendingFunction = isPendingValue;

/** Pure concrete-brand guard for the error unavailable variant. */
export const hasError: HasErrorFunction =
  ((value: unknown) => hasErrorValue(value)) as HasErrorFunction;

/** Pure concrete-brand guard for the syncing unavailable variant. */
export const isSyncing: IsSyncingFunction = isSyncingValue;

/** Pure concrete-brand guard for the schemaMismatch unavailable variant. */
export const hasSchemaMismatch: HasSchemaMismatchFunction =
  hasSchemaMismatchValue;

/**
 * Runtime identity for the transformer-recognized availability observation
 * cast. It creates no builder node by itself.
 */
export const observeAvailability: ObserveAvailabilityFunction = ((
  value: unknown,
) => value) as ObserveAvailabilityFunction;

/**
 * Runtime identity for the transformer-recognized usable-result view. It
 * preserves the underlying reactive alias and creates no builder node.
 */
export const resultOf: ResultOfFunction = ((
  value: unknown,
) => value) as ResultOfFunction;

const partialResults = new WeakMap<object, unknown>();
const compileDiagnostics = new WeakMap<object, unknown>();

/** Normalizes a reactive alias to the identity of its underlying cell. */
function resultChannelKey(
  value: unknown,
  channel: "partial" | "compileDiagnostics",
): object {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    throw new TypeError(
      channel === "partial"
        ? "partialResultOf() requires a request returned by a streaming built-in"
        : "compileDiagnosticsOf() requires a request returned by compileAndRun()",
    );
  }

  // Pattern lowering names reactive values with `.for(...)`. Calling that
  // method on a reactive proxy returns its underlying Cell, so normalize both
  // forms to the same identity before consulting the side table.
  const maybeToCell = (value as { [toCell]?: unknown })[toCell];
  if (typeof maybeToCell === "function") {
    const cell = maybeToCell.call(value);
    if (
      (typeof cell === "object" && cell !== null) ||
      typeof cell === "function"
    ) {
      return cell;
    }
  }
  return value as object;
}

/** Associate one direct streaming result with its zero-node partial alias. */
export function associatePartialResult<Final, Partial>(
  result: unknown,
  partial: unknown,
): PartialResultSource<Final, Partial> {
  partialResults.set(resultChannelKey(result, "partial"), partial);
  return result as PartialResultSource<Final, Partial>;
}

/** Return the usable partial projection associated with a streaming call. */
export const partialResultOf: PartialResultOfFunction = ((value: unknown) => {
  const key = resultChannelKey(value, "partial");
  if (!partialResults.has(key)) {
    throw new TypeError(
      "partialResultOf() requires a request returned by a streaming built-in",
    );
  }
  return partialResults.get(key);
}) as PartialResultOfFunction;

/** Associates a direct compilation result with its live diagnostics cell. */
export function associateCompileDiagnostics<T>(
  result: unknown,
  diagnostics: unknown,
): CompileResultSource<T> {
  compileDiagnostics.set(
    resultChannelKey(result, "compileDiagnostics"),
    diagnostics,
  );
  return result as CompileResultSource<T>;
}

/** Returns the live diagnostics projection associated with a compilation. */
export const compileDiagnosticsOf: CompileDiagnosticsOfFunction = ((
  value: unknown,
) => {
  const key = resultChannelKey(value, "compileDiagnostics");
  if (!compileDiagnostics.has(key)) {
    throw new TypeError(
      "compileDiagnosticsOf() requires a request returned by compileAndRun()",
    );
  }
  return compileDiagnostics.get(key);
}) as CompileDiagnosticsOfFunction;
