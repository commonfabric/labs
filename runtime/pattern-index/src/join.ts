/**
 * Joining the pattern index: redeeming an invite with a key made for the
 * index alone, or adopting a chain the person's root issued on another
 * machine. `cf index join` and Loom's helper (`cli.ts`) both join this way,
 * into the same local store, so one person ends with one root whichever
 * they ran first.
 */

import { decodeDelegation, type DIDKey } from "@commonfabric/identity";
import { toUnpaddedBase64url } from "@commonfabric/bytes/base64url";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import { PatternIndexClient, type PatternIndexMember } from "./client.ts";
import {
  openPatternIndexClient,
  type PatternIndexAccessOptions,
} from "./access.ts";
import {
  checkIndexChain,
  INDEX_ROOT_COMMAND,
  indexProofs,
} from "./membership.ts";
import { PatternIndexStore, patternIndexStoreDir } from "./store.ts";

/** An invite as its link carries it. */
export interface IndexInvite {
  inviteId: string;
  code: string;
}

/**
 * A join refused, with the HTTP-style status a caller answering in the
 * helper's shape reports: 400 for a link or chain that is not one, 409 for a
 * membership that conflicts with the one already kept here, and the index's
 * own status for a redemption it refused. The message never quotes the
 * invite code.
 */
export class JoinError extends Error {
  override name = "JoinError";
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * The invite in `link`: `invite=` in its query and `code=` in its fragment,
 * as `createInvite` writes it.
 *
 * @throws JoinError (400) that never quotes the link, since it carries the
 *   code.
 */
export const parseInviteLink = (link: string): IndexInvite => {
  const url = URL.parse(link.trim());
  if (url === null) {
    throw new JoinError(400, "The invite is not a link");
  }
  const inviteId = url.searchParams.get("invite");
  const code = new URLSearchParams(url.hash.replace(/^#/, "")).get("code");
  if (!inviteId || !code) {
    throw new JoinError(
      400,
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

  /** Where the membership record and chains are kept. */
  storeDir: string;

  /**
   * Whether the root key itself is kept in `storeDir`, so backing that
   * directory up keeps the membership. False where this machine holds only
   * a chain from a root kept elsewhere, or where the root is the signer.
   */
  rootKeptHere: boolean;
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
    const kept = await store.rootKey();
    const root = kept ?? await store.createRootKey();
    const asRoot = new PatternIndexClient({
      baseUrl: options.baseUrl,
      signer: root,
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    });
    let member: PatternIndexMember | undefined;
    if (kept !== undefined) {
      // A root kept without a membership is one whose redemption may have
      // landed without its answer arriving. Asking first keeps a second
      // redemption from being refused as already used, which would leave
      // the key a member nobody here could record.
      member = await asRoot.whoami().catch(() => undefined);
    }
    try {
      member ??= await asRoot.redeemInvite(options.invite);
    } catch (error) {
      throw new JoinError(
        redeemStatus(error),
        `The index refused the invite: ${redeemRefusal(error)}`,
      );
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
    throw new JoinError(
      409,
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
    rootKeptHere: (await store.rootKey())?.did() === recorded.root,
  };
}

/** The status a refused redemption reports: the index's own, or 502. */
const redeemStatus = (error: unknown): number => {
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500
    ? status
    : 502;
};

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
  let checked;
  try {
    checked = await checkIndexChain(
      options.chain,
      options.signer.did(),
      nowSeconds,
    );
  } catch (error) {
    throw new JoinError(
      400,
      `The chain is not one the index accepts from ${options.signer.did()}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const recorded = await store.membership();
  if (recorded !== undefined && recorded.root !== checked.root) {
    throw new JoinError(
      409,
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
    // A root made here by an earlier join may also have issued this chain.
    rootKeptHere: (await store.rootKey())?.did() === checked.root,
  };
}

export interface MoveRootOptions extends PatternIndexAccessOptions {
  /**
   * The single-use `/index/root` delegation from the current root to
   * `signer`, as `cf delegation issue --index-root` issues it.
   */
  rootDelegation: Uint8Array;
}

/**
 * Makes `signer` its member's root, presenting the current root's consent,
 * and records the membership as rooted here. A chain issued from the old
 * root stops working: the index keeps one root per member.
 *
 * @throws JoinError (400) for a delegation that is not a root move to
 *   `signer`, or with the index's status when it refuses the move.
 */
export async function moveMembershipRoot(
  options: MoveRootOptions,
): Promise<JoinResult> {
  const store = options.store ??
    new PatternIndexStore(patternIndexStoreDir(options.baseUrl));
  let move;
  try {
    move = await decodeDelegation(options.rootDelegation);
  } catch {
    throw new JoinError(400, "The root delegation is not a delegation");
  }
  if (
    move.payload.cmd !== INDEX_ROOT_COMMAND ||
    move.payload.aud !== options.signer.did() ||
    move.payload.sub !== move.payload.iss
  ) {
    throw new JoinError(
      400,
      `The delegation does not move a root to ${options.signer.did()}`,
    );
  }
  const client = new PatternIndexClient({
    baseUrl: options.baseUrl,
    signer: options.signer,
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
  });
  // A move whose answer was lost has spent its delegation, so a rerun is
  // refused in terms that also fit a bad delegation. Only a move this
  // machine already sent with this very delegation is finished by asking
  // whether the signer is now the root.
  const resuming = await store.pendingRootMove() === move.cid;
  await store.recordPendingRootMove(move.cid);
  let member: PatternIndexMember | undefined;
  try {
    member = await client.moveRoot({
      rootDelegation: toUnpaddedBase64url(options.rootDelegation),
    });
  } catch (error) {
    if (resuming) member = await client.whoami().catch(() => undefined);
    if (member === undefined) {
      throw new JoinError(
        redeemStatus(error),
        `The index refused the move: ${describeFailure(error)}`,
      );
    }
  }
  await store.recordMembership({
    handle: member.handle,
    role: member.role,
    root: options.signer.did(),
  });
  await store.recordPendingRootMove(undefined);
  return {
    handle: member.handle,
    role: member.role,
    root: options.signer.did(),
    signer: options.signer.did(),
    joined: false,
    storeDir: store.dir,
    rootKeptHere: false,
  };
}
