import { type FabricValue, valueEqual } from "@commonfabric/data-model";
import {
  arraysOverlap,
  nonRecursiveReadMayOverlapWrite,
} from "../reactive-dependencies.ts";
import { normalizeCellScope } from "../scope.ts";
import type {
  IMemorySpaceAddress,
  MemoryAddressPathComponent,
} from "../storage/interface.ts";
import type { NodeRegistry } from "./node-record.ts";
import type { Action, ReactivityLog } from "./types.ts";

export function collectTransitiveEffects(state: {
  readonly dependents: WeakMap<Action, Set<Action>>;
  readonly effects: ReadonlySet<Action>;
}, action: Action): Action[] {
  const visited = new Set<Action>();
  const effects: Action[] = [];

  const visit = (current: Action) => {
    if (visited.has(current)) return;
    visited.add(current);

    if (state.effects.has(current)) {
      effects.push(current);
    }

    const dependents = state.dependents.get(current);
    if (!dependents) return;
    for (const dependent of dependents) {
      visit(dependent);
    }
  };

  visit(action);
  return effects;
}

export function mapsEqual(
  a: Map<string, FabricValue>,
  b: Map<string, FabricValue>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, val] of a) {
    if (!b.has(key)) return false;
    if (!valueEqual(val, b.get(key))) return false;
  }
  return true;
}

