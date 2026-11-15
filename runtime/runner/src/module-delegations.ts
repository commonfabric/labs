/**
 * The writer-authority delegations a runtime learns as module closures load,
 * and the one transitive snapshot of them every transaction is handed. The
 * registry keeps the direct relation and publishes its closure once per
 * change, so handing a transaction the snapshot costs a reference, not a
 * walk. Registration and lookup only: which closures may register is decided
 * where they are loaded.
 */

import type { MemorySpace } from "@commonfabric/memory/interface";
import { utf8Compare } from "@commonfabric/text/utf8";

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
 * Every identity `identity` inherits from through `direct`, itself excepted.
 * The walk visits each identity once, so it ends on any relation, cycles and
 * self-edges included.
 */
export function inheritedThrough(
  direct: ModuleDelegationInput,
  identity: string,
): Set<string> {
  const inherited = new Set<string>();
  const pending = [...(direct.get(identity) ?? [])];
  while (pending.length > 0) {
    const predecessor = pending.pop()!;
    if (predecessor === identity || inherited.has(predecessor)) continue;
    inherited.add(predecessor);
    for (const ancestor of direct.get(predecessor) ?? []) {
      pending.push(ancestor);
    }
  }
  return inherited;
}

/**
 * A piece's recorded delegation edges: successor → predecessor → the history
 * positions at which a transition recorded that edge, ascending, each once.
 */
export type StampedEdges = ReadonlyMap<
  string,
  ReadonlyMap<string, readonly number[]>
>;

/** The largest of `stamps`, ascending, that is at most `bound`, if any. */
function latestStampWithin(
  stamps: readonly number[],
  bound: number,
): number | undefined {
  let low = 0;
  let high = stamps.length - 1;
  let found: number | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (stamps[middle] <= bound) {
      found = stamps[middle];
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/**
 * Every identity `identity` inherits from over `edges` along a path whose
 * stamps do not increase: an edge recorded at position p is followed only
 * by edges recorded at or before p, so a module takes what its predecessor
 * held when the module was granted it, and nothing the predecessor was granted
 * later. Itself excepted.
 *
 * The walk takes the identity it can reach with the largest bound first, so
 * it expands each identity once, with the largest bound any path gives it:
 * its cost is linear in the edges and their stamps, times a logarithm,
 * whatever the stamps are, and it ends on any relation, cycles included.
 */
export function inheritedAlongStamps(
  edges: StampedEdges,
  identity: string,
): Set<string> {
  const reached = new Set<string>();
  const expanded = new Set<string>();
  // A binary max-heap of [identity, bound].
  const heap: [string, number][] = [[identity, Infinity]];
  const push = (entry: [string, number]) => {
    heap.push(entry);
    let child = heap.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (heap[parent][1] >= heap[child][1]) break;
      [heap[parent], heap[child]] = [heap[child], heap[parent]];
      child = parent;
    }
  };
  const pop = (): [string, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let parent = 0;
      for (;;) {
        const left = 2 * parent + 1;
        const right = left + 1;
        let largest = parent;
        if (left < heap.length && heap[left][1] > heap[largest][1]) {
          largest = left;
        }
        if (right < heap.length && heap[right][1] > heap[largest][1]) {
          largest = right;
        }
        if (largest === parent) break;
        [heap[parent], heap[largest]] = [heap[largest], heap[parent]];
        parent = largest;
      }
    }
    return top;
  };
  while (heap.length > 0) {
    const [node, bound] = pop();
    if (expanded.has(node)) continue;
    expanded.add(node);
    for (const [predecessor, stamps] of edges.get(node) ?? []) {
      const stamp = latestStampWithin(stamps, bound);
      if (stamp === undefined) continue;
      if (predecessor !== identity) reached.add(predecessor);
      if (!expanded.has(predecessor)) push([predecessor, stamp]);
    }
  }
  return reached;
}

/**
 * The closed delegations of each of `identities` over `edges`
 * ({@link inheritedAlongStamps}), for each that inherits any.
 */
