/**
 * Joining the pattern index from `cf`: redeeming an invite with a key made
 * for the index alone, or adopting a chain the person's root issued on
 * another machine.
 */

import type { DIDKey } from "@commonfabric/identity";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import {
  PatternIndexClient,
  type PatternIndexMember,
} from "@commonfabric/pattern-index/client";
import {
  openPatternIndexClient,
  type PatternIndexAccessOptions,
} from "@commonfabric/pattern-index/access";
import {
  checkIndexChain,
  indexProofs,
} from "@commonfabric/pattern-index/membership";
import {
  PatternIndexStore,
  patternIndexStoreDir,
} from "@commonfabric/pattern-index/store";

export {
  chainForSigner,
  DEFAULT_PATTERN_INDEX_URL,
  openPatternIndexClient,
  resolvePatternIndexUrl,
} from "@commonfabric/pattern-index/access";

/** An invite as its link carries it. */
export interface IndexInvite {
  inviteId: string;
  code: string;
}

/**
 * The invite in `link`: `invite=` in its query and `code=` in its fragment,
 * as `createInvite` writes it.
 *
 * @throws Error that never quotes the link, since it carries the code.
 */
export const parseInviteLink = (link: string): IndexInvite => {
  const url = URL.parse(link.trim());
  if (url === null) {
    throw new Error("The invite is not a link");
  }
  const inviteId = url.searchParams.get("invite");
  const code = new URLSearchParams(url.hash.replace(/^#/, "")).get("code");
  if (!inviteId || !code) {
    throw new Error(
      "The invite link carries no invite id or no code; copy the whole link, including the part after #",
    );
  }
  return { inviteId, code };
};

/** What a join did. */
export interface JoinResult {
  handle: string;
  role: PatternIndexMember["role"];

  /** The index-only root's DID. */
  root: DIDKey;

  /** The `cf` identity, now acting for the member. */
  signer: DIDKey;

  /** False when this machine was already a member and only renewed its chain. */
  joined: boolean;

  /** Where the root key and chains are kept. */
  storeDir: string;
}

export interface JoinOptions extends PatternIndexAccessOptions {
  invite: IndexInvite;
}

/**
 * Redeems `invite` with a key made for this index alone, which becomes the
 * member's root, then has that root delegate `/index` to the `cf` identity
 * and confirms the index sees the identity as the same member.
 *
 * Joining where a membership is already recorded redeems nothing and only
 * makes sure the identity holds a chain, so running it twice is harmless
 * and an invite is never spent on a person who already has a root.
 *
 * @throws Error naming what failed; the invite code is never in it.
 */
export async function joinPatternIndex(
  options: JoinOptions,
): Promise<JoinResult> {
  const store = options.store ??
    new PatternIndexStore(patternIndexStoreDir(options.baseUrl));
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const existing = await store.membership();
  let joined = false;
  if (existing === undefined) {
    const root = await store.rootKey() ?? await store.createRootKey();
    const asRoot = new PatternIndexClient({
      baseUrl: options.baseUrl,
      signer: root,
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    });
    let member: PatternIndexMember;
    try {
      member = await asRoot.redeemInvite(options.invite);
    } catch (error) {
      throw new Error(`The index refused the invite: ${redeemRefusal(error)}`);
    }
    await store.recordMembership({
      handle: member.handle,
      role: member.role,
      root: root.did(),
    });
    joined = true;
  }
  const client = await openPatternIndexClient({
    ...options,
    store,
    nowSeconds,
  });
  const member = await client.whoami();
  const recorded = (await store.membership())!;
  if (member.handle !== recorded.handle) {
    throw new Error(
      `The index sees ${options.signer.did()} as ${member.handle}, not as the member ${recorded.handle} this machine joined as`,
    );
  }
  return {
    handle: member.handle,
    role: member.role,
    root: recorded.root,
    signer: options.signer.did(),
    joined,
    storeDir: store.dir,
  };
}

/** Why a redemption failed, in the index's terms, never the request's. */
const redeemRefusal = (error: unknown): string => {
  const status = (error as { status?: unknown }).status;
  switch (status) {
    case 404:
      return "no such invite, or the code does not match it";
    case 409:
      return "the invite was already used, or this key is already a member";
    case 410:
      return "the invite has expired; ask for a new one";
    default:
      return describeFailure(error);
  }
};

export interface AdoptChainOptions extends PatternIndexAccessOptions {
  /** A chain from the member's root, ending at `signer`, root first. */
  chain: readonly Uint8Array[];
}

/**
 * Joins this machine to a membership rooted elsewhere: keeps `chain`, which
 * the root issued (`cf delegation issue --index` on the machine holding it),
 * once the index confirms it acts for a member. A second machine joins this
 * way rather than by a second invite, which would make a second member.
 *
 * @throws Error when the chain is not one the index would accept from
 *   `signer`, or the index does not answer for it as a member.
 */
export async function adoptIndexChain(
  options: AdoptChainOptions,
): Promise<JoinResult> {
  const store = options.store ??
    new PatternIndexStore(patternIndexStoreDir(options.baseUrl));
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const checked = await checkIndexChain(
    options.chain,
    options.signer.did(),
    nowSeconds,
  );
  const recorded = await store.membership();
  if (recorded !== undefined && recorded.root !== checked.root) {
    throw new Error(
      `This machine already holds a membership rooted at ${recorded.root}; the chain is rooted at ${checked.root}`,
    );
  }
  const client = new PatternIndexClient({
    baseUrl: options.baseUrl,
    signer: options.signer,
    proofs: indexProofs(options.chain),
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
  });
  const member = await client.whoami();
  await store.recordMembership({
    handle: member.handle,
    role: member.role,
    root: checked.root,
  });
  await store.recordChain(options.signer.did(), options.chain);
  return {
    handle: member.handle,
    role: member.role,
    root: checked.root,
    signer: options.signer.did(),
    joined: recorded === undefined,
    storeDir: store.dir,
  };
}
