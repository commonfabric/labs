/**
 * The delegations a runtime holds, and the chain it presents when it opens a
 * space.
 *
 * A delegation reaches the store as the bytes its issuer encoded, is decoded
 * and verified on the way in, and is kept under the space it is over. When a
 * session opens a space as some principal, the store assembles the chain
 * that ends at that principal: the delegation whose audience is the
 * principal, then the one whose audience is that delegation's issuer, and so
 * on back to a root, which is a delegation the space itself issued or the
 * last one the store can link. The chain is what the open presents as its
 * proofs (`docs/specs/profile-delegation.md`, "Opening a session with a
 * delegation"); the server decides whether the root issuer's grant admits it.
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

/** The delegations a runtime holds, keyed by the space each is over. */
export class DelegationStore {
  /** Delegations by subject space, then by CID, so each is held once. */
  #bySubject = new Map<string, Map<string, Delegation>>();

  /**
   * Adds the delegation `bytes` encode, decoding and verifying it first.
   * Throws a `DelegationError` for bytes that are not a delegation or do
   * not verify. Adding a delegation the store holds changes nothing.
   */
  async add(bytes: Uint8Array): Promise<Delegation> {
    // A copy, so the held bytes stay the bytes the CID and payload describe
    // whatever the caller does with its array afterwards.
    const delegation = await decodeDelegation(bytes.slice());
    await verifyDelegation(delegation);
    const { sub } = delegation.payload;
    // A delegation over any subject is one no space's open can present.
    if (sub === null) {
      throw new DelegationError("the delegation is over no space");
    }
    let held = this.#bySubject.get(sub);
    if (held === undefined) {
      held = new Map();
      this.#bySubject.set(sub, held);
    }
    held.set(delegation.cid, delegation);
    return delegation;
  }

  /**
   * The chain to present when opening `space` as `principal`, root first, or
   * `undefined` when the store holds no delegation over `space` whose
   * audience is `principal`. The search runs back from `principal` over the
   * delegations valid now and covering a session open, each link's audience
   * being the link after it, and returns the first complete chain it finds,
   * one whose root the space itself issued, trying delegations in the order
   * they were added. Where no complete chain exists within the length a
   * server admits, it returns the first chain it found, for the server to
   * judge against the access list.
   */
  chainFor(
    space: string,
    principal: string,
    nowSeconds = Math.floor(Date.now() / 1000),
  ): Delegation[] | undefined {
    const held = this.#bySubject.get(space);
    if (held === undefined) return undefined;
    const usable = [...held.values()].filter(({ payload }) =>
      (payload.exp === null || payload.exp >= nowSeconds) &&
      (payload.nbf === undefined || payload.nbf <= nowSeconds) &&
      delegationCovers(payload.cmd, SESSION_OPEN_COMMAND)
    );
    let fallback: Delegation[] | undefined;
    // Depth-first from the principal back toward a root: `chain` holds the
    // links found so far, last audience first, and is reversed on return.
    const search = (
      audience: string,
      chain: Delegation[],
    ): Delegation[] | undefined => {
      if (chain.length >= MAX_PROOF_CHAIN_LENGTH) return undefined;
      for (const delegation of usable) {
        if (delegation.payload.aud !== audience || chain.includes(delegation)) {
          continue;
        }
        const extended = [...chain, delegation];
        if (delegation.payload.iss === space) return extended;
        const complete = search(delegation.payload.iss, extended);
        if (complete !== undefined) return complete;
        fallback ??= extended;
      }
      return undefined;
    };
    const found = search(principal, []) ?? fallback;
    return found === undefined ? undefined : found.reverse();
  }
}
