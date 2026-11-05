/**
 * The fetch implementation the harness calls and that callers can substitute.
 *
 * The signature is written out because `typeof fetch` is not stable here: when
 * `@types/node`'s globals are in the type graph, it resolves to a type whose
 * `init` parameter has neither `signal` nor `body`.
 */
export type HarnessFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * The fetch a caller gets when it supplies none. Delegates to the global
 * `fetch`, resolved on each call so a replaced global is honored.
 */
export const defaultHarnessFetch: HarnessFetch = (input, init) =>
  fetch(input, init);
