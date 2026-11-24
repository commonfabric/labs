// The effect-completion marker (server-execution v2 stage G,
// serving-loop.md §4): the writeback transactions of the effectful
// builtins — `fetch*`, `generate*`, `sqlite*` result/claim/error writes
// — are the COMPLETION side of a served effect. Under the serving
// posture they must NOT seal into a wave (§4: the completion commit
// "never passes through §3d's sealing — the run is long over when the
// response arrives"); they commit as their OWN derived-class commit,
// with identity annotations sourced from the outbox carriage captured
// at the ORIGINAL run's seal, and their result-cell dirtiness injected
// in-process post-commit.
//
// The builtins mark each writeback transaction with the effect's id
// (`${kind}:${inputHash}` — the memo/outbox-dedupe key). The marker is
// code-authored only (builtin implementations), carried on a WeakMap —
// exactly the stampWaveRunContext pattern one module over:
//
// - OFF arm, and ON-arm client speculation: no seal destination is
//   installed, the marker is never read, and the authoritative-writes
//   mark below is gated off by the same absence — the writeback commits
//   to the store exactly as today: byte-identical behavior, one WeakMap
//   write of overhead.
// - ON-arm serving: the SpaceServer's seal dispatcher routes a marked
//   transaction to the effect-completion committer instead of the wave
//   (space-server.ts). An UNMARKED builtin writeback keeps stage F's
//   posture — refused at the seal as unstamped (§3d's ruling), loudly —
//   so a missed marking surfaces as an error, never as silent
//   mis-classification. Marked transactions additionally commit their
//   writes AUTHORITATIVELY (markAuthoritativeWrites): the no-op elision
//   diffs against the replica's optimistic view, and under the serving
//   posture that view can layer a DOOMED sealed overlay (a derivation
//   write a later wave-commit supersede-drops, §3d) — eliding the
//   completion's `inputHash`/`pending` writes against it durably lands
//   `result present + inputHash stale`, which the next run's memo guard
//   reads as "inputs changed" and destroys the just-served value (the
//   completion-visibility wedge, F2).

import {
  resolveScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";

import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { Cell } from "../cell.ts";

const effectCompletionKeys = new WeakMap<object, string>();

/**
 * The per-target effect key: `<builtin>:<inputHash>` widened by the
 * requesting node's result-cell identity (entity id + scope). With an
 * explicit identity, the scope resolves to its user or session instance. This is
 * the OUTBOX in-flight/dedupe key and the completion-routing key — the
 * `idempotencyKey` the builtins enqueue with, and the key every
 * `markEffectCompletion` of that request must use.
 *
 * Why the target rides in the key (the stage-G round-2 headline): two
 * DISTINCT recipe nodes can issue byte-identical inputs, colliding on
 * `<kind>:<inputHash>` alone. Each node's effect closure writes only
 * ITS OWN pending/result/error cells, so in-flight dedupe across nodes
 * dropped the second closure and its cells stayed pending forever —
 * the "one completion serves both result cells" assumption was false
 * (the cells are per-node; no shared result store exists). Scoping the
 * key by the result-cell identity keeps §4's in-flight dedupe where it
 * is sound — re-admits of the SAME node (wave re-runs, stale-snapshot
 * re-admits, crash re-misses), the production storm the B-1 barrier
 * bounds — while distinct nodes each run their own effect. N nodes
 * with identical inputs cost N egresses, exactly the OFF arm's
 * behavior (its claim mutex lives on per-node cells too; nothing ever
 * deduped across nodes). The deviation from serving-loop.md §4's "one
 * outstanding effect per key per space" AS WRITTEN is flagged in the
 * stage-G round-2 report: §4's own miss rule carries ONE result-cell
 * address per entry, so the sentence was already inconsistent with
 * itself for the multi-node case.
 *
 * The CFC sink-request `effectId` deliberately stays the UNSCOPED
 * `<kind>:<inputHash>` — policy-input strings are request-identity
 * vocabulary, unchanged by this fix.
 */
export function effectTargetKey(
  base: string,
  targetCell: Cell<unknown>,
  identity?: ScopeKeyIdentity,
): string {
  const link = targetCell.getAsNormalizedFullLink();
  const scope = link.scope !== undefined && link.scope !== "space"
    ? `:${
      identity === undefined
        ? String(link.scope)
        : resolveScopeKey(link.scope, identity)
    }`
    : "";
  return `${base}@${link.id}${scope}`;
}

/**
 * Mark a writeback transaction as the completion of the served effect
 * `effectKey` (the builtin's outbox key — {@link effectTargetKey} of
 * the memo id, e.g. `fetchJson:<hash>@<result-cell id>`). Call it
 * FIRST inside the writeback's transaction callback, before any
 * writes — the marker must be present when the transaction closes, and
 * the authoritative-writes mode must cover every write the callback
 * makes.
 *
 * The marker is keyed on the INNER storage transaction (`tx.tx`), not
 * the extended wrapper: `TransactionWrapper`s share the inner tx with
 * what they wrap, so a completion marked through a wrapper still
 * routes when the seal destination reads the key off the transaction
 * that actually commits (round-2 thread 18 — a wrapper-marked
 * completion previously lost both the marker and, via the wrapper's
 * missing forward, the authoritative mode).
 */
export function markEffectCompletion(
  tx: IExtendedStorageTransaction,
  effectKey: string,
): void {
  effectCompletionKeys.set(tx.tx, effectKey);
  // Completion writebacks are authoritative (F2): under the serving
  // posture (seal destination configured — the gate lives in
  // ExtendedStorageTransaction) their writes commit even where the
  // optimistic view says they are no-ops. Everywhere else this is a
  // no-op, preserving the byte-identical OFF-arm contract above.
  tx.markAuthoritativeWrites?.();
}

export function effectCompletionKeyOf(
  tx: IExtendedStorageTransaction,
): string | undefined {
  return effectCompletionKeys.get(tx.tx);
}
