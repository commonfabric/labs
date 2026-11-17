/**
 * How a GitHub Actions job proves to the pattern index which repository it
 * runs for, without a stored secret: a GitHub OIDC token whose audience is
 * the index's base URL. The index checks it against GitHub's published keys
 * and reads the repository, its owner, the branch, the event and the commit
 * from it.
 *
 * A token lives only minutes, so a sync mints one for each call rather than
 * holding one for the whole run.
 */

import type { PatternIndexFetch } from "./http-fetch.ts";

/**
 * Asks the Actions runtime for an OIDC token whose audience is `audience`.
 *
 * The runtime offers the request URL and its bearer token only to a job whose
 * workflow grants `id-token: write`, so their absence is reported as that
 * missing permission.
 *
 * @throws Error when the job lacks `id-token: write`, or when GitHub refuses
 *   or returns no token.
 */
export const mintGithubOidcToken = async (
  audience: string,
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
  url.searchParams.set("audience", audience);
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