export function topologicalSort(
  actions: Set<Action>,
  dependencies: WeakMap<Action, ReactivityLog>,
  mightWrite: WeakMap<Action, IMemorySpaceAddress[]>,
  nodes?: Pick<
    NodeRegistry,
    "get" | "parentActionOf" | "getRegistrationOrdinal"
  >,
  dependents?: WeakMap<Action, Set<Action>>,
  getAdditionalWrites?: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined,
): Action[] {
  const graph = new Map<Action, Set<Action>>();
  const inDegree = new Map<Action, number>();

  // Initialize graph and inDegree for relevant actions
  for (const action of actions) {
    graph.set(action, new Set());
    inDegree.set(action, 0);
  }

  // Build the graph based on read/write dependencies. The readers a writer
  // is ordered against are indexed by the document they read, built on first
  // use, so a writer's edges cost the readers of the documents it writes
  // rather than the whole set, and a pass that needs no index builds none.
  let declaredReaders: Map<string, IndexedRead[]> | undefined;
  let allReaders: Map<string, IndexedRead[]> | undefined;
  const addEdgesForWrites = (
    actionA: Action,
    writes: readonly IMemorySpaceAddress[],
    declaredOnly: boolean,
  ): void => {
    if (writes.length === 0) return;
    let readers: Map<string, IndexedRead[]>;
    if (declaredOnly) {
      declaredReaders ??= indexReaders(actions, dependencies, nodes, true);
      readers = declaredReaders;
    } else {
      allReaders ??= indexReaders(actions, dependencies, nodes, false);
      readers = allReaders;
    }
    const graphA = graph.get(actionA)!;
    for (const write of writes) {
      for (const reader of readers.get(documentKey(write)) ?? []) {
        const actionB = reader.action;
        if (actionA === actionB || graphA.has(actionB)) continue;
        const overlaps = reader.shallow
          ? nonRecursiveReadMayOverlapWrite(reader.path, write.path)
          : arraysOverlap(write.path, reader.path);
        if (!overlaps) continue;
        graphA.add(actionB);
        inDegree.set(actionB, (inDegree.get(actionB) || 0) + 1);
      }
    }
  };
  // In pull mode the data edges are maintained incrementally in
  // `dependents`, so the graph is not rebuilt from the read logs on every
  // settle iteration; a reader that has never run contributes the reads it
  // declares instead.
  if (dependents) {
    for (const actionA of actions) {
      const graphA = graph.get(actionA)!;
      const actionDependents = dependents.get(actionA);
      if (!actionDependents) continue;
      for (const actionB of actionDependents) {
        if (
          actionB === actionA || !actions.has(actionB) || graphA.has(actionB)
        ) {
          continue;
        }
        graphA.add(actionB);
        inDegree.set(actionB, (inDegree.get(actionB) || 0) + 1);
      }
    }
    if (nodes) {
      for (const actionA of actions) {
        addEdgesForWrites(actionA, mightWrite.get(actionA) ?? [], true);
      }
    }
  } else {
    for (const actionA of actions) {
      if (!dependencies.get(actionA)) continue;
      addEdgesForWrites(actionA, mightWrite.get(actionA) ?? [], false);
    }
  }

  if (getAdditionalWrites) {
    for (const actionA of actions) {
      addEdgesForWrites(actionA, getAdditionalWrites(actionA) ?? [], false);
    }
  }

  // Add parent-child edges only when no opposing data dependency exists.
  // Structural creation order is a fallback; semantic read/write dependencies
  // should win once a parent actually reads a child's result. The parents
  // within the work set are kept for the cycle break below, which prefers
  // an action whose parent has run.
  const parents = new Map<Action, Action>();
  if (nodes) {
    for (const child of actions) {
      const parent = nodes.parentActionOf(child);
      if (parent && actions.has(parent)) {
        parents.set(child, parent);
        const graphParent = graph.get(parent)!;
        const graphChild = graph.get(child)!;
        if (!graphParent.has(child) && !graphChild.has(parent)) {
          graphParent.add(child);
          inDegree.set(child, (inDegree.get(child) || 0) + 1);
        }
      }
    }
  }

  // Perform topological sort with cycle handling.
  //
  // Once data edges (§7.4 rule 1) and parent tie-breaks (rule 2) are applied,
  // remaining ties fall back to REGISTRATION ORDER (rule 3) rather than
  // work-set / arrival order, so the run order — and last-writer-wins on any
  // shared address — is identical regardless of the order actions were
  // invalidated or arrived over the network.
  const byRegistrationOrder = makeTieBreakComparator(actions, nodes);
  const queue: Action[] = [];
  const result: Action[] = [];
  const visited = new Set<Action>();

  // Add all actions with no dependencies (in-degree 0) to the queue
  for (const [action, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(action);
    }
  }
  queue.sort(byRegistrationOrder);

  // A read/write cycle leaves the queue empty with actions unvisited, and
  // one of them is then placed ahead of an input it reads. `CycleBreaks`
  // chooses which. It is built at the first break, so a pass without a
  // cycle builds none.
  let breaks: CycleBreaks | undefined;
  while (queue.length > 0 || visited.size < actions.size) {
    if (queue.length === 0) {
      breaks ??= new CycleBreaks(
        actions,
        visited,
        graph,
        inDegree,
        parents,
        byRegistrationOrder,
      );
      queue.push(breaks.take());
    }

    const current = queue.shift()!;
    if (visited.has(current)) continue;

    result.push(current);
    visited.add(current);

    for (const neighbor of graph.get(current) || []) {
      const degree = inDegree.get(neighbor)! - 1;
      inDegree.set(neighbor, degree);
      if (degree === 0) {
        insertReadyAction(queue, neighbor, byRegistrationOrder);
      }
    }
    // Called once the in-degrees above have fallen: where this visit
    // leaves a component with no feeder, its members' keys are read from
    // them.
    breaks?.place(current);
  }

  return result;
}

/**
 * A strongly connected component of more than one unplaced action: a set of
 * actions each of which reaches every other over edges among the unplaced.
 */
type CycleComponent = {
  /**
   * The actions' indices. Those placed since the component was found stay
   * listed, and are passed over wherever the members are read.
   */
  readonly members: readonly number[];

  /** How many of `members` are unplaced. */
  size: number;

  /** Edges into the component from unplaced actions outside it. */
  feeders: number;

  /**
   * `fed` while an unplaced action outside feeds it, `unfed` once none
   * does, and `broken` from the first of its members to be placed, when
   * the rest may be strongly connected no longer.
   */
  status: "fed" | "unfed" | "broken";

  /**
   * The members placed since the component was last known to be strongly
   * connected, in the order they were placed.
   */
  placed: number[];
};

