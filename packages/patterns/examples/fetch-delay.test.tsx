// Pattern-test for the CT-1768 fetch-mock `delayMs` (Robin/ubik2's suggestion):
// a mock can return after a fixed real-time delay, so a fetchJson isn't resolved
// instantly. The assertion's read is what starts the fetch, and the harness
// waits for the delayed response before it reads again, so the result is
// observed deterministically once it lands.
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
    fetched,
  };
});
