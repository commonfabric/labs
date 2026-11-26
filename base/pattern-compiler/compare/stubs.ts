/**
 * The answers that stand for the network and for the targets of a space
 * in a run of the corpus: a table from a request to its completion for
 * the executor of `../exec/`, and a `fetch` that answers the same for
 * today's runtime. Nothing leaves the process.
 */
import type { Completion, Outstanding } from "../exec/executor.ts";

/** What every request for JSON is answered with. */
const JSON_ANSWER = {};

/** What every request that the table gives no result for fails with. */
export const STUB_ERROR = "the stub has no answer";

/**
 * The completion of a request of the executor. A request for JSON gets
 * an empty record, a generated text is a fixed text, a generated object
 * an empty record, and a `navigateTo` is done. Every other request
 * fails.
 */
export const stubCompletion = ({ builtin }: Outstanding): Completion => {
  switch (builtin) {
    case "fetchJson":
    case "fetchJsonUnchecked":
      return { result: JSON_ANSWER };
    case "navigateTo":
      return { result: true };
    default:
      return { error: STUB_ERROR };
  }
};

/**
 * Replaces `fetch` for a run of today's runtime, and returns what puts
 * the earlier one back. A request to a path below `/api/` is one of the
 * runtime's own services, which a test process does not have, and fails
 * with status 404, as every request does that the table of the executor
 * fails. Any other request is answered with the JSON that the table of
 * the executor gives a request for JSON.
 */
export const stubFetch = (): () => void => {
  const earlier = globalThis.fetch;
  globalThis.fetch = (input: Request | URL | string) => {
    const url = new URL(input instanceof Request ? input.url : `${input}`);
    return Promise.resolve(
      url.pathname.startsWith("/api/") || url.protocol === "file:"
        ? new Response(STUB_ERROR, { status: 404 })
        : new Response(JSON.stringify(JSON_ANSWER), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
  };
  return () => {
    globalThis.fetch = earlier;
  };
};