/**
 * The choice of the action that breaks a cycle (§7.4): a member of a cycle
 * that no unplaced action outside it feeds, and among those the one with no
 * unplaced parent, then the lowest remaining in-degree, then the earliest
 * registration. An action that only reads from a cycle is never chosen, so
 * a break reorders edges inside a cycle and no others.
 *
 * Those members are the actions of the strongly connected components of the
 * unplaced actions that have more than one action and no feeder. Placing an
 * action changes the components of no action outside its own component, so
 * the components are found once, over what is unplaced at the first break,
 * and after that only a component with a member placed is looked at again.
 *
 * What that costs depends on what the break left. The remaining members
 * are still one component exactly when each of them that fed the action
 * placed still reaches each of them that it, or an action placed after it,
 * fed. Two traversals from one of the former settle that, and stop once
 * they have reached the actions in question: a few steps where the action
 * placed had near neighbors, and about the member count for a densely
 * connected component. The component then stands, and only the members
 * whose key the placing changed are put back among the candidates.
 * Otherwise the components among the remaining members are searched for,
 * at the cost of the edges leaving them. Either way a break is bounded by
 * the cycle it fell in and not by the work set.
 */
class CycleBreaks {
  /**
   * The actions unplaced at construction. An action's index is its place
   * here.
   */
  readonly #actions: Action[] = [];
  readonly #indices = new Map<Action, number>();
  readonly #inDegree: ReadonlyMap<Action, number>;

  /**
   * The edges by where they start: the indices that index `i` has an edge
   * to are `#targets` from `#firstTarget[i]` up to `#firstTarget[i + 1]`.
   */
  readonly #firstTarget: Int32Array;
  readonly #targets: Int32Array;

  /**
   * The same edges by where they arrive: the indices with an edge to index
   * `i` are `#sources` from `#firstSource[i]` up to `#firstSource[i + 1]`.
   */
  readonly #firstSource: Int32Array;
  readonly #sources: Int32Array;

  /**
   * The index of each action's parent, or `-1` where it has none in the
   * work set that was unplaced at construction.
   */
  readonly #parent: Int32Array;

  /**
   * Each index's position in registration order, and the index at each
   * position.
   */
  readonly #rank: Int32Array;
  readonly #byRank: Int32Array;

  readonly #placed: Uint8Array;
  readonly #component: (CycleComponent | undefined)[];

  /** Components with a member placed since they were found. */
  readonly #broken: CycleComponent[] = [];

  /**
   * A min-heap of keys of members of unfed components. A key orders by the
   * break's preference and names its action, and `#key` holds the latest
   * one pushed for each action, so an entry is current when it equals that
   * key and its action is unplaced in an unfed component.
   */
  readonly #heap: number[] = [];
  readonly #key: Float64Array;

  // Working state of the traversals, kept across them. A traversal is
  // numbered, and an index is in its scope, reached by it, or wanted by it,
  // when the entry for the index holds that number.
  readonly #scope: Int32Array;
  readonly #reached: Int32Array;
  readonly #wanted: Int32Array;
  readonly #order: Int32Array;
  readonly #low: Int32Array;
  readonly #nextEdge: Int32Array;
  readonly #onStack: Uint8Array;
  #traversal = 0;

