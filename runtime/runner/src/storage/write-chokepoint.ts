/**
 * The mark the extended transaction's write chokepoint puts on every write
 * it forwards to the storage transaction beneath it.
 *
 * The chokepoint is where a write reaching a document's runtime-owned
 * members is judged: the meta fields of `meta-seam.ts`, which it refuses
 * unless the runtime authorizes the write, and the reserved siblings of
 * `reserved-sibling-seam.ts`, which it records for the commit boundary. The
 * storage transaction is reachable as the extended transaction's `.tx`, so a
 * write made there would skip both. It refuses a write that changes either
 * kind of member unless the write carries this mark, which says only that
 * the chokepoint saw it. A symbol cannot be named by a module that did not
 * import it, and the sandbox hands pattern code the builder namespace rather
 * than the runner's modules.
 */

import { isObjectNotArray } from "@commonfabric/js-values/types";

import type { IWriteOptions } from "./interface.ts";

/** The mark, as a key of write options. */
export const WRITE_CHOKEPOINT: unique symbol = Symbol("write-chokepoint");

/** Write options carrying {@link WRITE_CHOKEPOINT}. */
export interface PassedWriteChokepoint {
  readonly [WRITE_CHOKEPOINT]: true;
}

/**
 * The options the chokepoint forwards a write with: `options` with
 * {@link WRITE_CHOKEPOINT} added.
 */
export function writeChokepointMark(
  options?: IWriteOptions,
): IWriteOptions & PassedWriteChokepoint {
  return options === undefined
    ? MARK_ONLY
    : { ...options, [WRITE_CHOKEPOINT]: true };
}

/** Whether write options carry {@link WRITE_CHOKEPOINT}. */
export function passedWriteChokepoint(options: unknown): boolean {
  return isObjectNotArray(options) &&
    (options as Partial<PassedWriteChokepoint>)[WRITE_CHOKEPOINT] === true;
}

/** The mark alone, for a write that carries no other options. */
const MARK_ONLY: PassedWriteChokepoint = Object.freeze(
  { [WRITE_CHOKEPOINT]: true } as const,
);
