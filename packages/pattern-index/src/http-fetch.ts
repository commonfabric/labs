/** The replaceable HTTP transport for pattern-index clients. */

/**
 * Fetch's web signature, independent of Node's ambient overloads, which can
 * omit `body` and `signal` from their request options.
 */
export type PatternIndexFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
