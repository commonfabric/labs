/**
 * Fixture for a fetch that only the serving loop makes. An action points
 * `fetchJson` at a URL and an assertion reads the result. No `fetchMocks`
 * entry matches, so the request reaches whatever `fetch` the process had
 * when the run started, which the test that runs this replaces.
 */

import {
  assert,
  fetchJson,
  handler,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";

const point = handler<{ url: string }, { url: Writable<string> }>(
  (event, { url }) => url.set(event.url),
);

export default pattern(() => {
  const url = Writable.of<string>("");
  const fetched = fetchJson<{ v: number }>({ url });
  return {
    [TESTS]: [
      { action: point({ url }), event: { url: "https://example.test/v" } },
      { assertion: assert(() => fetched.result?.v === 7) },
    ],
  };
});
