import type { FabricValue } from "@commonfabric/api";
import { valueEqual } from "@commonfabric/data-model";
import type { PatchOp } from "@commonfabric/memory/v2";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { encodePointer, isPrefixPath } from "../../../memory/v2/path.ts";

/**
 * The mergeable patch operations: the {@link PatchOp} kinds an author invokes
 * directly (`Cell.push` / `addUnique` / `increment` / `removeByValue`) and that
 * the commit carries as recorded intent — resolved by the durable store against
 * live state — instead of a whole-value diff against a possibly-stale read. This
 * is what lets two handlers editing one collection concurrently merge rather
 * than clobber.
 *
 * This module is the single definition of that per-op behavior for the runner /
 * commit side. Each op appears exactly once in {@link mergeableOpDescriptors},
 * which owns how repeated calls fold into one intent ({@link foldMergeableIntent})
 * and how an intent becomes wire ops plus the diff-suppression it implies
 * ({@link buildMergeableIntent}). The wire-level half of an op (its shape, how it
 * applies to a document, which paths it touches for conflict detection) lives in
 * the wire-op registry in `@commonfabric/memory/v2/patch` — the two are joined by
 * the shared op tag.
 */
export type MergeableWireOp =
  | "append"
  | "add-unique"
  | "increment"
  | "remove-by-value";

/**
 * One Cell mutation's contribution to a mergeable op at a path. `append` /
 * `add-unique` carry the count of elements added at the tail (their values are
 * read back from the working array at commit); `increment` carries the delta;
 * each `remove-by-value` carries one removed element.
 */
export type MergeableOpDelta =
  | { op: "append" | "add-unique"; count: number }
  | { op: "increment"; by: number }
  | { op: "remove-by-value"; value: FabricValue };

/**
 * The accumulated intent for one document path: the deltas of a single op folded
 * together across the transaction (see {@link foldMergeableIntent}). Recording a
 * different op at the same path replaces the intent rather than folding.
 */
export type MergeableOpIntent =
  | { op: "append" | "add-unique"; path: readonly string[]; count: number }
  | { op: "increment"; path: readonly string[]; by: number }
  | { op: "remove-by-value"; path: readonly string[]; values: FabricValue[] };

/**
 * A document path covered by a mergeable op, used to suppress the whole-value
 * diff candidates the op replaces. `tailStart` (the array ops) is the first
 * covered index; `subtree` (a remove-by-value) suppresses the array path and
 * everything under it; with neither only the exact path is suppressed (the
 * scalar an `increment` replaces).
 */
export type OpSuppression = {
  path: readonly string[];
  tailStart?: number;
  subtree?: boolean;
};

/**
 * The working / initial state a mergeable op needs to turn its intent into wire
 * ops. `workingArray` is the transaction's post-write array at the op's path (or
 * undefined when the path does not hold an array); `hadInitialArray` is whether
 * the transaction's initial snapshot already had an array there — with no base,
 * the whole working array is the payload, so a stale-empty base does not drop
 * locally created prefix elements. `hadInitialValue` is whether the base held
 * ANY value at the path: when false the op materializes a previously-absent
 * path, so it stamps the wire op's `createsKey` flag (the parent's key set
 * changed — see the field in `@commonfabric/memory/v2`).
 * `initialArray` is that base array itself (undefined when there was no base
 * array), which a tail op checks its recorded tail against — length and hole
 * layout both, since the diff it suppresses can only express a prefix that
 * matches the base in both.
 */
export interface MergeableBuildContext {
  readonly workingArray?: readonly FabricValue[];
  readonly hadInitialArray: boolean;
  readonly hadInitialValue: boolean;
  readonly initialArray?: readonly FabricValue[];
}

/**
 * `abandon` says the intent produced no wire op and must be dropped from the
 * transaction entirely, not merely left un-emitted: a live intent still narrows
 * reads out of the commit's conflict set on behalf of an op that is no longer
 * being sent, and the whole-value diff replacing it is entitled to those reads.
 *
 * The op's own read of the value is among those reads, and it can be the only
 * one, since nothing makes a reshape obliged to read what it overwrites. With
 * the intent dropped that read is back in the conflict set, which is what
 * refuses the replacing write from a session whose view of the value is stale.
 */
export interface MergeableBuildResult {
  ops: PatchOp[];
  suppress: OpSuppression[];
  abandon?: boolean;
}