  /**
   * Constructs an instance over the actions of `actions` not yet in
   * `visited`. `graph` and `parents` are read here and not again;
   * `inDegree` is read at every break, and must hold each unplaced action's
   * count of unplaced actions with an edge to it.
   */
  constructor(
    actions: ReadonlySet<Action>,
    visited: ReadonlySet<Action>,
    graph: ReadonlyMap<Action, ReadonlySet<Action>>,
    inDegree: ReadonlyMap<Action, number>,
    parents: ReadonlyMap<Action, Action>,
    byRegistrationOrder: (a: Action, b: Action) => number,
  ) {
    this.#inDegree = inDegree;
    for (const action of actions) {
      if (visited.has(action)) continue;
      this.#indices.set(action, this.#actions.length);
      this.#actions.push(action);
    }
    const count = this.#actions.length;

    this.#firstTarget = new Int32Array(count + 1);
    this.#firstSource = new Int32Array(count + 1);
    const targets: number[] = [];
    this.#parent = new Int32Array(count).fill(-1);
    for (let index = 0; index < count; index++) {
      const action = this.#actions[index];
      this.#firstTarget[index] = targets.length;
      for (const neighbor of graph.get(action) ?? []) {
        const target = this.#indices.get(neighbor);
        if (target === undefined) continue;
        targets.push(target);
        this.#firstSource[target + 1]++;
      }
      const parent = parents.get(action);
      if (parent !== undefined) {
        this.#parent[index] = this.#indices.get(parent) ?? -1;
      }
    }
    this.#firstTarget[count] = targets.length;
    this.#targets = Int32Array.from(targets);

    // Each index's count of arriving edges becomes where its sources start.
    for (let index = 0; index < count; index++) {
      this.#firstSource[index + 1] += this.#firstSource[index];
    }
    this.#sources = new Int32Array(targets.length);
    const nextSource = this.#firstSource.slice(0, count);
    for (let index = 0; index < count; index++) {
      const end = this.#firstTarget[index + 1];
      for (let edge = this.#firstTarget[index]; edge < end; edge++) {
        this.#sources[nextSource[this.#targets[edge]]++] = index;
      }
    }

    this.#byRank = Int32Array.from(
      Array.from({ length: count }, (_, index) => index).sort((a, b) =>
        byRegistrationOrder(this.#actions[a], this.#actions[b])
      ),
    );
    this.#rank = new Int32Array(count);
    for (let rank = 0; rank < count; rank++) {
      this.#rank[this.#byRank[rank]] = rank;
    }

    this.#placed = new Uint8Array(count);
    this.#component = new Array(count);
    this.#key = new Float64Array(count);
    this.#scope = new Int32Array(count);
    this.#reached = new Int32Array(count);
    this.#wanted = new Int32Array(count);
    this.#order = new Int32Array(count);
    this.#low = new Int32Array(count);
    this.#nextEdge = new Int32Array(count);
    this.#onStack = new Uint8Array(count);

    const all = Array.from({ length: count }, (_, index) => index);
    for (const members of this.#stronglyConnected(all)) this.#adopt(members);
  }

  /**
   * Returns the action to break a cycle at, which the caller then visits
   * and reports to `place()`.
   *
   * @throws When no unplaced action is on a cycle, which no caller with an
   *   empty ready queue and an action left to place can be in.
   */
  take(): Action {
    for (const component of this.#broken) this.#renew(component);
    this.#broken.length = 0;

    const count = this.#actions.length;
    for (;;) {
      const key = this.#pop();
      if (key === undefined) {
        throw new Error("A cycle break found no cycle to break.");
      }
      const index = this.#byRank[key % count];
      if (
        !this.#placed[index] && this.#key[index] === key &&
        this.#component[index]?.status === "unfed"
      ) {
        return this.#actions[index];
      }
    }
  }

  /**
   * Records that the caller visited `action`, once the in-degrees of the
   * actions it has an edge to have fallen.
   */
  place(action: Action): void {
    const index = this.#indices.get(action)!;
    this.#placed[index] = 1;
    const own = this.#component[index];
    if (own !== undefined) {
      own.placed.push(index);
      if (own.status !== "broken") {
        own.status = "broken";
        this.#broken.push(own);
      }
    }
    const end = this.#firstTarget[index + 1];
    for (let edge = this.#firstTarget[index]; edge < end; edge++) {
      const fed = this.#component[this.#targets[edge]];
      if (fed === undefined || fed === own || fed.status !== "fed") continue;
      if (--fed.feeders === 0) this.#free(fed);
    }
  }

  /**
   * Brings `component`, members of which have been placed, up to date:
   * either it stands with the members it has left, or the components
   * among them replace it.
   *
   * The component was unfed, and the first of its members to be placed was
   * the one a break took: a break takes a member of an unfed component
   * alone, and every other visit is of an action that no unplaced action
   * feeds, which is on no cycle. The members placed after it were visited
   * that way. So nothing outside feeds the remaining members, and where
   * they are still one component, that component is unfed too.
   */
  #renew(component: CycleComponent): void {
    const gone = component.placed;
    component.size -= gone.length;
    if (component.size < 2) return;

    // A path between two remaining members that ran through the placed
    // ones entered them at the action the break took, from a remaining
    // member with an edge to it, and left them at a remaining member one
    // of them has an edge to. So the remaining members are one component
    // exactly when each of the former still reaches each of the latter.
    const mine = (index: number) =>
      !this.#placed[index] && this.#component[index] === component;
    const [taken] = gone;
    const fromThem: number[] = [];
    for (
      let edge = this.#firstSource[taken];
      edge < this.#firstSource[taken + 1];
      edge++
    ) {
      if (mine(this.#sources[edge])) fromThem.push(this.#sources[edge]);
    }
    const toThem: number[] = [];
    for (const index of gone) {
      const end = this.#firstTarget[index + 1];
      for (let edge = this.#firstTarget[index]; edge < end; edge++) {
        if (mine(this.#targets[edge])) toThem.push(this.#targets[edge]);
      }
    }
    if (
      fromThem.length > 0 &&
      this.#reachesEach(
        component,
        fromThem[0],
        toThem,
        this.#firstTarget,
        this.#targets,
      ) &&
      this.#reachesEach(
        component,
        fromThem[0],
        fromThem,
        this.#firstSource,
        this.#sources,
      )
    ) {
      component.status = "unfed";
      component.placed = [];
      // The keys that changed: an in-degree fell where a placed member had
      // an edge to the action, and a parent among the placed members has
      // an edge to its child or one from it.
      for (const index of toThem) this.#offer(index);
      for (const index of fromThem) this.#offer(index);
      return;
    }

    const rest = component.members.filter(mine);
    for (const members of this.#stronglyConnected(rest)) this.#adopt(members);
  }

  /**
   * Records `members`, strongly connected and unplaced, as a component,
   * counting its feeders: the unplaced actions with an edge to a member,
   * less the edges that start at a member.
   */
  #adopt(members: readonly number[]): void {
    const component: CycleComponent = {
      members,
      size: members.length,
      feeders: 0,
      status: "fed",
      placed: [],
    };
    for (const index of members) this.#component[index] = component;
    for (const index of members) {
      component.feeders += this.#inDegree.get(this.#actions[index])!;
      const end = this.#firstTarget[index + 1];
      for (let edge = this.#firstTarget[index]; edge < end; edge++) {
        if (this.#component[this.#targets[edge]] === component) {
          component.feeders--;
        }
      }
    }
    if (component.feeders === 0) this.#free(component);
  }

  /**
   * Makes the members of `component`, which nothing unplaced feeds any
   * longer, candidates for a break. Their keys hold until one of them is
   * placed. An in-degree falls when an action with an edge to the member
   * is placed, and every such unplaced action is itself a member. A parent
   * in the work set either has an edge to its child, which makes it a
   * member too, or has one from it, and is then placed after it.
   */
  #free(component: CycleComponent): void {
    component.status = "unfed";
    for (const index of component.members) this.#offer(index);
  }

  /**
   * Puts the unplaced action at `index` among the candidates under its
   * current key. An action may hold several entries under one key: an
   * entry that reaches the top while the action's component is fed is
   * dropped, so each time the action becomes a candidate it is given a
   * fresh one.
   */
  #offer(index: number): void {
    const count = this.#actions.length;
    const parent = this.#parent[index];
    const blocked = parent >= 0 && !this.#placed[parent] ? 1 : 0;
    const degree = this.#inDegree.get(this.#actions[index])!;
    const key = (blocked * count + degree) * count + this.#rank[index];
    this.#key[index] = key;
    this.#push(key);
  }

  /**
   * Returns whether `from` reaches every index of `wanted` over the edges
   * given, through unplaced members of `component` alone. With `#targets`
   * that is `from` reaching them, and with `#sources` them reaching
   * `from`. The traversal stops once it has reached them all.
   */
  #reachesEach(
    component: CycleComponent,
    from: number,
    wanted: readonly number[],
    firstEdge: Int32Array,
    ends: Int32Array,
  ): boolean {
    const traversal = ++this.#traversal;
    const reached = this.#reached;
    const isWanted = this.#wanted;
    let missing = 0;
    for (const index of wanted) {
      if (isWanted[index] === traversal) continue;
      isWanted[index] = traversal;
      missing++;
    }
    reached[from] = traversal;
    if (isWanted[from] === traversal) missing--;
    const pending = [from];
    while (missing > 0 && pending.length > 0) {
      const index = pending.pop()!;
      const end = firstEdge[index + 1];
      for (let edge = firstEdge[index]; edge < end; edge++) {
        const next = ends[edge];
        if (
          reached[next] === traversal || this.#placed[next] ||
          this.#component[next] !== component
        ) {
          continue;
        }
        reached[next] = traversal;
        if (isWanted[next] === traversal) missing--;
        pending.push(next);
      }
    }
    return missing === 0;
  }

