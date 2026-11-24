/**
 * How a key reaches the pattern index as a person: which index, and the
 * client that signs with that key and presents the chain from the person's
 * index root, kept in the local membership store.
 *
 * The chain's last link may hold for at most 90 days, so while the root key
 * is kept on this machine a client renews it whenever it has under a week
 * left; a person who joined here never sees a chain lapse.
 */

import type { DIDKey, Identity } from "@commonfabric/identity";
import { PatternIndexClient } from "./client.ts";
import type { PatternIndexFetch } from "./http-fetch.ts";
import { checkIndexChain, indexProofs, issueIndexChain } from "./membership.ts";
import { PatternIndexStore, patternIndexStoreDir } from "./store.ts";

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
  // The client appends a function name to the base's path, and the store is
  // kept per host, so a query or fragment could only misaddress both.
  if (url.search !== "" || url.hash !== "") {
    throw new Error(
      `The pattern index URL must not carry a query or fragment: ${chosen}`,
    );
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
  let held: Uint8Array[] | undefined;
  try {
    // Reading decodes the stored links, so a corrupt value fails here and
    // is renewed below like any other unusable chain.
    held = await store.chainFor(signer.did());
  } catch {
    held = undefined;
  }
  if (held !== undefined) {
    try {
      const checked = await checkIndexChain(held, signer.did(), nowSeconds);
      if (
        checked.root === membership.root &&
        checked.expires !== null &&
        checked.expires - nowSeconds > RENEW_WITHIN_SECONDS
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
  try {
    await store.recordChain(signer.did(), chain);
  } catch {
    // A store this process may not write (a read-only grant, a full disk)
    // costs only the renewal's persistence: the chain issued now is valid
    // and is presented anyway.
  }
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
