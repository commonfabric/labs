import {
  resolveScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";
import type { NormalizedFullLink } from "../link-types.ts";

/**
 * The stores a runtime owns: the documents it materializes to hold a piece's
 * machinery rather than data an author named.
 *
 * Which store the runtime owns is a fact about the store rather than about the
 * transaction that first wrote it, so the answer outlives that transaction —
 * the reactive updates, event handlers and settled requests that fill such a
 * store each run on a transaction of their own, and none of them re-names it.
 * `Runtime.edit` hands this object to every transaction it creates, which is
 * what carries the answer across.
 *
 * Every enrollment names the piece the store was minted for, and a piece takes
 * its own out when it stops. That is what bounds this: a list operation mints
 * one piece per element, so an enrollment that lived for the process would
 * grow with every element a churning list ever held.
 */
export class RuntimeOwnedStores {
  /**
   * The pieces holding each store. A store leaves when the last of them does:
   * one store legitimately has several owners — the scope instances of one
   * causal piece are separate registrations that stop separately, and a
   * re-instantiation re-enrolls what the one before it did — so dropping a
   * store on the first release would refuse the survivors' writes.
   */
  readonly #owners = new Map<string, Set<string>>();
  /** The stores each piece enrolled, for the release. */
  readonly #byOwner = new Map<string, Set<string>>();

  has(store: string): boolean {
    return this.#owners.has(store);
  }

  add(store: string, owner: string): void {
    let owners = this.#owners.get(store);
    if (owners === undefined) {
      owners = new Set<string>();
      this.#owners.set(store, owners);
    }
    owners.add(owner);
    let owned = this.#byOwner.get(owner);
    if (owned === undefined) {
      owned = new Set<string>();
      this.#byOwner.set(owner, owned);
    }
    owned.add(store);
  }

  /** Forget what `owner` enrolled, leaving what other pieces still hold. */
  releaseOwner(owner: string): void {
    const owned = this.#byOwner.get(owner);
    if (owned === undefined) return;
    for (const store of owned) {
      // Present by construction: `add` fills both maps together, and a store
      // leaves `#owners` only once no `#byOwner` set still names it.
      const owners = this.#owners.get(store)!;
      owners.delete(owner);
      if (owners.size === 0) this.#owners.delete(store);
    }
    this.#byOwner.delete(owner);
  }
}

/**
 * The key a store the runtime owns is enrolled under: the space and the
 * document id, joined on a separator neither can contain.
 *
 * Scope is deliberately not part of it. `docs/specs/scoped-cell-instances.md`
 * makes scope an addressing dimension layered over a causal id rather than a
 * component of it, so the space-, user- and session-scoped instances of one id
 * are instances of the same cell — the runtime materializes each of them for
 * the same piece, and a narrower instance's audience is a subset of the
 * broader one's. Keying on scope would enroll whichever instance the runtime
 * happened to mint first and refuse the others.
 */
export const runtimeOwnedStoreKey = (space: string, id: string): string =>
  `${space}\u0000${id}`;

/**
 * The key a piece owns its enrollments under, or `undefined` where it may own
 * none.
 *
 * Scope IS part of this one, resolved the way the runner keys its own piece
 * registrations: two scope instances of one causal piece are two registrations
 * that start and stop separately, so they are two owners. A scope-free owner
 * key would let one instance's teardown take the other's enrollments with it.
 *
 * A piece owns nothing outside its own space. A store elsewhere belongs to
 * whoever holds that space's replicas, so this piece supplies no ownership
 * authority for admitting its writes.
 */
export const runtimeOwnedStoreOwnerKey = (
  store: { space: string },
  owner: NormalizedFullLink,
  identity: ScopeKeyIdentity,
): string | undefined =>
  owner.space === store.space
    ? `${owner.space}\u0000${
      resolveScopeKey(owner.scope, identity)
    }\u0000${owner.id}`
    : undefined;