// The single definition of one mergeable op's runtime behavior. Every question
// the commit path asks about a mergeable op is answered from here, so
// foldMergeableIntent / isNoopMergeableDelta / buildMergeableIntent never
// enumerate the ops — they index this table by the op tag and defer:
//
// - `isNoopDelta` — a delta that records nothing and is dropped before the write
//   target is even resolved (an empty tail op). Absent means "always record".
// - `fold` — how a delta combines into the path's accumulated intent.
// - `build` — how an accumulated intent becomes wire ops and diff-suppression,
//   or is abandoned in favor of the plain diff (see `abandon` above).
// - `payloadContains` — whether a path lies inside the live values this op sends
//   (see {@link mergeableOpPayloadContains}). Absent means "carries no live
//   subtree", which is the answer for every op but the tail ops.
interface MergeableOpDescriptor<
  Intent extends MergeableOpIntent = MergeableOpIntent,
  Delta extends MergeableOpDelta = MergeableOpDelta,
> {
  readonly op: Intent["op"];
  readonly isNoopDelta?: (delta: Delta) => boolean;
  readonly fold: (
    existing: MergeableOpIntent | undefined,
    path: readonly string[],
    delta: Delta,
  ) => Intent;
  readonly build: (
    intent: Intent,
    ctx: MergeableBuildContext,
  ) => MergeableBuildResult;
  readonly payloadContains?: (
    intent: Intent,
    ctx: MergeableBuildContext,
    path: readonly string[],
  ) => boolean;
}

const descriptor = <
  Intent extends MergeableOpIntent,
  Delta extends MergeableOpDelta,
>(
  d: MergeableOpDescriptor<Intent, Delta>,
): MergeableOpDescriptor => d as unknown as MergeableOpDescriptor;

type AppendIntent = Extract<MergeableOpIntent, { op: "append" | "add-unique" }>;
type AppendDelta = Extract<MergeableOpDelta, { op: "append" | "add-unique" }>;

// A tail op (append / add-unique) folds by summing the appended count; a delta of
// nothing records nothing.
const isNoopTailDelta = (delta: AppendDelta): boolean => delta.count <= 0;

const foldTail = (
  existing: MergeableOpIntent | undefined,
  path: readonly string[],
  delta: AppendDelta,
): AppendIntent => ({
  op: delta.op,
  path,
  count: (existing?.op === delta.op ? existing.count : 0) + delta.count,
});

// The first index of the array a tail op sends: its recorded tail, or the whole
// working array when there was no base to diff against.
const tailOpStart = (
  intent: AppendIntent,
  array: readonly FabricValue[],
  ctx: MergeableBuildContext,
): number => ctx.hadInitialArray ? Math.max(0, array.length - intent.count) : 0;

// A tail op's payload is `array.slice(start)` — live values lifted out of the
// working document — so it carries every path at or past `start`, at any depth
// beneath it.
const tailOpPayloadContains = (
  intent: AppendIntent,
  ctx: MergeableBuildContext,
  path: readonly string[],
): boolean => {
  const array = ctx.workingArray;
  if (
    !array || path.length <= intent.path.length ||
    !isPrefixPath(intent.path, path)
  ) {
    return false;
  }
  const index = path[intent.path.length];
  return index !== undefined && isArrayIndexPropertyName(index) &&
    Number(index) >= tailOpStart(intent, array, ctx);
};

