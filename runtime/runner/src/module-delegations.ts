/**
 * The writer-authority delegations a runtime learns as module closures load,
 * and the one transitive snapshot of them every transaction is handed. The
 * registry keeps the direct relation and publishes its closure once per
 * change, so handing a transaction the snapshot costs a reference, not a
 * walk. Registration and lookup only: which closures may register is decided
 * where they are loaded.
 */

import type { MemorySpace } from "@commonfabric/memory/interface";
import { utf8Compare } from "@commonfabric/utils/utf8";

/**
 * Attesting space → successor module identity → every predecessor identity
 * whose writer authority it inherits, directly or through a chain, sorted.
 * A published snapshot is never mutated, so holding one by reference pins
 * it: a later registration publishes a new one and leaves this one as it
 * was. An identity is never among its own predecessors, however the direct
 * relation is shaped.
 */
export type ModuleDelegationSnapshot = ReadonlyMap<
  MemorySpace,
  ReadonlyMap<string, readonly string[]>
>;

/** The direct relation as a caller states it: successor → predecessors. */
export type ModuleDelegationInput = ReadonlyMap<string, ReadonlySet<string>>;

/** Sizes of a registry, for the diagnostics read. */
export type ModuleDelegationSizes = {
  /** Attesting spaces with at least one delegation. */
  spaces: number;

  /** Successor identities across every space. */
  identities: number;

  /** Direct predecessor entries across every identity. */
  predecessors: number;

  /**
   * Transitive snapshots built since the registry was created: one for each
   * registration that added a delegation, and one for each transaction that
   * layered a source update's proposal. Cumulative, so two readings apart
   * tell whether snapshots are being built per transaction.
   */
  snapshotBuilds: number;
};

type DirectDelegations = Map<string, Set<string>>;

/** Whether `predecessor` is an identity `identity` may inherit from. */
function admissiblePredecessor(
  identity: string,
  predecessor: unknown,
): boolean {
  return typeof predecessor === "string" && predecessor.length > 0 &&
    predecessor !== identity;
}

/**
 * Merges `delegations` into `target`, skipping an entry with an empty
 * identity or predecessor and a predecessor that is the identity itself, and
 * returns how many identities and predecessor entries were new.
 */
function mergeDelegations(
  target: DirectDelegations,
  delegations: ModuleDelegationInput,
): { identities: number; predecessors: number } {
  const added = { identities: 0, predecessors: 0 };
  for (const [identity, predecessors] of delegations) {
    if (typeof identity !== "string" || identity.length === 0) continue;
    let merged = target.get(identity);
    for (const predecessor of predecessors) {
      if (!admissiblePredecessor(identity, predecessor)) continue;
      if (merged?.has(predecessor)) continue;
      if (merged === undefined) {
        merged = new Set();
        target.set(identity, merged);
        added.identities += 1;
      }
      merged.add(predecessor);
      added.predecessors += 1;
    }
  }
  return added;
}

/**
 * Returns the transitive closure of `direct`: for each successor, every
 * identity reachable through predecessors, itself excepted, sorted so the
 * list is canonical whatever order the registrations arrived in.
 */
function transitiveDelegations(
  direct: DirectDelegations,
): ReadonlyMap<string, readonly string[]> {
  const closure = new Map<string, readonly string[]>();
  for (const [identity, predecessors] of direct) {
    const inherited = new Set<string>();
    const pending = [...predecessors];
    while (pending.length > 0) {
      const predecessor = pending.pop()!;
      if (predecessor === identity || inherited.has(predecessor)) continue;
      inherited.add(predecessor);
      for (const ancestor of direct.get(predecessor) ?? []) {
        pending.push(ancestor);
      }
    }
    if (inherited.size > 0) {
      closure.set(identity, [...inherited].sort(utf8Compare));
    }
  }
  return closure;
}

