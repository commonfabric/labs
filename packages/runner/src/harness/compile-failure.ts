/**
 * Marker for deterministic compile failures on the by-identity cold-load
 * path.
 *
 * The negative memo must never turn a transient storage or resolver failure
 * into a session-long outage. The engine therefore marks only failures that
 * are pure functions of an already verified, content-addressed source
 * closure. Unmarked failures remain retryable, and marking refuses allocation
 * failures outright — heap pressure is not a function of the source.
 *
 * Boot-safe: no TypeScript or compiler-stack imports.
 */

// Deliberately a module-private WeakSet rather than a marker property: outside
// code must not be able to forge the classification, and set membership cannot
// be faked the way a property read can — a lying proxy trap or an inherited
// marker never answers for object identity. Membership never touches the
// object: add/has run no proxy traps and cannot throw for any object, frozen
// and revoked proxies included, so neither call needs a guard. A duplicated
// module graph can only cause a missed classification, which safely fails
// toward retrying.
import { isObjectOrArray } from "@commonfabric/utils/types";

const deterministicCompileFailures = new WeakSet<object>();

// An allocation failure is a function of heap pressure, not of the verified
// source bytes, so it must never be classified as deterministic. The messages
// are the stable V8 / JavaScriptCore / SpiderMonkey spellings for catchable
// allocation errors. Stack overflow is deliberately NOT excluded: an `await`
// drains caller stack depth before each classified compile step, and the engine
// stack limit is fixed within a runtime session. An overflow therefore recurs
// for the same compile inputs in that session.
const ALLOCATION_FAILURE_MESSAGE = /out of memory|allocation failed/i;

function isAllocationFailure(error: object): boolean {
  try {
    return ALLOCATION_FAILURE_MESSAGE.test(
      String((error as { message?: unknown }).message ?? ""),
    );
  } catch {
    // Exotic throwable: unclassifiable, so leave it retryable.
    return true;
  }
}

/** Mark and return a failure that will recur for the same verified bytes. */
export function markDeterministicCompileFailure<T>(error: T): T {
  if (
    isObjectOrArray(error) && !isAllocationFailure(error)
  ) {
    deterministicCompileFailures.add(error);
  }
  return error;
}

/** Construct an Error already classified as a deterministic compile failure. */
export function deterministicCompileError(message: string): Error {
  return markDeterministicCompileFailure(new Error(message));
}

/** True only for throwables stamped by this module. */
export function isDeterministicCompileFailure(error: unknown): boolean {
  return isObjectOrArray(error) &&
    deterministicCompileFailures.has(error);
}
