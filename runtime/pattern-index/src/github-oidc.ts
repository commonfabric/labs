/**
 * How a GitHub Actions job proves to the pattern index which repository it
 * runs for, without a stored secret.
 *
 * The job makes a key that lives only as long as the job and asks GitHub for
 * an OIDC token whose audience names the index's host and that key's DID.
 * The index checks the token against GitHub's published keys, reads the
 * repository and its owner from it, and requires the CF1 signature on the
 * request to be by the key the audience names. A token copied out of a job is
 * then useless on its own: whoever holds it would also need the key, which
 * never leaves the job's memory.
 */

import type { PatternIndexFetch } from "./http-fetch.ts";

/**
 * The audience a token for `did` to present to the index at `indexUrl`
 * carries: `pattern-index:<host>:<did>`. The host keeps a token minted for
 * one deployment, such as a staging index, from being accepted by another.
 */
export const githubOidcAudience = (indexUrl: string, did: string): string =>
  `pattern-index:${new URL(indexUrl).host}:${did}`;

/**
 * Asks the Actions runtime for an OIDC token whose audience is
 * {@link githubOidcAudience} for `indexUrl` and `did`.
 *
 * The runtime offers the request URL and its bearer token only to a job whose
 * workflow grants `id-token: write`, so their absence is reported as that
 * missing permission.
 *
 * @throws Error when the job lacks `id-token: write`, or when GitHub refuses
 *   or returns no token.
 */
export const mintGithubOidcToken = async (
  indexUrl: string,
  did: string,
  env: (key: string) => string | undefined,
  fetchFn: PatternIndexFetch = (input, init) => fetch(input, init),
): Promise<string> => {
  const requestUrl = env("ACTIONS_ID_TOKEN_REQUEST_URL");
  const requestToken = env("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
  if (requestUrl === undefined || requestToken === undefined) {
    throw new Error(
      "No GitHub OIDC token is available: the workflow must grant `permissions: id-token: write` to this job.",
    );
  }
  const url = new URL(requestUrl);
  url.searchParams.set("audience", githubOidcAudience(indexUrl, did));
  const response = await fetchFn(url, {
    headers: { Authorization: `Bearer ${requestToken}` },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub refused the OIDC token request (HTTP ${response.status}).`,
    );
  }
  const answer: unknown = await response.json();
  const value = typeof answer === "object" && answer !== null
    ? Object.getOwnPropertyDescriptor(answer, "value")?.value
    : undefined;
  if (typeof value !== "string" || value === "") {
    throw new Error("GitHub's OIDC answer carried no token.");
  }
  return value;
};
