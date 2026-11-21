/**
 * The scope-key vocabulary of the currency index
 * (docs/specs/server-side-execution/serving-loop.md §3b), kept apart from
 * the index so that a serving runtime, which names slices and instances
 * without holding a store, can import it without the store's engine.
 */

import { identityOfScopeKey, resolveScopeKey, scopeOfScopeKey } from "../v2.ts";

/** The slice every recorded piece has, and the scope key of a shared instance. */
export const SPACE_SLICE = "space";

/**
 * The scope key of a read whose instance the recording loop could not name.
 * A change to any instance of the document is ahead of such a read.
 */
export const ANY_INSTANCE = "*";

/**
 * `key` and each broader scope key an instance at `key` is resolved under,
 * narrowest first: a session's key, its user's, and the space.
 */
export const sliceChain = (key: string): string[] => {
  if (key === SPACE_SLICE) return [SPACE_SLICE];
  if (scopeOfScopeKey(key) !== "session") return [key, SPACE_SLICE];
  const identity = identityOfScopeKey(key);
  return identity === undefined
    ? [key, SPACE_SLICE]
    : [key, resolveScopeKey("user", identity), SPACE_SLICE];
};
