/**
 * A stand-in for GitHub's workflow-run attempt endpoints, for the tests of the
 * tiles that read a run's earlier attempts and the job count of a cancelled
 * one.
 */

import type { Ctx, Run, Tile, TileView } from "../types.ts";

/**
 * What the stand-in answers one request with: an attempt, a job listing, or
 * an `Error` that rejects the request.
 */
export type GithubAnswer =
  | Run
  | { readonly total_count: unknown; readonly jobs?: unknown }
  | Error;

/**
 * Runs `body` with `fetch` standing in for GitHub's workflow-run attempt
 * endpoints: an attempt, and an attempt's job listing. Every request is
 * answered with `response`, or with what `response` returns for the request's
 * URL, as a JSON body, and an `Error` rejects the request. None reaches the
 * network, whatever token the environment holds. `body` receives the URLs
 * requested so far, in order, and what it resolves to is returned.
 */
export async function withGithubAttempt<T>(
  response: GithubAnswer | ((url: string) => GithubAnswer),
  body: (urls: string[]) => Promise<T>,
): Promise<T> {
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  const realToken = Deno.env.get("GH_TOKEN");
  Deno.env.set("GH_TOKEN", "test-token");
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    const answer = typeof response === "function" ? response(url) : response;
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(Response.json(answer));
  }) as typeof fetch;
  try {
    return await body(urls);
  } finally {
    globalThis.fetch = realFetch;
    if (realToken === undefined) Deno.env.delete("GH_TOKEN");
    else Deno.env.set("GH_TOKEN", realToken);
  }
}

/**
 * Returns a `withGithubAttempt()` responder that answers each URL in `answers`
 * with its entry, and rejects any other request with an error naming its URL.
 */
export function byUrl(
  answers: Iterable<readonly [string, GithubAnswer]>,
): (url: string) => GithubAnswer {
  const known = new Map(answers);
  return (url) => known.get(url) ?? new Error(`unexpected request ${url}`);
}

/**
 * Returns what `tile` collects from `ctx` while every GitHub request is
 * answered with a job listing in which two jobs ran, as a run that did work
 * lists them.
 */
export function collectFromWorkingRuns(tile: Tile, ctx: Ctx): Promise<TileView> {
  return withGithubAttempt(
    { total_count: 2, jobs: [{ conclusion: "success" }, { conclusion: "success" }] },
    () => tile.collect(ctx),
  );
}
