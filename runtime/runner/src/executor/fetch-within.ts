import type { RuntimeFetch } from "../runtime.ts";

/** `fetch`, with each request refused once it has gone `deadlineMs`
 * without its whole answer, body included: the request is aborted and the
 * call rejects. The response it returns has its body already read. A peer
 * that stops answering reports nothing, so this deadline is the only end
 * a silent host's request has. A signal the caller passes aborts the
 * request as well. */
export function fetchWithin(
  fetch: RuntimeFetch,
  deadlineMs: number,
): RuntimeFetch {
  return (input, init) => {
    const abort = new AbortController();
    const outer = init?.signal;
    if (outer) {
      if (outer.aborted) abort.abort(outer.reason);
      else outer.addEventListener("abort", () => abort.abort(outer.reason));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const silent = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          `space-root ensure: a pattern-source fetch went ${deadlineMs}ms ` +
            "without an answer (SpaceServerPolicy.rootEnsureDeadlineMs); " +
            "the tenure proceeds serving without the root",
        );
        abort.abort(error);
        reject(error);
      }, deadlineMs);
    });
    // The deadline runs until the body is read, not just the headers: a
    // host can answer the headers and then go silent mid-body.
    const answered = fetch(input, { ...init, signal: abort.signal }).then(
      async (response) =>
        new Response(await response.arrayBuffer(), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
    );
    answered.catch(() => {});
    return Promise.race([answered, silent]).finally(() => clearTimeout(timer));
  };
}