// A tail op emits its recorded tail slice (or the whole working array when there
// was no base to diff against) and suppresses the whole-array / appended-element
// diff candidates the op replaces, while leaving edits to existing elements
// (index < start) to the diff.
const buildTailOp = (
  intent: AppendIntent,
  ctx: MergeableBuildContext,
): MergeableBuildResult => {
  const array = ctx.workingArray;
  if (!array) {
    return { ops: [], suppress: [], abandon: true };
  }
  const start = tailOpStart(intent, array, ctx);
  // The op says "add these elements to whatever the durable array is", and its
  // suppression drops the whole-array candidate at this path outright plus every
  // element candidate at or past `start`. What survives to carry the prefix is
  // therefore only the diff's PER-INDEX candidates — so the op is honest only
  // while the diff actually decomposes the prefix that way. `buildArrayPatchCandidates`
  // gives up and emits a whole-array replacement instead in exactly three
  // situations, and each one must abandon the op rather than let that
  // replacement be suppressed:
  //
  //   1. the prefix changed length (a write here or at a parent that shrank or
  //      grew it) — the base elements it removed have no surviving removal
  //      candidate, so the store keeps them and appends on top: a doubled list;
  //   2. the prefix's HOLE LAYOUT changed — punching or filling a hole without
  //      changing the length, which the diff cannot express per index;
  //   3. the appended tail is itself sparse.
  //
  // In each case the local value is the whole-array diff's to commit, not the
  // op's. (Case 1 is checked as `initial.length !== start` because `start` is
  // where the recorded tail begins.)
  // Conditions 1 and 2 compare against a base, so they need one.
  if (ctx.hadInitialArray) {
    const initial = ctx.initialArray;
    if (!initial || initial.length !== start) {
      return { ops: [], suppress: [], abandon: true };
    }
    for (let index = 0; index < start; index += 1) {
      if ((index in initial) !== (index in array)) {
        return { ops: [], suppress: [], abandon: true };
      }
    }
  }
  // Condition 3 does not: the payload is `array.slice(start)` either way, and
  // with no base that slice is the WHOLE working array, so a hole anywhere in a
  // freshly created sparse array is a hole in the payload. The wire op cannot
  // carry one — it rebuilds the payload elementwise — so a sparse payload must
  // fall back to the diff, which does preserve holes.
  for (let index = start; index < array.length; index += 1) {
    if (!(index in array)) {
      return { ops: [], suppress: [], abandon: true };
    }
  }
  const values = array.slice(start);
  if (values.length === 0) {
    return { ops: [], suppress: [], abandon: true };
  }
  return {
    ops: [{
      op: intent.op,
      path: encodePointer(intent.path),
      values,
      ...(ctx.hadInitialValue ? {} : { createsKey: true }),
    }],
    suppress: [{ path: intent.path, tailStart: start }],
  };
};

type RemoveIntent = Extract<MergeableOpIntent, { op: "remove-by-value" }>;

// The array the store will hold once the intent's removals have been applied to
// `base`, mirroring how the wire op applies (`removeByValueAtPath` in
// `@commonfabric/memory/v2/patch`): every occurrence of each value goes, in the
// order the values were recorded.
const withRemovalsApplied = (
  base: readonly FabricValue[],
  values: readonly FabricValue[],
): FabricValue[] => {
  const result = base.slice();
  for (const value of values) {
    for (let index = result.length - 1; index >= 0; index -= 1) {
      if (valueEqual(result[index], value)) {
        result.splice(index, 1);
      }
    }
  }
  return result;
};

// A remove-by-value rebuilds the array's membership by value, so it suppresses
// the whole subtree the local removal produced (a positional splice/shrink)
// rather than a tail slice. Nothing at or under the array path survives that, so
// the op is the commit's ONLY carrier for this array — a stronger claim than a
// tail op's, which leaves the prefix's per-index candidates alive. It may make
// that claim only when it fully explains the local value: the working array has
// to be exactly the base with the removed values taken out.
//
// Anything else the transaction changed on the same array — an element edit, a
// whole-value write at this path or at a parent — otherwise loses the candidate
// that would have carried it and is silently discarded, while the writing
// session's own value shows the change. Neither shape is always caught
// earlier: an element edit writes BENEATH the array and so deliberately does
// not poison the intent, and a whole-value write made straight to the
// transaction poisons nothing. When the check fails, abandon the intent and
// let the whole-array diff commit the local value.
const buildRemoveByValue = (
  intent: RemoveIntent,
  ctx: MergeableBuildContext,
): MergeableBuildResult => {
  const array = ctx.workingArray;
  const base = ctx.initialArray;
  // With no base array the transaction materialized the array itself, so there
  // is nothing to check the removals against — and the subtree suppression would
  // drop the creation whole, writing nothing at all.
  if (!array || !ctx.hadInitialArray || !base) {
    return { ops: [], suppress: [], abandon: true };
  }
  // `valueEqual` compares arrays by canonical content hash, so this also holds
  // the op to the base's hole layout rather than flattening it away.
  if (!valueEqual(withRemovalsApplied(base, intent.values), array)) {
    return { ops: [], suppress: [], abandon: true };
  }
  return {
    ops: intent.values.map((value) => ({
      op: "remove-by-value",
      path: encodePointer(intent.path),
      value,
    })),
    suppress: [{ path: intent.path, subtree: true }],
  };
};

