/**
 * Fetch mocking for pattern-tests (CT-1768).
 *
 * A test opts in by exporting a module-scope `fetchMocks: FetchMockEntry[]`. The
 * runner reads it after compile and injects {@link makeMockFetch} as the
 * runtime's `fetch` (`RuntimeOptions.fetch`), so a `fetchJson` resolves against
 * the mock instead of the network. Driving the in-flight request to completion
 * stays the harness's job via the `{ settle: true }` step (`runtime.settled()`).
 *
 * This is the generic-HTTP (`fetchJson`) seam; LLM calls
 * (`generateText`/`generateObject`) mock separately at the `LLMClient` layer
 * (`@commonfabric/llm`).
 */

import type { RuntimeFetch } from "@commonfabric/runner";

/**
 * One declarative fetch mock. The first entry whose `urlIncludes` is a substring
 * of a request URL wins; `base64Body` takes precedence over `body` (for binary
 * payloads like images).
 *
 * `delayMs` holds the response for a fixed real-time delay before returning, so a
 * `fetchJson` isn't resolved instantly — useful for tests that depend on *when* a
 * fetch resolves. It stays deterministic: `runtime.settled()` awaits the actual
 * (delayed) fetch promise. (Precise, manually-released ordering — a "gate" — needs
 * a SES-clean harness mechanism; tracked as a follow-up, see CT-1768.)
 */
export interface FetchMockEntry {
  urlIncludes: string;
  status?: number;
  contentType?: string;
  body?: string;
  base64Body?: string;

  /** Fixed real-time delay (ms) before the mock returns. */
  delayMs?: number;
}

/** Read & validate a test's `fetchMocks` export from the compiled module namespace. */
export function readFetchMocks(main: unknown): FetchMockEntry[] | undefined {
  const raw = (main as Record<string, unknown> | null | undefined)?.fetchMocks;
  if (!Array.isArray(raw)) return undefined;
  const entries = raw.filter((i): i is FetchMockEntry =>
    !!i && typeof i === "object" &&
    typeof (i as { urlIncludes?: unknown }).urlIncludes === "string"
  );
  return entries.length > 0 ? entries : undefined;
}

/** Resolve a `fetch` request input to its URL string. */
export function fetchInputUrl(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  const url = (input as { url?: unknown } | null | undefined)?.url;
  return typeof url === "string" ? url : "";
}

/** First mock entry matching the request URL, or undefined. */
export function matchFetchMock(
  entries: FetchMockEntry[] | undefined,
  input: unknown,
): FetchMockEntry | undefined {
  if (!entries) return undefined;
  const url = fetchInputUrl(input);
  return entries.find((e) => url.includes(e.urlIncludes));
}

/** Build a `Response` from a mock entry. */
export function makeMockResponse(entry: FetchMockEntry): Response {
  const init: ResponseInit = {
    status: entry.status ?? 200,
    headers: { "content-type": entry.contentType ?? "application/json" },
  };
  if (typeof entry.base64Body === "string") {
    const bytes = Uint8Array.from(
      atob(entry.base64Body),
      (c) => c.charCodeAt(0),
    );
    return new Response(bytes, init);
  }
  return new Response(entry.body ?? "", init);
}

/**
 * Build the `fetch` to inject as `RuntimeOptions.fetch`. Reads the (late-bound)
 * mock entries on each call — they're populated after compile, before the run —
 * so a request matching an entry resolves to a mocked `Response`, and anything
 * else falls through to `realFetch`. A matched entry's `delayMs` is awaited
 * before the response is returned; like a real `fetch`, an aborted request
 * rejects with the signal's reason instead of resolving. The abort signal is
 * taken from `init.signal`, falling back to a `Request` input's own signal
 * (init.signal wins, mirroring `fetch`).
 */
export function makeMockFetch(
  getEntries: () => FetchMockEntry[] | undefined,
  realFetch: RuntimeFetch,
): RuntimeFetch {
  return async (input, init) => {
    const entry = matchFetchMock(getEntries(), input);
    if (!entry) return realFetch(input as RequestInfo | URL, init);
    const signal = init?.signal ??
      (input instanceof Request ? input.signal : null);
    if (signal?.aborted) throw signal.reason;
    if (typeof entry.delayMs === "number" && entry.delayMs > 0) {
      await delayOrAbort(entry.delayMs, signal);
    }
    return makeMockResponse(entry);
  };
}

/**
 * Resolve after `ms`, or — mirroring `fetch` — reject with the signal's reason if
 * the request is aborted first. Cleans up its timer/listener either way.
 */
function delayOrAbort(
  ms: number,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
