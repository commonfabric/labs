import type { ScopeKey } from "@commonfabric/memory/v2";

import type { CellScope } from "../builder/types.ts";
import type {
  IMemorySpaceAddress,
  MemoryAddressPathComponent,
  MemorySpace,
  URI,
} from "./interface.ts";

/** Fewest slots the table holds before a sweep runs. */
const MIN_SWEEP_AT = 4096;

/**
 * What one slot of a path node holds for one document id: the address, or
 * one address per (space, scope, scope key) that id was interned under.
 */
type Held = WeakRef<IMemorySpaceAddress> | WeakRef<IMemorySpaceAddress>[];

/** One node of the trie over path components. */
type PathNode = {
  /** The frozen path this node stands for, shared by its addresses. */
  readonly path: readonly MemoryAddressPathComponent[];

  /** The node one component shorter; absent at the root. */
  readonly parent: PathNode | undefined;

  /** The last component of `path`; absent at the root. */
  readonly component: MemoryAddressPathComponent | undefined;

  /** The nodes one component longer, by that component. */
  children: Map<MemoryAddressPathComponent, PathNode> | undefined;

  /** The addresses interned at this path, by document id. */
  addresses: Map<URI, Held> | undefined;
};

/**
 * Whether `address` names a document of `space` under `scope` and `scopeKey`;
 * the caller has already matched its id and path.
 */
function sameDocument(
  address: IMemorySpaceAddress,
  space: MemorySpace,
  scope: CellScope | undefined,
  scopeKey: ScopeKey | undefined,
): boolean {
  return address.space === space && address.scope === scope &&
    address.scopeKey === scopeKey;
}

/**
 * One shared, frozen instance of each memory address a reactivity log names.
 *
 * The scheduler keeps every active computation's log, and many computations
 * read the same places, so each log holding its own address objects and path
 * arrays holds the same content many times over. `address()` returns one
 * frozen address per distinct (space, scope, scope key, id, path), whose
 * `path` is one frozen array per distinct path, for as long as anything else
 * holds that address.
 *
 * The table holds its addresses weakly. It counts slots, live or dead, and
 * once the count reaches the sweep threshold it drops the dead ones, prunes
 * the path nodes nothing is under any more, and sets the threshold to twice
 * the live count, or to 4,096 if that is more. So it never holds more than
 * twice the live addresses it held at its last sweep, or 4,096 slots, and a
 * sweep costs time in proportion to the slots it visits, once per doubling.
 * Between sweeps it can hold dead slots: an address nothing holds is released
 * when the collector takes it, and its slot is reclaimed at the next sweep or
 * the next lookup of the same address.
 *
 * It never freezes, keeps or returns an array a caller passed in: each path
 * node holds a frozen copy of its own.
 */
