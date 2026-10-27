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
  verifyDelegation,
} from "@commonfabric/identity";
import { MAX_PROOF_CHAIN_LENGTH } from "@commonfabric/memory/v2/session-open-auth";

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
    const delegation = await decodeDelegation(bytes);
    await verifyDelegation(delegation);
    const { sub } = delegation.payload;
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
   * audience is `principal`. Each link is the earliest-added unexpired
   * delegation whose audience is the link after it, a delegation the space
   * itself issued being preferred since it ends the chain; the chain stops
   * there, where no link precedes, or at the length a server admits.
   */
  chainFor(
    space: string,
    principal: string,
    nowSeconds = Math.floor(Date.now() / 1000),
  ): Delegation[] | undefined {
    const held = this.#bySubject.get(space);
    if (held === undefined) return undefined;
    const chain: Delegation[] = [];
    const used = new Set<string>();
    let audience = principal;
    while (chain.length < MAX_PROOF_CHAIN_LENGTH) {
      let next: Delegation | undefined;
      for (const delegation of held.values()) {
        const { payload } = delegation;
        if (
          payload.aud !== audience || used.has(delegation.cid) ||
          (payload.exp !== null && payload.exp < nowSeconds)
        ) continue;
        if (payload.iss === space) {
          next = delegation;
          break;
        }
        next ??= delegation;
      }
      if (next === undefined) break;
      chain.push(next);
      used.add(next.cid);
      if (next.payload.iss === space) break;
      audience = next.payload.iss;
    }
    return chain.length === 0 ? undefined : chain.reverse();
  }
}
