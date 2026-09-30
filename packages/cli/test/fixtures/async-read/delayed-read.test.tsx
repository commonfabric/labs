/**
 * Fixture for an assertion whose own read starts an async built-in. Nothing
 * reads the fetch before the assertion does, so its first read is what issues
 * the request; the mock answers after a delay, and the runner waits for it
 * before reading again.
 */

import { assert, computed, fetchJson, pattern, TESTS } from "commonfabric";

export const fetchMocks = [
  {
    urlIncludes: "/api/slow",
    contentType: "application/json",
    body: '{"v":7}',
    delayMs: 50,
  },
];

export default pattern(() => {
  const url = computed(() => "https://example.test/api/slow");
  const fetched = fetchJson<{ v: number }>({ url });
  const result_is_7 = assert(() => fetched.result?.v === 7);
  return {
    [TESTS]: [
      { assertion: result_is_7 },
    ],
  };
});