const mergeableOpDescriptors: Record<MergeableWireOp, MergeableOpDescriptor> = {
  append: descriptor<AppendIntent, AppendDelta>({
    op: "append",
    isNoopDelta: isNoopTailDelta,
    fold: foldTail,
    build: buildTailOp,
    payloadContains: tailOpPayloadContains,
  }),
  "add-unique": descriptor<AppendIntent, AppendDelta>({
    op: "add-unique",
    isNoopDelta: isNoopTailDelta,
    fold: foldTail,
    build: buildTailOp,
    payloadContains: tailOpPayloadContains,
  }),
  increment: descriptor<
    Extract<MergeableOpIntent, { op: "increment" }>,
    Extract<MergeableOpDelta, { op: "increment" }>
  >({
    op: "increment",
    fold: (existing, path, delta) => ({
      op: "increment",
      path,
      by: (existing?.op === "increment" ? existing.by : 0) + delta.by,
    }),
    // Increments that summed to zero (a +1 and a -1) are a no-op: the working
    // value already reflects no change, so emit nothing (and nothing to
    // suppress). Deliberately NOT abandoned: with the value unchanged the diff
    // has no candidate at this path either, so there is no replacement write
    // whose reads need restoring — abandoning would only put the op's own read
    // back into the conflict set and make a net-zero increment false-conflict
    // with a concurrent one.
    build: (intent, ctx) =>
      intent.by === 0 ? { ops: [], suppress: [] } : {
        ops: [
          {
            op: "increment",
            path: encodePointer(intent.path),
            by: intent.by,
            ...(ctx.hadInitialValue ? {} : { createsKey: true }),
          },
        ],
        suppress: [{ path: intent.path }],
      },
  }),
  "remove-by-value": descriptor<
    Extract<MergeableOpIntent, { op: "remove-by-value" }>,
    Extract<MergeableOpDelta, { op: "remove-by-value" }>
  >({
    op: "remove-by-value",
    fold: (existing, path, delta) => ({
      op: "remove-by-value",
      path,
      values: [
        ...(existing?.op === "remove-by-value" ? existing.values : []),
        delta.value,
      ],
    }),
    build: buildRemoveByValue,
  }),
};

/**
 * Whether a delta records nothing and can be dropped before the write target is
 * resolved (an empty tail op). Defers to the op's descriptor.
 */
export const isNoopMergeableDelta = (delta: MergeableOpDelta): boolean =>
  mergeableOpDescriptors[delta.op].isNoopDelta?.(delta) ?? false;

/**
 * Folds one recorded {@link MergeableOpDelta} into the path's existing intent:
 * the same op combines (counts and increments sum, removed values accumulate); a
 * different op replaces the intent, so the last op kind recorded at a path wins.
 * Defers to the op's descriptor.
 */
export const foldMergeableIntent = (
  existing: MergeableOpIntent | undefined,
  path: readonly string[],
  delta: MergeableOpDelta,
): MergeableOpIntent =>
  mergeableOpDescriptors[delta.op].fold(existing, path, delta);

/**
 * Whether the op `intent` would build under `ctx` carries `path` inside its own
 * payload — i.e. whether it already sends the value living there.
 *
 * Only the tail ops carry live values lifted out of the working document: their
 * payload is `array.slice(tailStart)`, so it holds whatever those elements
 * contain, however deep. An `increment` sends a number and a `remove-by-value`
 * sends the element it removes, neither of which contains another intent's
 * target, so both return `false`.
 *
 * This is what makes two intents on one document mutually exclusive. An intent
 * inside another op's payload has ALREADY had its change applied by that op — the
 * payload is read from the working array at commit, after both writes — so
 * sending it as its own op applies it a second time. The caller abandons the
 * contained intent (see `buildMergeableOps`); the containing op carries the
 * combined value, and its suppression covers the diff candidates the abandoned
 * intent leaves behind.
 *
 * Containment is strict: an intent never contains itself.
 */
export const mergeableOpPayloadContains = (
  intent: MergeableOpIntent,
  ctx: MergeableBuildContext,
  path: readonly string[],
): boolean =>
  mergeableOpDescriptors[intent.op].payloadContains?.(intent, ctx, path) ??
    false;

/**
 * Turns one accumulated intent into the wire ops the commit sends and the
 * diff-suppression they imply.
 */
export const buildMergeableIntent = (
  intent: MergeableOpIntent,
  ctx: MergeableBuildContext,
): MergeableBuildResult => mergeableOpDescriptors[intent.op].build(intent, ctx);

/** The wire-op tags this registry knows how to record and build. */
export const MERGEABLE_WIRE_OPS: readonly MergeableWireOp[] = Object.keys(
  mergeableOpDescriptors,
) as MergeableWireOp[];
