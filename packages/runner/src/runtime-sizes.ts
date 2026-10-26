/**
 * Sizes of the structures a runtime holds live, for the diagnostics read that
 * tells which tracked collection kept growing while a heap did, and which
 * spaces and channels carry what it holds. Most figures are a collection's
 * own count and cost nothing to read. The per-space views cost one bounded
 * pass each: over the open spaces, over the snapshot table, and over the
 * documents a node budget admits, as `DocumentSizeEstimate` says. So a read
 * is safe at any moment, including one where the runtime is already
 * struggling. A heap that grows through larger entries than the document
 * estimate sees, or through a structure not counted here, leaves every
 * figure where it was.
 */

import type { ModuleDelegationSizes } from "./module-delegations.ts";
import type { SchedulerSizes } from "./scheduler/types.ts";
import type { StorageSizes } from "./storage/diagnostics.ts";

/** Sizes of the pattern manager's in-memory compiled-code caches. */
export type PatternManagerSizes = {
  /** Compiled programs held by content identity. */
  compiledPrograms: number;

  /** Module namespaces held by content identity. */
  evaluatedModules: number;

  /** Module identities whose builder artifacts are indexed for lookup. */
  indexedModules: number;

  /** Compilations in flight. */
  inProgressCompilations: number;
};

/** Sizes of the structures the runtime itself holds. */
export type RuntimeOwnSizes = {
  /**
   * Distinct snapshots retained by any immutable cell store in the process,
   * element stores included.
   */
  immutableSnapshots: number;

  /** Asynchronous builtin work not yet settled. */
  pendingAsyncWork: number;

  /**
   * `editWithRetry()` calls whose commit was rejected and that are waiting to
   * attempt again. A re-run after absence reconciliation is not one.
   */
  retryingEdits: number;

  /** Modules registered by reference. */
  modules: number;

  /** CFC policy manifests resolved and held. */
  policyManifests: number;

  /**
   * The writer-authority delegations learned from loaded module closures,
   * and how often their transitive snapshot has been built.
   */
  moduleDelegations: ModuleDelegationSizes;

  /**
   * `immutableSnapshots` by the space of the stored document each snapshot
   * was read out of, the spaces holding the most first and at most
   * {@link SIZES_BY_KEY_LIMIT} of them; the rest count under `(other)`, and
   * snapshots read out of no stored document under `(none)`.
   */
  immutableSnapshotsBySpace: Record<string, number>;
};

/** What `Runtime.getSizes()` reports. */
export type RuntimeSizes = {
  scheduler: SchedulerSizes;

  /** Null when the storage manager reports no sizes. */
  storage: StorageSizes | null;

  patterns: PatternManagerSizes;
  runtime: RuntimeOwnSizes;

  /**
   * Commits CFC enforcement refused before they reached storage, by the
   * opening words of each reason that refused them. A commit refused for
   * several reasons counts once under each.
   */
  cfcRejectionsByReason: Record<string, number>;
};

/** How many keys a per-key view keeps before the rest share `(other)`. */
export const SIZES_BY_KEY_LIMIT = 64;

/** The key the counts past {@link SIZES_BY_KEY_LIMIT} are added under. */
export const SIZES_BY_KEY_OTHER = "(other)";

/**
 * Returns `counts` as a record of its largest {@link SIZES_BY_KEY_LIMIT}
 * entries, largest first, with every other entry added under
 * {@link SIZES_BY_KEY_OTHER}; a map within the limit comes back whole.
 */
export function boundedCounts(
  counts: ReadonlyMap<string, number>,
): Record<string, number> {
  const entries = [...counts].sort((a, b) => b[1] - a[1]);
  const bounded = Object.fromEntries(entries.slice(0, SIZES_BY_KEY_LIMIT));
  if (entries.length > SIZES_BY_KEY_LIMIT) {
    bounded[SIZES_BY_KEY_OTHER] = entries.slice(SIZES_BY_KEY_LIMIT)
      .reduce((sum, [, count]) => sum + count, 0);
  }
  return bounded;
}

/** The longest prefix a reason is tallied under. */
const CFC_REJECTION_REASON_PREFIX_LIMIT = 80;

/** How many distinct prefixes a tally holds before the rest share one key. */
export const CFC_REJECTION_REASON_LIMIT = 64;

/** The key every prefix past {@link CFC_REJECTION_REASON_LIMIT} counts under. */
export const CFC_REJECTION_REASON_OTHER = "(other)";

/** The key for a reason with no words ahead of its first identifier. */
const CFC_REJECTION_REASON_UNCLASSIFIED = "(unclassified)";

/**
 * Returns the words of a CFC refusal reason ahead of the first thing it names:
 * the rule that refused, without the document, path or sink it refused. The
 * cut falls at the first of ` for `, ` at `, a `:` detail, or a word that is
 * itself an identifier or a path (one with a `:` or `/` inside it), and a
 * connective left dangling at the end is dropped with it. `"writer-fit
 * confidentiality misfit for of:… at /"` tallies as `"writer-fit
 * confidentiality misfit"`; `"unprivileged write to protected runtime surface
 * of:…"` as `"unprivileged write to protected runtime surface"`.
 */
export function cfcRejectionReasonPrefix(reason: string): string {
  const cut = reason.search(/ (?:for|at) |:|\s\S*[:/]\S/);
  const prefix = (cut === -1 ? reason : reason.slice(0, cut))
    .trim()
    .replace(/\s+(?:for|at|to|of|into|in|on|by|from)$/, "");
  if (prefix.length === 0) return CFC_REJECTION_REASON_UNCLASSIFIED;
  return prefix.slice(0, CFC_REJECTION_REASON_PREFIX_LIMIT);
}

/**
 * Counts CFC commit refusals by reason prefix, bounded in distinct keys so a
 * reason that varies in its opening words cannot grow the tally without
 * limit.
 */
export class CfcRejectionTally {
  readonly #counts = new Map<string, number>();

  /** Counts one refusal under each of its reasons' prefixes. */
  add(reasons: readonly string[]): void {
    for (const reason of reasons) {
      let key = cfcRejectionReasonPrefix(reason);
      if (
        !this.#counts.has(key) &&
        this.#counts.size >= CFC_REJECTION_REASON_LIMIT
      ) {
        key = CFC_REJECTION_REASON_OTHER;
      }
      this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1);
    }
  }

  /** The counts so far, as a plain record. */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.#counts);
  }
}