  /**
   * Returns the strongly connected components of more than one action in
   * the graph over `scope`, which holds unplaced indices, by Tarjan's
   * algorithm with its recursion kept in an explicit path.
   */
  #stronglyConnected(scope: readonly number[]): number[][] {
    const traversal = ++this.#traversal;
    const inScope = this.#scope;
    const order = this.#order;
    const low = this.#low;
    const nextEdge = this.#nextEdge;
    const onStack = this.#onStack;
    const firstTarget = this.#firstTarget;
    const targets = this.#targets;
    for (const index of scope) {
      inScope[index] = traversal;
      order[index] = 0;
    }
    const found: number[][] = [];
    const path: number[] = [];
    const stack: number[] = [];
    let next = 1;

    for (const root of scope) {
      if (order[root] !== 0) continue;
      let entering = root;
      for (;;) {
        if (entering >= 0) {
          order[entering] = low[entering] = next++;
          nextEdge[entering] = firstTarget[entering];
          onStack[entering] = 1;
          path.push(entering);
          stack.push(entering);
          entering = -1;
        }
        if (path.length === 0) break;
        const index = path[path.length - 1];
        if (nextEdge[index] < firstTarget[index + 1]) {
          const target = targets[nextEdge[index]++];
          if (inScope[target] !== traversal) continue;
          if (order[target] === 0) {
            entering = target;
          } else if (onStack[target] && order[target] < low[index]) {
            low[index] = order[target];
          }
          continue;
        }
        path.pop();
        if (path.length > 0) {
          const from = path[path.length - 1];
          if (low[index] < low[from]) low[from] = low[index];
        }
        if (low[index] !== order[index]) continue;
        const members: number[] = [];
        let member: number;
        do {
          member = stack.pop()!;
          onStack[member] = 0;
          members.push(member);
        } while (member !== index);
        if (members.length > 1) found.push(members);
      }
    }
    return found;
  }

  #push(key: number): void {
    const heap = this.#heap;
    let index = heap.length;
    heap.push(key);
    while (index > 0) {
      const above = (index - 1) >> 1;
      if (heap[above] <= key) break;
      heap[index] = heap[above];
      index = above;
    }
    heap[index] = key;
  }

  #pop(): number | undefined {
    const heap = this.#heap;
    const top = heap[0];
    const last = heap.pop();
    if (last === undefined || heap.length === 0) return top;
    let index = 0;
    for (;;) {
      const left = 2 * index + 1;
      if (left >= heap.length) break;
      const right = left + 1;
      const least = right < heap.length && heap[right] < heap[left]
        ? right
        : left;
      if (heap[least] >= last) break;
      heap[index] = heap[least];
      index = least;
    }
    heap[index] = last;
    return top;
  }
}

