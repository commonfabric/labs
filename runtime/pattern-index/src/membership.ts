/**
 * The delegation chains a pattern-index member acts through.
 *
 * The index knows each member by one key, its root. Every other key the
 * person uses (`cf`, a loom host, an agent) presents a chain of labs UCAN
 * delegations from that root on each call, as the client's `proofs`. The
 * index checks such a chain the way labs' memory server checks one for a
 * space, with rules of its own that this module mirrors so a client refuses
 * to issue or send a chain the index would refuse:
 *
 * - at most {@link MAX_INDEX_CHAIN_LENGTH} links;
 * - the first link is the root's own (`iss === sub`), and every link's `sub`
 *   is the root, never `null`;
 * - every link's `cmd` is exactly {@link INDEX_COMMAND}, not `/`: a broad
 *   delegation issued for something else, such as a space whose DID is the
 *   same key, never doubles as index access;
 * - each link is issued by the previous link's audience, and the last
 *   audience is the signing key;
 * - the link to the signing key expires within
 *   {@link MAX_SIGNER_LINK_SECONDS}; earlier links may be open-ended.
 *
 * A root move is a different command, {@link INDEX_ROOT_COMMAND}, so an
 * ordinary chain to a device can never hand the member to that device.
 */

import {
  decodeDelegation,
  type Delegation,
  DelegationError,
  type DIDKey,
  type Identity,
  isCanonicalEd25519DID,
  issueDelegation,
  verifyDelegation,
} from "@commonfabric/identity";
import { toUnpaddedBase64url } from "@commonfabric/bytes/base64url";

/** The one command every link of a member's chain carries. */
export const INDEX_COMMAND = "/index";

/** The command of a single-use delegation that moves a member's root. */
export const INDEX_ROOT_COMMAND = "/index/root";

/** The longest chain the index accepts. */
export const MAX_INDEX_CHAIN_LENGTH = 8;

/** How long the link to the signing key may hold: 90 days. */
export const MAX_SIGNER_LINK_SECONDS = 90 * 24 * 60 * 60;

/**
 * How long a link to a signing key is issued for by default: an hour short
 * of the most the index accepts, so a clock running ahead of the index's
 * does not make a link issued this moment one it refuses.
 */
export const DEFAULT_SIGNER_LINK_SECONDS = MAX_SIGNER_LINK_SECONDS - 60 * 60;

const nowInSeconds = (): number => Math.floor(Date.now() / 1000);

export interface IssueIndexChainOptions {
  /** The key issuing the new link: the root, or a key the root delegated to. */
  issuer: Identity<DIDKey>;

  /** The key the chain ends at, which signs calls with it. */
  to: DIDKey;

  /**
   * The chain `issuer` itself acts through, root first, or empty where the
   * issuer is the root.
   */
  held: readonly Uint8Array[];

  /**
   * When the new link stops holding, in unix seconds. Defaults to
   * {@link DEFAULT_SIGNER_LINK_SECONDS} from now.
   */
  expiresAt?: number;

  /** Current unix time in seconds; injectable for tests. */
  nowSeconds?: number;
}

/**
 * Issues an `/index` link from `issuer` to `to` about the member's root and
 * returns the whole chain `to` presents, root first.
 *
 * @throws DelegationError when `to` is not an ed25519 `did:key` or is the
 *   issuer, when the expiry is not after now or is further off than the
 *   index accepts for the signer's link, when `held` is not a chain the
 *   index would accept ending at `issuer`, or when another link would make
 *   it longer than the index accepts.
 */
export async function issueIndexChain(
  options: IssueIndexChainOptions,
): Promise<Uint8Array[]> {
  const { issuer, to, held } = options;
  const now = options.nowSeconds ?? nowInSeconds();
  const expiresAt = options.expiresAt ?? now + DEFAULT_SIGNER_LINK_SECONDS;
  checkAudience(issuer, to);
  checkSignerExpiry(expiresAt, now);
  if (held.length >= MAX_INDEX_CHAIN_LENGTH) {
    throw new DelegationError(
      `the chain would be longer than ${MAX_INDEX_CHAIN_LENGTH} delegations, which the index refuses`,
    );
  }
  let root: DIDKey = issuer.did();
  if (held.length > 0) {
    // The held chain's last link is no longer the signer's, so the 90-day
    // bound does not apply to it; every link must still hold now.
    const checked = await checkIndexChainLinks(held, now, issuer.did(), {
      signerLinkBound: false,
    });
    root = checked.root;
  }
  const issued = await issueDelegation(issuer, {
    aud: to,
    sub: root,
    cmd: INDEX_COMMAND,
    pol: [],
    exp: expiresAt,
  });
  return [...held, issued.bytes];
}

export interface IssueRootMoveOptions {
  /** The member's current root. */
  root: Identity<DIDKey>;

  /** The key that becomes the root; it signs the `moveRoot` call. */
  to: DIDKey;

  /** Defaults to {@link DEFAULT_SIGNER_LINK_SECONDS} from now. */
  expiresAt?: number;

  nowSeconds?: number;
}

