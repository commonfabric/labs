import { type FabricValue, valueEqual } from "@commonfabric/data-model";
import { isObjectNotArray } from "@commonfabric/js-values/types";

import { cfcMetadataPresent } from "./cfc/metadata.ts";
import type { IWriteOptions } from "./storage/interface.ts";

/**
 * The reserved siblings: the document-root siblings of `value` that hold
 * runtime state rather than user data, and that no meta field covers.
 *
 * `cfc` holds the persisted CFC label map. `source` names the entity a
 * document was derived from. The CFC prepare pass excludes both from its
 * accounting — a read of one is left out of the flow join, and a write to one
 * is left out of schema write policy and flow-label attachment — so the
 * writes it accounts for are the writes on the value surface. That exclusion
 * describes the runtime's own bookkeeping, and it holds only while the
 * runtime is the one writing here, which the write chokepoint establishes: a
 * write reaching one of these from outside the privileged persistence scope
 * is recorded, and the commit boundary turns each record into a fail-closed
 * reason. A name added to this list joins both the exclusion and the guard.
 *
 * The chokepoint is the extended transaction's write surface. The storage
 * transaction beneath it, which anything holding an extended transaction
 * reaches as its `.tx`, refuses outright a write that changes a reserved
 * sibling and does not carry {@link RESERVED_SIBLING_WRITE_RECORDED}, the
 * mark the chokepoint puts on every write it forwards. That refusal holds
 * whatever the CFC enforcement mode, since a write that skipped the
 * chokepoint left nothing for the commit boundary to judge.
 *
 * The meta fields are a separate seam with a separate guard: a write there
 * names the program a piece runs, and is refused outright rather than
 * recorded. See {@link file://./meta-seam.ts}.
 */
export const RESERVED_SIBLINGS = Object.freeze(["cfc", "source"] as const);

/** One of the {@link RESERVED_SIBLINGS}. */
export type ReservedSibling = typeof RESERVED_SIBLINGS[number];

/** Whether the given field name addresses a reserved sibling. */
export function isReservedSibling(field: string): field is ReservedSibling {
  return RESERVED_SIBLING_SET.has(field);
}

const RESERVED_SIBLING_SET: ReadonlySet<string> = new Set(RESERVED_SIBLINGS);

/**
 * How a write changes a reserved sibling: `addressed` names the sibling, or
 * a path inside it; `forgery` replaces the document envelope with one that
 * carries a sibling other than the stored one; `erasure` replaces it with one
 * that leaves a stored sibling out.
 */
export type ReservedSiblingChange = "addressed" | "forgery" | "erasure";

/**
 * The reserved siblings a write at `path` carrying `value` changes, and how.
 *
 * A write under `value` changes none, whatever a user key is named. A write
 * addressed at a sibling changes it whatever it carries. A write at the
 * document root replaces the whole envelope, so it reaches every sibling at
 * once, by omission as much as by overwrite, and changes each one it does not
 * carry forward from `stored`, which reads the sibling the document holds.
 * `stored` is called only for a root write.
 */
export function reservedSiblingChanges(
  path: readonly string[],
  value: unknown,
  stored: (sibling: ReservedSibling) => unknown,
): readonly (readonly [ReservedSibling, ReservedSiblingChange])[] {
  if (path.length > 0) {
    return isReservedSibling(path[0])
      ? [[path[0], "addressed"]]
      : NO_RESERVED_SIBLING_CHANGES;
  }
  const envelope = isObjectNotArray(value) ? value : undefined;
  let changes:
    | (readonly [ReservedSibling, ReservedSiblingChange])[]
    | undefined;
  for (const sibling of RESERVED_SIBLINGS) {
    const carried = envelope?.[sibling];
    const held = stored(sibling);
    if (reservedSiblingPresent(sibling, carried)) {
      if (reservedSiblingCarriedForward(carried, held)) continue;
      (changes ??= []).push([sibling, "forgery"]);
    } else if (reservedSiblingPresent(sibling, held)) {
      (changes ??= []).push([sibling, "erasure"]);
    }
  }
  return changes ?? NO_RESERVED_SIBLING_CHANGES;
}

/**
 * Marks a write as one the extended transaction's write chokepoint has seen,
 * which is the only mark the storage transaction beneath it accepts for a
 * write that changes a reserved sibling. A symbol cannot be named by a module
 * that did not import it, and the sandbox hands pattern code the builder
 * namespace rather than the runner's modules.
 */
export const RESERVED_SIBLING_WRITE_RECORDED: unique symbol = Symbol(
  "reserved-sibling-write-recorded",
);

/** Write options carrying {@link RESERVED_SIBLING_WRITE_RECORDED}. */
export interface ReservedSiblingWriteRecorded {
  readonly [RESERVED_SIBLING_WRITE_RECORDED]: true;
}

/**
 * The options the chokepoint forwards a write with: `options` with
 * {@link RESERVED_SIBLING_WRITE_RECORDED} added.
 */
export function reservedSiblingWriteRecordedMark(
  options?: IWriteOptions,
): IWriteOptions & ReservedSiblingWriteRecorded {
  return options === undefined
    ? RECORDED_ONLY
    : { ...options, [RESERVED_SIBLING_WRITE_RECORDED]: true };
}

/** Whether write options carry {@link RESERVED_SIBLING_WRITE_RECORDED}. */
export function reservedSiblingWriteRecorded(options: unknown): boolean {
  return isObjectNotArray(options) &&
    (options as Partial<ReservedSiblingWriteRecorded>)[
        RESERVED_SIBLING_WRITE_RECORDED
      ] === true;
}

/**
 * Whether a value at a reserved sibling leaves the document carrying that
 * sibling, as the sibling's own reader accounts for it.
 *
 * `cfc` has such a reader, and `cfcMetadataPresent` is its account: `null` and
 * the scalars are values a document reads as carrying no label map, and any
 * record is a map. Nothing interprets `source`, so definedness is the whole
 * account there,
 * which is how the meta seam reads its own fields.
 */
function reservedSiblingPresent(
  sibling: ReservedSibling,
  value: unknown,
): boolean {
  return sibling === "cfc" ? cfcMetadataPresent(value) : value !== undefined;
}

/**
 * Whether a written reserved sibling is the stored one carried forward.
 *
 * What a whole-document write owes a reserved sibling is the value the
 * document already holds, which is what reading the stored envelope and
 * spreading it produces. An envelope assembled some other way is one the
 * writer composed rather than carried, and it changes the sibling whether or
 * not the labels it names work out the same. Holding the rule at the value
 * keeps one answer across every spelling a stored envelope takes: a version-1
 * envelope carrying its labels, a version-2 one naming the large ones by
 * content hash and holding the small ones inline, and a version the build
 * does not read at all.
 */
function reservedSiblingCarriedForward(
  carried: unknown,
  stored: unknown,
): boolean {
  // `valueEqual` refuses a function, which is not a `FabricValue`. Such a
  // value is not what the document holds, so it changes the sibling, and the
  // storage layer reports it as the error it is.
  return typeof carried !== "function" &&
    valueEqual(carried as FabricValue, stored as FabricValue);
}

/** No reserved sibling changes, which is what nearly every write makes. */
const NO_RESERVED_SIBLING_CHANGES: readonly (readonly [
  ReservedSibling,
  ReservedSiblingChange,
])[] = Object.freeze([]);

/** The mark alone, for a write that carries no other options. */
const RECORDED_ONLY: ReservedSiblingWriteRecorded = Object.freeze(
  {
    [RESERVED_SIBLING_WRITE_RECORDED]: true,
  } as const,
);