function insertReadyAction(
  queue: Action[],
  action: Action,
  compare: (a: Action, b: Action) => number,
): void {
  let low = 0;
  let high = queue.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compare(queue[mid], action) <= 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  queue.splice(low, 0, action);
}

/** One read an action in the work set orders against writes to its document. */
type IndexedRead = {
  readonly action: Action;
  readonly path: readonly MemoryAddressPathComponent[];
  /** A shallow read, which a write below the read's own children misses. */
  readonly shallow: boolean;
};

/** The key two addresses share when they name the same document. */
function documentKey(address: IMemorySpaceAddress): string {
  return `${address.space}\0${address.id}\0${
    normalizeCellScope(address.scope)
  }`;
}

/**
 * The reads the work set's actions order against, grouped by the document
 * read: what `getOrderingReadLog` answers for each action, laid out so that
 * a writer finds the readers of a document without visiting the actions that
 * read something else. With `declaredOnly`, only the reads an action that has
 * never run declares, which is all a pull-mode pass orders by, since the data
 * edges of the actions that have run are maintained in `dependents`.
 */
function indexReaders(
  actions: ReadonlySet<Action>,
  dependencies: WeakMap<Action, ReactivityLog>,
  nodes: Pick<NodeRegistry, "get"> | undefined,
  declaredOnly: boolean,
): Map<string, IndexedRead[]> {
  const readers = new Map<string, IndexedRead[]>();
  const add = (read: IndexedRead, address: IMemorySpaceAddress) => {
    const key = documentKey(address);
    const list = readers.get(key);
    if (list === undefined) readers.set(key, [read]);
    else list.push(read);
  };
  for (const action of actions) {
    if (declaredOnly) {
      const record = nodes?.get(action);
      if (record?.status !== "never-ran" || record.declaredReads.length === 0) {
        continue;
      }
      for (const address of record.declaredReads) {
        add({ action, path: address.path, shallow: false }, address);
      }
      continue;
    }
    const log = getOrderingReadLog(action, dependencies, nodes);
    if (!log) continue;
    for (const address of log.reads) {
      add({ action, path: address.path, shallow: false }, address);
    }
    for (const address of log.shallowReads) {
      add({ action, path: address.path, shallow: true }, address);
    }
  }
  return readers;
}