/**
 * Issues the single-use delegation `moveRoot` takes: from the current root
 * to the new one, about the root, for {@link INDEX_ROOT_COMMAND}.
 *
 * @throws DelegationError as {@link issueIndexChain} does for its audience
 *   and expiry.
 */
export async function issueRootMove(
  options: IssueRootMoveOptions,
): Promise<Delegation> {
  const now = options.nowSeconds ?? nowInSeconds();
  const expiresAt = options.expiresAt ?? now + DEFAULT_SIGNER_LINK_SECONDS;
  checkAudience(options.root, options.to);
  checkSignerExpiry(expiresAt, now);
  return await issueDelegation(options.root, {
    aud: options.to,
    sub: options.root.did(),
    cmd: INDEX_ROOT_COMMAND,
    pol: [],
    exp: expiresAt,
  });
}

/** What a chain the index would accept says about who acts. */
export interface CheckedIndexChain {
  /** The member's root: the first link's issuer and every link's subject. */
  root: DIDKey;

  /** The decoded links, root first. */
  links: readonly Delegation[];

  /** When the link to the signer stops holding, in unix seconds. */
  signerLinkExpires: number | null;

  /** When the whole chain stops holding: its earliest expiry, or `null`. */
  expires: number | null;
}

/**
 * Holds `chain` to the rules the index applies to a member's chain
 * presented by `signer` at `nowSeconds`, by default now.
 *
 * @throws DelegationError naming the first rule the chain breaks.
 */
export async function checkIndexChain(
  chain: readonly Uint8Array[],
  signer: DIDKey,
  nowSeconds: number = nowInSeconds(),
): Promise<CheckedIndexChain> {
  return await checkIndexChainLinks(chain, nowSeconds, signer, {
    signerLinkBound: true,
  });
}

async function checkIndexChainLinks(
  chain: readonly Uint8Array[],
  now: number,
  endsAt: DIDKey,
  options: { signerLinkBound: boolean },
): Promise<CheckedIndexChain> {
  if (chain.length === 0) {
    throw new DelegationError("the chain is empty");
  }
  if (chain.length > MAX_INDEX_CHAIN_LENGTH) {
    throw new DelegationError(
      `the chain is longer than ${MAX_INDEX_CHAIN_LENGTH} delegations`,
    );
  }
  const links: Delegation[] = [];
  for (const [i, bytes] of chain.entries()) {
    let link: Delegation;
    try {
      link = await decodeDelegation(bytes);
      await verifyDelegation(link);
    } catch (error) {
      throw new DelegationError(
        `link ${i} is not a delegation that verifies: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    links.push(link);
  }
  const root = links[0].payload.iss;
  for (const [i, { payload }] of links.entries()) {
    if (payload.sub !== root) {
      throw new DelegationError(
        i === 0
          ? "the first link is not the root's own (its issuer is not its subject)"
          : `link ${i} is about another subject than the root`,
      );
    }
    if (payload.cmd !== INDEX_COMMAND) {
      throw new DelegationError(
        `link ${i} is for ${payload.cmd}, not exactly ${INDEX_COMMAND}`,
      );
    }
    if (i > 0 && payload.iss !== links[i - 1].payload.aud) {
      throw new DelegationError(
        `link ${i} is not issued by the previous link's audience`,
      );
    }
    if (payload.nbf !== undefined && payload.nbf > now) {
      throw new DelegationError(`link ${i} is not valid yet`);
    }
    if (payload.exp !== null && payload.exp <= now) {
      throw new DelegationError(`link ${i} has expired`);
    }
  }
  const signerLink = links[links.length - 1].payload;
  if (signerLink.aud !== endsAt) {
    throw new DelegationError(
      `the chain ends at ${signerLink.aud}, not at ${endsAt}`,
    );
  }
  if (
    options.signerLinkBound &&
    (signerLink.exp === null || signerLink.exp > now + MAX_SIGNER_LINK_SECONDS)
  ) {
    throw new DelegationError(
      "the link to the signing key does not expire within 90 days",
    );
  }
  const expiries = links.flatMap(({ payload }) =>
    payload.exp === null ? [] : [payload.exp]
  );
  return {
    root,
    links,
    signerLinkExpires: signerLink.exp,
    expires: expiries.length === 0
      ? null
      : expiries.reduce((a, b) => Math.min(a, b)),
  };
}

/** A chain as the client's `proofs`: each link in unpadded base64url. */
export const indexProofs = (chain: readonly Uint8Array[]): string[] =>
  chain.map(toUnpaddedBase64url);

const checkAudience = (issuer: Identity<DIDKey>, to: DIDKey): void => {
  if (!isCanonicalEd25519DID(to)) {
    throw new DelegationError(`"${to}" is not an ed25519 did:key`);
  }
  if (to === issuer.did()) {
    throw new DelegationError("the audience is the issuing key itself");
  }
};

const checkSignerExpiry = (expiresAt: number, now: number): void => {
  if (expiresAt <= now) {
    throw new DelegationError("the expiry is not after now");
  }
  if (expiresAt > now + MAX_SIGNER_LINK_SECONDS) {
    throw new DelegationError(
      "the index accepts a link to the signing key only if it expires within 90 days",
    );
  }
};
