/**
 * Issuing pattern-index delegations from `cf delegation issue --index`: the
 * chain another key (a Loom instance, a second machine, an agent) presents
 * to act for the person's membership, and the single-use delegation that
 * moves the membership's root.
 */

import {
  DelegationError,
  type DIDKey,
  type Identity,
} from "@commonfabric/identity";
import {
  checkIndexChain,
  INDEX_COMMAND,
  INDEX_ROOT_COMMAND,
  issueIndexChain,
  issueRootMove,
} from "@commonfabric/pattern-index/membership";
import {
  PatternIndexStore,
  patternIndexStoreDir,
} from "@commonfabric/pattern-index/store";
import { chainForSigner } from "@commonfabric/pattern-index/access";

/** `member`: an `/index` chain. `root-move`: a single `/index/root` link. */
export type IndexDelegationKind = "member" | "root-move";

export interface IssueIndexDelegationOptions {
  kind: IndexDelegationKind;
  baseUrl: string;

  /**
   * The `cf` identity: the root itself after a root move, or the key that
   * issues behind its own chain where the root is kept elsewhere. Not
   * needed where the root key is kept on this machine.
   */
  identity?: Identity<DIDKey>;

  /** The DID the chain ends at. */
  to: string;

  expiresAt?: number;
  store?: PatternIndexStore;
  nowSeconds?: number;
}

export interface IssuedIndexDelegation {
  chain: Uint8Array[];
  command: string;
  root: DIDKey;
  expires: number | null;
}

/**
 * Issues from the kept index root where there is one, so the chain is one
 * link long; otherwise behind the chain the identity holds, which only an
 * `/index` chain can be, since only the root itself moves the root.
 *
 * @throws DelegationError when this machine holds no membership, when a
 *   root move is asked for without the root, or for anything
 *   `issueIndexChain` refuses.
 */
export async function issueIndexDelegation(
  options: IssueIndexDelegationOptions,
): Promise<IssuedIndexDelegation> {
  const store = options.store ??
    new PatternIndexStore(patternIndexStoreDir(options.baseUrl));
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const membership = await store.membership();
  if (membership === undefined) {
    throw new DelegationError(
      "This machine holds no pattern-index membership: run `cf index join` first",
    );
  }
  const to = options.to as DIDKey;
  const kept = await store.rootKey();
  const root = kept !== undefined && kept.did() === membership.root
    ? kept
    : options.identity?.did() === membership.root
    ? options.identity
    : undefined;
  if (options.kind === "root-move") {
    if (root === undefined) {
      throw new DelegationError(
        "Only the root moves the root, and it is not kept on this machine",
      );
    }
    const move = await issueRootMove({
      root,
      to,
      nowSeconds: now,
      ...(options.expiresAt === undefined
        ? {}
        : { expiresAt: options.expiresAt }),
    });
    return {
      chain: [move.bytes],
      command: INDEX_ROOT_COMMAND,
      root: root.did(),
      expires: move.payload.exp,
    };
  }
  const issuer = root ?? options.identity;
  if (issuer === undefined) {
    throw new DelegationError(
      "The root is not kept on this machine; name the identity that issues behind its chain with --identity",
    );
  }
  const held = root !== undefined
    ? []
    : await chainForSigner(store, issuer, now);
  if (held === undefined) {
    throw new DelegationError(
      `${issuer.did()} holds no chain to issue onward from`,
    );
  }
  const chain = await issueIndexChain({
    issuer,
    to,
    held,
    nowSeconds: now,
    ...(options.expiresAt === undefined
      ? {}
      : { expiresAt: options.expiresAt }),
  });
  const checked = await checkIndexChain(chain, to, now);
  return {
    chain,
    command: INDEX_COMMAND,
    root: checked.root,
    expires: checked.expires,
  };
}
