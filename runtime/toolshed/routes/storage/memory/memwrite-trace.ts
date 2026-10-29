/**
 * Gated diagnostic trace for writes hitting the v2 memory route.
 *
 * Off by default. Enable with `CF_DEBUG_MEMORY_WRITES=1`. Each emitted line
 * attributes one write to a specific client connection via `c=<n>` — the lever
 * that makes cross-client write storms diagnosable (e.g. whether two divergent
 * link targets for the same shared cell come from two distinct clients each
 * minting a different id, vs. one client alternating between branches).
 *
 * Values are summarized as a content hash (`vhash`). The hash is the
 * **canonical `FabricValue` hash** (`@commonfabric/data-model`) —
 * the same identity the runtime uses for `valueEqual` — so "same vhash" means
 * "same value by the runtime's own semantics". The parsed memory operations
 * carry hydrated `FabricValue`s (`parseClientMessage` →
 * `decodeMemoryBoundary`), so a JSON round-trip would silently collapse
 * distinct values (a `FabricPrimitive` or `FabricInstance` with no enumerable
 * fields, `undefined` object fields, non-finite numbers) into a false match —
 * exactly what would make a write-storm diagnostic lie. To additionally dump
 * raw values (`val=`), set `CF_DEBUG_MEMORY_WRITE_VALUES=1` — AVOID on real
 * data: cell values can contain user content, PII, or secrets. The hash alone
 * tells "same value" from "different value", which is all a divergence
 * investigation needs.
 *
 * This module holds the pure formatting so it is unit-testable; the impure parts
 * (env reads, per-connection counter, message parsing) live in the route.
 */

import {
  type FabricValue,
  hashStringOf,
  toCompactDebugString,
} from "@commonfabric/data-model";

/** A single operation from a parsed memory commit. */
export interface MemWriteOp {
  op?: string;
  id?: unknown;
  scope?: unknown;

  /** Present for `set`/`delete`; absent for `patch` (value lives in `patches`). */
  value?: FabricValue;

  /** JSON-patch entries for `patch` ops, each `{ path, value, ... }`. */
  patches?: FabricValue;
}

/** Sentinel `vhash` for an operation that carries no value (e.g. `delete`). */
const NO_VALUE_HASH = "--------";

/**
 * Sentinel `vhash` for a value the canonical hasher rejects. Not expected for a
 * well-formed `FabricValue`, but a diagnostic must never throw and abort the
 * trace (or, via the route's catch, the rest of a commit's ops).
 */
const UNHASHABLE = "<unhashable>";

/**
 * Length of the base64url hash prefix shown per line. 12 chars (~72 bits) is far
 * more than enough to tell writes apart by eye without bloating the log; the
 * full canonical hash is the source of truth, this is only its display form.
 */
const VHASH_DISPLAY_LEN = 12;

/** Max characters of raw value rendered after `val=`. */
const VALUE_DISPLAY_LEN = 600;

/**
 * Canonical `FabricValue` hash, truncated for display. Returns a sentinel
 * rather than throwing so a single odd op can never abort the trace.
 */
function displayVhash(value: FabricValue): string {
  try {
    return hashStringOf(value).slice(0, VHASH_DISPLAY_LEN);
  } catch {
    return UNHASHABLE;
  }
}

/**
 * Format one memory-commit operation as a single `[memwrite]` trace line.
 *
 * @param connId per-connection ordinal (`c=`), so a storm's writes can be
 *   attributed to specific clients.
 * @param includeValues when true, append the raw value (`val=`, truncated).
 *   Off by default — see the module-level privacy note.
 */
export function formatMemWriteTrace(
  op: MemWriteOp,
  connId: number,
  includeValues: boolean,
): string {
  // For `set`/`delete` the written value is `op.value`; for `patch` it lives in
  // the JSON-patch entries and `op.value` is absent. Summarize whichever is
  // present so a patch's value isn't silently dropped.
  const valueSource = op.patches !== undefined ? op.patches : op.value;
  const hasValue = valueSource !== undefined;
  const vhash = hasValue ? displayVhash(valueSource) : NO_VALUE_HASH;
  const paths = Array.isArray(op.patches)
    ? op.patches
      .map((p) => (p as { path?: unknown } | null)?.path)
      .filter((p) => p !== undefined)
      .slice(0, 4)
      .join(",")
    : "";
  const base = `[memwrite] c=${connId} op=${op.op} id=${
    String(op.id).slice(0, 28)
  } scope=${op.scope ?? "(space)"} vhash=${vhash} paths=[${paths}]`;
  if (!includeValues) return base;
  // Render via the canonical Fabric debug formatter (handles special
  // primitives/instances, bigints, non-finite numbers; never throws).
  const rendered = hasValue
    ? toCompactDebugString(valueSource, { maxLength: VALUE_DISPLAY_LEN })
    : "";
  return `${base} val=${rendered}`;
}
