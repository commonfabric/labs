import type { Run } from "../types.ts";

/**
 * Runs `body` with `fetch` standing in for GitHub's workflow-run attempt
 * endpoint. Every request is answered with `response`, or with what `response`
 * returns for the request's URL, and an `Error` rejects the request. None
 * reaches the network, whatever token the environment holds. `body` receives
 * the URLs requested so far, in order.
 */
export async function withGithubAttempt(
  response: Run | Error | ((url: string) => Run | Error),
  body: (urls: string[]) => Promise<void>,
): Promise<void> {
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  const realToken = Deno.env.get("GH_TOKEN");
  Deno.env.set("GH_TOKEN", "test-token");
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    const attempt = typeof response === "function"
      ? response(url)
      : response;
    return attempt instanceof Error
      ? Promise.reject(attempt)
      : Promise.resolve(Response.json(attempt));
  }) as typeof fetch;
  try {
    await body(urls);
  } finally {
    globalThis.fetch = realFetch;
    if (realToken === undefined) Deno.env.delete("GH_TOKEN");
    else Deno.env.set("GH_TOKEN", realToken);
  }
}