/**
 * Attesting space → successor module identity → direct predecessor
 * identities whose writer authority it inherits, together with the published
 * transitive snapshot of the whole. A transaction receives the snapshot at
 * creation, so an in-flight authorization decision cannot change when another
 * module loads, and authorization in one space can never borrow another
 * space's delegation metadata: a space's closure is computed from that
 * space's entries alone. Entries come only from verified source closures or
 * integrity-valid compiled closures in that same space, which is the caller's
 * obligation.
 */
export class ModuleDelegationRegistry {
  readonly #direct = new Map<MemorySpace, DirectDelegations>();
  #snapshot: ModuleDelegationSnapshot = new Map();
  #identities = 0;
  #predecessors = 0;
  #snapshotBuilds = 0;

  /**
   * The published snapshot: the transitive closure of everything registered
   * so far. The same object until a registration adds a delegation, after
   * which it is a new one; only the spaces that changed are rebuilt, and the
   * others' entries are shared between the old snapshot and the new.
   */
  get snapshot(): ModuleDelegationSnapshot {
    return this.#snapshot;
  }

  /**
   * Records that, in `space`, each successor in `delegations` inherits the
   * writer authority of its predecessors. An entry already registered, an
   * empty identity or predecessor, and a predecessor that is the identity
   * itself add nothing. A registration that adds nothing leaves the
   * published snapshot as it was.
   */
  register(space: MemorySpace, delegations: ModuleDelegationInput): void {
    if (typeof space !== "string" || space.length === 0) return;
    const direct = this.#direct.get(space) ?? new Map();
    const added = mergeDelegations(direct, delegations);
    if (added.predecessors === 0) return;
    this.#direct.set(space, direct);
    this.#identities += added.identities;
    this.#predecessors += added.predecessors;
    this.#snapshot = this.#snapshotReplacing(
      space,
      transitiveDelegations(direct),
    );
  }

  /**
   * Whether the delegations registered for `space` let `identity` exercise
   * the writer authority of `predecessor`, directly or through a chain of
   * predecessors: the relation the published snapshot carries. `false` when
   * `predecessor` is `identity` itself, whose own authority is not a
   * delegation.
   */
  grants(space: MemorySpace, identity: string, predecessor: string): boolean {
    return this.#snapshot.get(space)?.get(identity)?.includes(predecessor) ===
      true;
  }

  /**
   * Returns the published snapshot with `delegations` layered over `space`'s
   * registered entries, for a transaction that stages a source update and
   * authorizes the successor's writes before the update commits. The
   * published snapshot is untouched, and every other space's entries are
   * shared with it. Returns the published snapshot itself when the layer
   * adds nothing.
   */
  snapshotWith(
    space: MemorySpace,
    delegations: ModuleDelegationInput,
  ): ModuleDelegationSnapshot {
    if (typeof space !== "string" || space.length === 0) return this.#snapshot;
    const combined: DirectDelegations = new Map();
    for (const [identity, predecessors] of this.#direct.get(space) ?? []) {
      combined.set(identity, new Set(predecessors));
    }
    const added = mergeDelegations(combined, delegations);
    if (added.predecessors === 0) return this.#snapshot;
    return this.#snapshotReplacing(space, transitiveDelegations(combined));
  }

  /** The registry's sizes, each read from a counter the registry keeps. */
  getSizes(): ModuleDelegationSizes {
    return {
      spaces: this.#direct.size,
      identities: this.#identities,
      predecessors: this.#predecessors,
      snapshotBuilds: this.#snapshotBuilds,
    };
  }

  /**
   * Helper for `register()` and `snapshotWith()`, which builds a snapshot
   * holding `closure` for `space` and the published snapshot's entries for
   * every other space.
   */
  #snapshotReplacing(
    space: MemorySpace,
    closure: ReadonlyMap<string, readonly string[]>,
  ): ModuleDelegationSnapshot {
    this.#snapshotBuilds += 1;
    const snapshot = new Map(this.#snapshot);
    snapshot.set(space, closure);
    return snapshot;
  }
}
