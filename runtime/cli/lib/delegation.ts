/**
 * Delegating a space to another key from the CLI: issuing the chain that key
 * presents to open the space, describing the chains a file holds, and holding
 * the chains named files carry when the CLI connects. The chain's shape, and
 * what the server makes of one, is `docs/specs/profile-delegation.md`.
 */

import {
  decodeDelegation,
  decodeDelegationChains,
  type Delegation,
  DelegationError,
  type DIDKey,
  type Identity,
  isCanonicalEd25519DID,
  issueDelegation,
} from "@commonfabric/identity";
import { MAX_PROOF_CHAIN_LENGTH } from "@commonfabric/memory/v2/session-open-auth";
import { DelegationStore } from "@commonfabric/runner/storage/delegation-store";

/** The command every chain the CLI issues covers: a whole space. */
export const DELEGATED_COMMAND = "/memory";

export interface IssueDelegationChainOptions {
  /** The key issuing the delegation: the chain's last issuer. */
  signer: Identity;

  /** The space the chain is over. */
  space: DIDKey;

  /** The key the chain ends at: the one that presents it. */
  to: DIDKey;

  /**
   * The chain the signer's own sessions present on `space`, root first, or
   * empty where the signer opens the space on its own grant: what the
   * storage manager holds for the space, from Home's records and the chain
   * files named, which `StorageManager.delegationChainFor` reports.
   */
  held: readonly Uint8Array[];

  /** The unix second the issued delegation stops holding; none by default. */
  expiresAt?: number;

  /** Current unix time in seconds (defaults to now). Injectable for tests. */
  nowSeconds?: number;
}

/**
 * Issues a delegation over `space` from `signer` to `to`, and returns the
 * chain `to` presents, root first: the delegation alone where the access
 * list grants the signer, and behind the chain the signer itself holds
 * where the signer holds the space through one, as the owner of a profile
 * does, or as a key delegated to in turn. The server resolves the
 * capability from the chain's root issuer, so `to` acts under the grant
 * the signer acts under.
 *
 * @throws A `DelegationError` for an audience that is not an ed25519
 *   `did:key` or is the signer itself, an expiry already past, a held
 *   chain that does not decode or does not end at the signer, or a held
 *   chain already as long as a holder may present, which another link
 *   would make one no holder could present.
 */
export async function issueDelegationChain(
  options: IssueDelegationChainOptions,
): Promise<Uint8Array[]> {
  const { signer, space, to, held, expiresAt } = options;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!isCanonicalEd25519DID(to)) {
    throw new DelegationError(`"${to}" is not an ed25519 did:key`);
  }
  if (to === signer.did()) {
    throw new DelegationError("the audience is the issuing key itself");
  }
  if (expiresAt !== undefined && expiresAt <= now) {
    throw new DelegationError("the expiry is not after now");
  }
  if (held.length >= MAX_PROOF_CHAIN_LENGTH) {
    throw new DelegationError(
      `the chain would be longer than ${MAX_PROOF_CHAIN_LENGTH} delegations, which no holder presents`,
    );
  }
  if (held.length > 0) {
    const last = await decodeDelegation(held[held.length - 1]);
    if (last.payload.aud !== signer.did()) {
      throw new DelegationError("the held chain does not end at the signer");
    }
  }
  const issued = await issueDelegation(signer, {
    aud: to,
    sub: space,
    cmd: DELEGATED_COMMAND,
    pol: [],
    exp: expiresAt ?? null,
  });
  return [...held, issued.bytes];
}

/** One delegation of a chain, as `cf delegation show` describes it. */
export interface DelegationLinkRow {
  /** The chain's position in the file, from 0. */
  chain: number;

  /** The delegation's position in the chain, from 0 at the root. */
  link: number;

  /** The delegation's CID, or `""` for bytes that are not a delegation. */
  cid: string;

  /** The issuer's DID, or `""` for bytes that are not a delegation. */
  issuer: string;

  /** The audience's DID, or `""` for bytes that are not a delegation. */
  audience: string;

  /** The space delegated, or `null` for any subject or undecodable bytes. */
  subject: string | null;

  /** The command path, or `""` for bytes that are not a delegation. */
  command: string;

  /** The unix second the delegation stops holding, or `null` for never. */
  expires: number | null;

  /** The unix second the delegation starts holding, where it names one. */
  notBefore?: number;

  /**
   * `true` for a delegation in a chain a runtime would hold and present
   * now, as {@link checkPresentableChain} judges it. Otherwise why the
   * chain would be refused, or held but not presented, on each of its rows.
   */
  verified: true | string;
}

