/**
 * How `cf` reaches the pattern index as the person: which index, the client
 * that signs with the `cf` identity and presents the chain from the
 * person's index root, and joining by invite.
 *
 * The chain's last link may hold for at most 90 days, so while the root key
 * is kept on this machine a client renews it whenever it has under a week
 * left; a person who joined here never sees a chain lapse.
 */

import { type DIDKey, type Identity } from "@commonfabric/identity";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import {
  type PatternIndexMember,
  PatternIndexClient,
} from "@commonfabric/pattern-index/client";
import type { PatternIndexFetch } from "@commonfabric/pattern-index/http-fetch";
import {
  checkIndexChain,
  indexProofs,
  issueIndexChain,
} from "@commonfabric/pattern-index/membership";
import {
  PatternIndexStore,
  patternIndexStoreDir,
} from "./pattern-index-store.ts";

/** The pattern index this deployment's builders publish to. */
export const DEFAULT_PATTERN_INDEX_URL =
  "https://us-central1-pattern-index.cloudfunctions.net";

/** A chain with less than this left is renewed from the local root. */
export const RENEW_WITHIN_SECONDS = 7 * 24 * 60 * 60;

/**
 * The index to use: the flag, else `CF_PATTERN_INDEX_URL`, else the
 * deployment's.
 */
export const resolvePatternIndexUrl = (
  flag: string | undefined,
  env: (key: string) => string | undefined = (key) => Deno.env.get(key),
): string => {
  const chosen = flag?.trim() || env("CF_PATTERN_INDEX_URL")?.trim() ||
    DEFAULT_PATTERN_INDEX_URL;
  const url = URL.parse(chosen);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new Error(`The pattern index URL must be http(s): ${chosen}`);
  }
  return chosen;
};

export interface PatternIndexAccessOptions {
  baseUrl: string;

  /** The `cf` identity: the key every call is signed with. */
  signer: Identity<DIDKey>;

  /** Defaults to the store for `baseUrl` in the user's state directory. */
  store?: PatternIndexStore;

  fetchFn?: PatternIndexFetch;

  /** Current unix time in seconds; injectable for tests. */
  nowSeconds?: number;
}

/**
 * The chain `signer` presents, renewed from the kept root when it is
 * missing, unusable, or close to lapsing; `undefined` when this machine
 * holds no membership, so the signer acts as its own root (or as a key the
 * index admitted before chains).
 */
export async function chainForSigner(
  store: PatternIndexStore,
  signer: Identity<DIDKey>,
  nowSeconds: number,
): Promise<Uint8Array[] | undefined> {
  const membership = await store.membership();
  if (membership === undefined) return undefined;
  if (membership.root === signer.did()) return undefined;
  const held = await store.chainFor(signer.did());
  if (held !== undefined) {
    try {
      const checked = await checkIndexChain(held, signer.did(), nowSeconds);
      if (
        checked.root === membership.root &&
        checked.signerLinkExpires !== null &&
        checked.signerLinkExpires - nowSeconds > RENEW_WITHIN_SECONDS
      ) {
        return held;
      }
    } catch {
      // Unusable now; renewed below when the root is here.
    }
  }
  const root = await store.rootKey();
  if (root === undefined || root.did() !== membership.root) {
    // The root lives elsewhere (another machine, or a Loom). Send what is
    // held and let the index say whether it still holds.
    return held;
  }
  const chain = await issueIndexChain({
    issuer: root,
    to: signer.did(),
    held: [],
    nowSeconds,
  });
  await store.recordChain(signer.did(), chain);
  return chain;
}

/** A client signing as `signer` and presenting its chain when it holds one. */
export async function openPatternIndexClient(
  options: PatternIndexAccessOptions,
): Promise<PatternIndexClient> {
  const store = options.store ??
    new PatternIndexStore(patternIndexStoreDir(options.baseUrl));
  const chain = await chainForSigner(
    store,
    options.signer,
    options.nowSeconds ?? Math.floor(Date.now() / 1000),
  );
  return new PatternIndexClient({
    baseUrl: options.baseUrl,
    signer: options.signer,
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    ...(chain === undefined ? {} : { proofs: indexProofs(chain) }),
  });
}

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
  const client = await openPatternIndexClient({ ...options, store, nowSeconds });
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
