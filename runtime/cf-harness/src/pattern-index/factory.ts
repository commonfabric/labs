/** Harness configuration and identity loading for the shared index client. */

import type { PatternIndexClient } from "@commonfabric/pattern-index/client";
import { openPatternIndexClient } from "@commonfabric/pattern-index/access";
import type { PatternIndexStore } from "@commonfabric/pattern-index/store";
import type { HarnessPatternIndexConfig } from "../config.ts";
import type { HarnessFetch } from "../contracts/http-fetch.ts";
import { loadHarnessIdentity } from "../identity-key.ts";

/**
 * Builds the run's pattern-index client. The engine caches a healthy result
 * so a factory is called at most once per run; a construction failure
 * surfaces as an ordinary tool-output error, and the next tool call invokes
 * the factory again.
 */
export type HarnessPatternIndexClientFactory = () => Promise<
  PatternIndexClient
>;

/**
 * Default factory over `config`. Requests are signed with the run's Fabric
 * identity — the index authorizes the same principal the run writes to its
 * space as — so the keyfile path comes from the fabric session config, which
 * is why a pattern index without one is a configuration error.
 *
 * The key acts for its member as `cf` does: it presents the `/index` chain
 * this machine's membership store keeps for it (renewing it there when the
 * root is kept here), so the index applies that member's settings, such as
 * whether they share, to the run's searches and publishes. A machine that
 * never joined presents nothing, and the key signs as its own root; a
 * machine whose chain cannot be built fails the call (see below).
 * `store` defaults to the store for the index's host in the user's state
 * directory, which is where `cf index join` put it.
 */
export const createHarnessPatternIndexClientFactory = (
  config: HarnessPatternIndexConfig,
  identityKeyPath: string,
  fetchFn?: HarnessFetch,
  store?: PatternIndexStore,
): HarnessPatternIndexClientFactory =>
async () => {
  const identity = await loadHarnessIdentity(identityKeyPath);
  try {
    return await openPatternIndexClient({
      baseUrl: config.baseUrl,
      signer: identity,
      ...(store !== undefined ? { store } : {}),
      ...(fetchFn !== undefined ? { fetchFn } : {}),
    });
  } catch (error) {
    // Never sign without the chain instead: the index would take the key as
    // a root of its own, so the run's publishes would belong to nobody the
    // person is, their sharing setting would not apply, and their use of a
    // piece would never find what the agent made for them. A run that cannot
    // act for its member makes no index call and says why.
    throw new Error(
      `pattern index: the run cannot act for its member, since the membership chain for its key could not be built: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
};

/**
 * Wraps `factory` so a healthy client is built once and shared by every
 * invocation in the run. An in-flight construction is shared too, but a
 * REJECTED construction clears the cache: the failure still reaches every
 * caller awaiting it, and the next tool call invokes the factory again rather
 * than replaying a terminal failure for the rest of the run.
 */
export const cacheHarnessPatternIndexClientFactory = (
  factory: HarnessPatternIndexClientFactory,
): HarnessPatternIndexClientFactory => {
  let client: Promise<PatternIndexClient> | undefined;
  return () => {
    if (client === undefined) {
      const attempt: Promise<PatternIndexClient> = Promise.resolve()
        .then(factory)
        .catch((error) => {
          if (client === attempt) {
            client = undefined;
          }
          throw error;
        });
      client = attempt;
    }
    return client;
  };
};