function getOrderingReadLog(
  action: Action,
  dependencies: WeakMap<Action, ReactivityLog>,
  nodes?: Pick<NodeRegistry, "get">,
): Pick<ReactivityLog, "reads" | "shallowReads"> | undefined {
  const record = nodes?.get(action);
  if (record?.status === "never-ran" && record.declaredReads.length > 0) {
    return {
      reads: record.declaredReads,
      shallowReads: [],
    };
  }
  return dependencies.get(action);
}

/**
 * Deterministic tie-break comparator for topological ordering (§7.4 rule 3).
 *
 * Primary key is the stable REGISTRATION ORDINAL from the node registry, so
 * ties left by the read-edge DAG resolve to registration order rather than the
 * order actions happened to enter the work set (which for remote commits is
 * network-arrival order). Actions with no registration ordinal (e.g. bare
 * materializers, or any call with `nodes` undefined) fall back to their
 * work-set insertion index, preserving the pre-existing behavior for that case
 * and keeping unregistered actions ordered after registered ones.
 */
function makeTieBreakComparator(
  actions: Set<Action>,
  nodes?: Pick<NodeRegistry, "getRegistrationOrdinal">,
): (a: Action, b: Action) => number {
  const fallbackIndex = new Map<Action, number>();
  let index = 0;
  for (const action of actions) fallbackIndex.set(action, index++);

  const ordinalOf = (action: Action): number =>
    nodes?.getRegistrationOrdinal(action) ?? Number.POSITIVE_INFINITY;

  return (a, b) => {
    const oa = ordinalOf(a);
    const ob = ordinalOf(b);
    // `!==` (not subtraction) so two unregistered actions (both +Infinity)
    // compare equal and fall through to the stable insertion-order index
    // instead of yielding NaN.
    if (oa !== ob) return oa - ob;
    return (fallbackIndex.get(a) ?? 0) - (fallbackIndex.get(b) ?? 0);
  };
}
