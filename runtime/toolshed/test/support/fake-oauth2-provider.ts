// An OAuth2 provider stand-in for tests: an HTTP server on 127.0.0.1 that
// answers each configured path with a canned response and records every
// request it receives.
//
// TEST SUPPORT ONLY.

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Headers;
  body: string;
}

export interface FakeOAuth2Provider extends AsyncDisposable {
  /** The absolute URL of `path` on this server. */
  url(path: string): string;
  /** The requests received so far, in arrival order. */
  readonly requests: RecordedRequest[];
}

/**
 * Start a server that answers a request for a path in `routes` with the
 * response that path's function returns, and any other path with a 404.
 */
export function startFakeOAuth2Provider(
  routes: Record<string, () => Response>,
): FakeOAuth2Provider {
  const requests: RecordedRequest[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      const path = new URL(request.url).pathname;
      requests.push({
        method: request.method,
        path,
        headers: request.headers,
        body: await request.text(),
      });
      return routes[path]?.() ?? new Response("not found", { status: 404 });
    },
  );
  const origin = `http://127.0.0.1:${server.addr.port}`;
  return {
    url: (path) => `${origin}${path}`,
    requests,
    [Symbol.asyncDispose]: () => server.shutdown(),
  };
}