export class AddressInterner {
  #root: PathNode = {
    path: Object.freeze([]),
    parent: undefined,
    component: undefined,
    children: undefined,
    addresses: undefined,
  };

  #nodesWithAddresses = new Set<PathNode>();
  #slots = 0;
  #sweepAt = MIN_SWEEP_AT;

  /**
   * The sweep, and the count of path nodes the trie holds besides its root,
   * which a test drives and reads directly.
   */
  get accessForTestingOnly(): {
    sweep(): void;
    pathNodeCount(): number;
  } {
    return {
      sweep: () => this.#sweep(),
      pathNodeCount: () => this.#pathNodeCount(),
    };
  }

  /** Slots the table holds, live or dead. */
  get size(): number {
    return this.#slots;
  }

  /**
   * Returns the frozen address of `id` at `path` under `space`, `scope` and
   * `scopeKey`. Its own keys are `space`, `scope`, `id`, `scopeKey` when one is
   * given, and `path`, in that order; `scope` is present even when it is
   * `undefined`. Two calls with equal arguments return the same object while
   * the first one's result is reachable.
   */
  address(
    space: MemorySpace,
    scope: CellScope | undefined,
    id: URI,
    scopeKey: ScopeKey | undefined,
    path: readonly MemoryAddressPathComponent[],
  ): IMemorySpaceAddress {
    const node = this.#nodeOf(path);
    const held = node.addresses?.get(id);
    let deadSlot = false;
    if (Array.isArray(held)) {
      for (const ref of held) {
        const address = ref.deref();
        if (address === undefined) {
          deadSlot = true;
        } else if (sameDocument(address, space, scope, scopeKey)) {
          return address;
        }
      }
    } else if (held !== undefined) {
      const address = held.deref();
      if (address === undefined) {
        deadSlot = true;
      } else if (sameDocument(address, space, scope, scopeKey)) {
        return address;
      }
    }

    const address: IMemorySpaceAddress = Object.freeze({
      space,
      scope,
      id,
      ...(scopeKey !== undefined ? { scopeKey } : {}),
      path: node.path,
    });
    const ref = new WeakRef(address);
    if (node.addresses === undefined) {
      node.addresses = new Map();
      this.#nodesWithAddresses.add(node);
    }
    if (held === undefined) {
      node.addresses.set(id, ref);
      this.#slots++;
    } else if (!Array.isArray(held)) {
      if (deadSlot) {
        node.addresses.set(id, ref);
      } else {
        node.addresses.set(id, [held, ref]);
        this.#slots++;
      }
    } else {
      const dead = held.findIndex((each) => each.deref() === undefined);
      if (dead >= 0) {
        held[dead] = ref;
      } else {
        held.push(ref);
        this.#slots++;
      }
    }
    if (this.#slots >= this.#sweepAt) this.#sweep();
    return address;
  }

  /** Helper for `address()`, which finds or makes the node for `path`. */
  #nodeOf(path: readonly MemoryAddressPathComponent[]): PathNode {
    let node = this.#root;
    for (let depth = 0; depth < path.length; depth++) {
      const component = path[depth];
      let child = node.children?.get(component);
      if (child === undefined) {
        child = {
          path: Object.freeze(path.slice(0, depth + 1)),
          parent: node,
          component,
          children: undefined,
          addresses: undefined,
        };
        (node.children ??= new Map()).set(component, child);
      }
      node = child;
    }
    return node;
  }

  /**
   * Drops every dead slot and every path node left holding neither an address
   * nor a child, and sets the next threshold from the live count.
   */
  #sweep(): void {
    let live = 0;
    for (const node of this.#nodesWithAddresses) {
      const addresses = node.addresses!;
      for (const [id, held] of addresses) {
        if (Array.isArray(held)) {
          const kept = held.filter((ref) => ref.deref() !== undefined);
          if (kept.length === 0) {
            addresses.delete(id);
          } else {
            addresses.set(id, kept.length === 1 ? kept[0] : kept);
            live += kept.length;
          }
        } else if (held.deref() === undefined) {
          addresses.delete(id);
        } else {
          live++;
        }
      }
      if (addresses.size === 0) {
        node.addresses = undefined;
        this.#nodesWithAddresses.delete(node);
        this.#prune(node);
      }
    }
    this.#slots = live;
    this.#sweepAt = Math.max(MIN_SWEEP_AT, 2 * live);
  }

  /**
   * Helper for `#sweep()`, which removes `node` and then each parent in turn
   * while it holds neither an address nor a child.
   */
  #prune(node: PathNode): void {
    let at = node;
    while (
      at.parent !== undefined && at.addresses === undefined &&
      at.children === undefined
    ) {
      const parent: PathNode = at.parent;
      parent.children!.delete(at.component!);
      if (parent.children!.size === 0) parent.children = undefined;
      at = parent;
    }
  }

  /** Helper for `accessForTestingOnly`, which counts the non-root nodes. */
  #pathNodeCount(): number {
    let count = 0;
    const pending = [this.#root];
    while (pending.length > 0) {
      const node = pending.pop()!;
      for (const child of node.children?.values() ?? []) {
        count++;
        pending.push(child);
      }
    }
    return count;
  }
}