export function closeDelegationsFor(
  edges: StampedEdges,
  identities: Iterable<string>,
): Map<string, ReadonlySet<string>> {
  const closed = new Map<string, ReadonlySet<string>>();
  for (const identity of identities) {
    const inherited = inheritedAlongStamps(edges, identity);
    if (inherited.size > 0) closed.set(identity, inherited);
  }
  return closed;
}

/**
 * Records in `edges` that `identity` was granted `predecessor` at `stamp`,
 * keeping every stamp the edge was recorded at, in order. Edges and stamps are
 * only ever added, here and everywhere a piece's record is written, so what
 * any identity inherits over the edges only grows: that invariant is what the
 * record's correctness rests on.
 */
export function recordEdge(
  edges: Map<string, Map<string, number[]>>,
  identity: string,
  predecessor: string,
  stamp: number,
): void {
  if (!admissiblePredecessor(identity, predecessor)) return;
  let out = edges.get(identity);
  if (out === undefined) {
    out = new Map();
    edges.set(identity, out);
  }
  const stamps = out.get(predecessor) ?? [];
  if (!stamps.includes(stamp)) {
    stamps.push(stamp);
    stamps.sort((a, b) => a - b);
  }
  out.set(predecessor, stamps);
}

/**
 * Composes the matches an update derives from its two closures
 * (`deriveModulePredecessors()` in `cell-cache.ts`) with `recorded`, the
 * edges the piece's member records for the previous pattern and the history
 * position the update records at.
 *
 * Each successor gets an edge to the module it succeeds, stamped with
 * `recorded.position`, which is never 0. The predecessor record's attested
 * list is closed as of when it was written, and is what the successor takes
 * in now: so an entry of it the edges do not already reach from the
 * successor becomes the SUCCESSOR's edge at stamp 0. The walk follows that
 * edge from the successor and from anything that later reaches the
 * successor, and stops at the entry, since nothing is recorded at or below
 * 0: the successor gets the list as written, and nothing a listed module was
 * granted afterward, and no module that succeeded the predecessor earlier
 * sees the list at all, as its own record froze the list at its own time.
 * The list being closed, every module a listed module inherited when it was
 * written is itself listed, so stopping loses nothing. Each module of
 * `candidate` is then closed
 * over the result along non-increasing stamps (`inheritedAlongStamps()`): a
 * module the update leaves unchanged, or one that returns, is closed over its
 * own recorded edges, so no grant the piece's history made is lost, and none
 * is made that a predecessor was granted only after its successor was.
 */
export function composeRecordedEdges(
  matched: ReadonlyMap<
    string,
    { predecessor: string; inherited: readonly string[] }
  >,
  recorded: { edges: StampedEdges; position: number },
  candidate: Iterable<string>,
): {
  delegations: Map<string, ReadonlySet<string>>;
  edges: StampedEdges;
} {
  const edges = new Map<string, Map<string, number[]>>(
    [...recorded.edges].map(([identity, predecessors]) => [
      identity,
      new Map(
        [...predecessors].map(([predecessor, stamps]) => [
          predecessor,
          [...stamps],
        ]),
      ),
    ]),
  );
  for (const [identity, { predecessor }] of matched) {
    recordEdge(edges, identity, predecessor, recorded.position);
  }
  // Reached before any listed entry is added, so that what is added does not
  // depend on the order of the matches.
  const reached = new Map(
    [...matched.keys()].map((identity) => [
      identity,
      inheritedAlongStamps(edges, identity),
    ]),
  );
  for (const [identity, { inherited }] of matched) {
    for (const entry of inherited) {
      if (!reached.get(identity)!.has(entry)) {
        recordEdge(edges, identity, entry, 0);
      }
    }
  }
  return { delegations: closeDelegationsFor(edges, candidate), edges };
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
  for (const identity of direct.keys()) {
    const inherited = inheritedThrough(direct, identity);
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
 * integrity-valid compiled closures in that same space, from a source update
 * this runtime committed there, or from what a piece's
 * `pieceSourceDelegations` member records for a module of such a closure,
 * which is the caller's obligation.
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