/**
 * Holds `chain` to the rules a runtime applies to a chain it is handed and
 * then to one it presents, both through a `DelegationStore` of its own:
 * `add` decodes and verifies every link, checks each is issued by the
 * previous audience, that all are over one space, and that the chain is no
 * longer than the server admits; `chainFor` then checks that every link
 * holds at `nowSeconds` and covers opening a space. Returns the decoded
 * chain. Whom the chain ends at is the caller's to judge.
 *
 * @throws A `DelegationError` saying what is wrong with the chain.
 */
async function checkPresentableChain(
  chain: readonly Uint8Array[],
  nowSeconds: number,
): Promise<readonly Delegation[]> {
  const store = new DelegationStore();
  const decoded = await store.add(chain);
  const { sub } = decoded[0].payload;
  const { aud } = decoded[decoded.length - 1].payload;
  if (sub === null || store.chainFor(sub, aud, nowSeconds) === undefined) {
    throw new DelegationError(
      "no session presents the chain now: a delegation in it has expired, is not yet valid, or does not cover opening a space",
    );
  }
  return decoded;
}

/**
 * Describes each delegation of each chain, holding each chain to the rules
 * a runtime applies to a chain it holds and presents
 * ({@link checkPresentableChain}) at `nowSeconds`, by default now, without
 * refusing any: a chain that would not be presented is described with what
 * is wrong with it, on each of its rows. A link that does not decode is a
 * row with its position, the reason, and nothing else known.
 */
export async function describeDelegationChains(
  chains: readonly (readonly Uint8Array[])[],
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<DelegationLinkRow[]> {
  const rows: DelegationLinkRow[] = [];
  for (const [chain, links] of chains.entries()) {
    let verified: true | string = true;
    try {
      await checkPresentableChain(links, nowSeconds);
    } catch (error) {
      verified = error instanceof Error ? error.message : String(error);
    }
    for (const [link, bytes] of links.entries()) {
      let delegation: Delegation;
      try {
        delegation = await decodeDelegation(bytes);
      } catch (error) {
        rows.push({
          chain,
          link,
          cid: "",
          issuer: "",
          audience: "",
          subject: null,
          command: "",
          expires: null,
          verified: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const { payload } = delegation;
      rows.push({
        chain,
        link,
        cid: delegation.cid,
        issuer: payload.iss,
        audience: payload.aud,
        subject: payload.sub,
        command: payload.cmd,
        expires: payload.exp,
        ...(payload.nbf === undefined ? {} : { notBefore: payload.nbf }),
        verified,
      });
    }
  }
  return rows;
}

/**
 * Reads the chains the file at `path` holds. Throws naming the file for one
 * that cannot be read or is not a chain file.
 */
export async function readDelegationChainFile(
  path: string,
): Promise<Uint8Array[][]> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    throw new Error(
      `Could not read the delegation chain file ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  try {
    return decodeDelegationChains(text);
  } catch (error) {
    throw new Error(
      `${path} is not a delegation chain file: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * What holds a chain: a storage manager, through `addDelegationChain`, which
 * one whose sessions present no proof chain does not have.
 */
export interface DelegationChainHolder {
  addDelegationChain?(chain: readonly Uint8Array[]): Promise<void>;
}

/**
 * Hands `holder` every chain the files at `paths` carry, in order, and
 * returns how many. Throws for a holder whose sessions present no chain,
 * and naming the file and the chain for one that no session presents at
 * `nowSeconds`, by default now ({@link checkPresentableChain}), one that
 * ends at a key other than `principal`, which no session of the holder's
 * could present, or one the holder refuses; the chains before it are held.
 * A chain file is named by its caller, so a chain in it that cannot be held
 * is an error rather than a warning.
 */
export async function holdDelegationChainFiles(
  holder: DelegationChainHolder,
  paths: readonly string[],
  principal: DIDKey,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<number> {
  if (paths.length === 0) return 0;
  const add = holder.addDelegationChain;
  if (add === undefined) {
    throw new Error(
      "This connection's sessions present no proof chain, so a delegation chain file cannot be held",
    );
  }
  let held = 0;
  for (const path of paths) {
    const chains = await readDelegationChainFile(path);
    for (const [i, chain] of chains.entries()) {
      const refused = (reason: string): Error =>
        new Error(`Chain ${i} of ${path} cannot be held: ${reason}`);
      let decoded: readonly Delegation[];
      try {
        decoded = await checkPresentableChain(chain, nowSeconds);
      } catch (error) {
        throw refused(error instanceof Error ? error.message : String(error));
      }
      const { aud } = decoded[decoded.length - 1].payload;
      if (aud !== principal) {
        throw refused(`it ends at ${aud}, not at the identity ${principal}`);
      }
      try {
        await add.call(holder, chain);
      } catch (error) {
        throw refused(error instanceof Error ? error.message : String(error));
      }
      held += 1;
    }
  }
  return held;
}
