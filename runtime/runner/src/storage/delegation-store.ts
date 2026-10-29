/**
 * The delegation chains a runtime holds, and the one it presents when it
 * opens a space.
 *
 * A chain reaches the store as its holder was handed it: the delegations'
 * bytes in order from the root, the one that grants the holder's key last.
 * Each is decoded and verified on the way in, the links are checked to meet,
 * and the chain is kept whole under the space it is over. When a session
 * opens a space as some principal, the store hands back a chain it holds
 * that ends at that principal and whose links all hold at that moment; it
 * assembles nothing from loose delegations, since a holder is handed whole
 * chains and the server judges the chain it is handed
 * (`docs/specs/profile-delegation.md`, "Opening a session with a
 * delegation"). Where several chains end at the principal, one the space
 * itself rooted is preferred, since the server resolves its grant without
 * any access-list entry naming another principal, and otherwise the chain
 * added last: the holder's latest intent.
 *
 * What the store hands back is its own: the arrays are copies, but the
 * delegations in them, their bytes included, are the ones the store holds
 * and will present. A caller reads them and changes nothing in them; a
 * delegation changed after it was added is a proof the server refuses.
 */

import {
  decodeDelegation,
  type Delegation,
  delegationCovers,
  DelegationError,
  verifyDelegation,
} from "@commonfabric/identity";
import {
  MAX_PROOF_CHAIN_LENGTH,
  SESSION_OPEN_COMMAND,
} from "@commonfabric/memory/v2/session-open-auth";

/** Whether every link of `chain` holds at `nowSeconds` and covers an open. */
const usableAt = (chain: readonly Delegation[], nowSeconds: number): boolean =>
  chain.every(({ payload }) =>
    (payload.exp === null || payload.exp >= nowSeconds) &&
    (payload.nbf === undefined || payload.nbf <= nowSeconds) &&
    delegationCovers(payload.cmd, SESSION_OPEN_COMMAND)
  );

/** The delegation chains a runtime holds, keyed by the space each is over. */
export class DelegationStore {
  /** Chains by subject space, in the order they were added, root first. */
  #bySubject = new Map<string, Delegation[][]>();

  /**
   * Adds the chain `bytes` encode, root first, decoding and verifying each
   * delegation and checking that the links meet: each audience is the next
   * issuer, every subject is one space, and the chain is at most
   * {@link MAX_PROOF_CHAIN_LENGTH} long. Returns the decoded chain, whose
   * delegations the store holds from then on and the caller must not change.
   * Throws a `DelegationError` for anything else. Adding a chain the store
   * holds changes nothing.
   */
  async add(bytes: readonly Uint8Array[]): Promise<readonly Delegation[]> {
    if (bytes.length === 0) {
      throw new DelegationError("the chain is empty");
    }
    if (bytes.length > MAX_PROOF_CHAIN_LENGTH) {
      throw new DelegationError(
        `the chain is longer than ${MAX_PROOF_CHAIN_LENGTH} delegations`,
      );
    }
    const chain: Delegation[] = [];
    for (const link of bytes) {
      // A copy, so the held bytes stay the bytes the CID and payload
      // describe whatever the caller does with its array afterwards.
      const delegation = await decodeDelegation(link.slice());
      await verifyDelegation(delegation);
      const previous = chain.at(-1);
      if (
        previous !== undefined &&
        previous.payload.aud !== delegation.payload.iss
      ) {
        throw new DelegationError(
          `delegation ${chain.length} is not issued by the previous audience`,
        );
      }
      chain.push(delegation);
    }
    const space = chain[0].payload.sub;
    // A delegation over any subject is one no space's open can present.
    if (space === null) {
      throw new DelegationError("the chain is over no space");
    }
    if (chain.some(({ payload }) => payload.sub !== space)) {
      throw new DelegationError("the chain is over more than one space");
    }
    let held = this.#bySubject.get(space);
    if (held === undefined) {
      held = [];
      this.#bySubject.set(space, held);
    }
    const cids = chain.map(({ cid }) => cid).join(" ");
    if (!held.some((known) => known.map(({ cid }) => cid).join(" ") === cids)) {
      held.push(chain);
    }
    return [...chain];
  }

  /**
   * The chain to present when opening `space` as `principal`, root first, or
   * `undefined` when the store holds no usable chain over `space` ending at
   * `principal`. A chain is usable when every link holds at `nowSeconds` and
   * covers a session open. Among the usable chains, one the space itself
   * rooted is preferred, and otherwise the one added last. The delegations
   * returned are the ones the store holds, and the caller must not change
   * them.
   */
  chainFor(
    space: string,
    principal: string,
    nowSeconds = Math.floor(Date.now() / 1000),
  ): readonly Delegation[] | undefined {
    const held = this.#bySubject.get(space);
    if (held === undefined) return undefined;
    let latest: Delegation[] | undefined;
    let latestRooted: Delegation[] | undefined;
    for (const chain of held) {
      if (chain.at(-1)!.payload.aud !== principal) continue;
      if (!usableAt(chain, nowSeconds)) continue;
      latest = chain;
      if (chain[0].payload.iss === space) latestRooted = chain;
    }
    const chosen = latestRooted ?? latest;
    return chosen === undefined ? undefined : [...chosen];
  }
}
