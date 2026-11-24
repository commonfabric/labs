// Pattern-test for the CT-1768 fetch-mocking harness support: a test declares an
// outbound fetch mock via the `fetchMocks` named export, and the runner injects
// it into `runtime.fetch` so a `fetchJson` resolves against the mock instead of
// the network. The async fetch chain is driven to completion by the harness's
// existing `{ settle: true }` step (`runtime.settled()`), after which a value
// computed from the `fetchJson` result is observable — which it was not before.
//
// LLM calls (generateText/generateObject) mock separately via @commonfabric/llm;
// this seam is for generic `fetchJson` HTTP.
import { assert, computed, fetchJson, pattern, TESTS } from "commonfabric";

export const fetchMocks = [
  {
    urlIncludes: "/api/example",
    contentType: "application/json",
    body: '{"answer":42,"label":"mocked"}',
  },
];

export default pattern(() => {
  const url = computed(() => "https://example.test/api/example");
  const fetched = fetchJson<{ answer: number; label: string }>({
    url,
  });

  // Values gated on the `fetchJson` result — observable only once the mocked
  // request is driven to completion. Inline-boolean assertions so the reads are
  // reliable (an intermediate observer computed would infer `unknown`).
  const result_answer_is_42 = assert(() => fetched.result?.answer === 42);
  const result_label_is_mocked = assert(() =>
    fetched.result?.label === "mocked"
  );
  const not_pending = assert(() => fetched.pending === false);
  const no_error = assert(() => fetched.error === undefined);

  return {
    [TESTS]: [
      // Drive the in-flight fetchJson (mutex -> mock fetch -> result write) to
      // completion before the assertions read the result.
      { settle: true },
      { assertion: result_answer_is_42 },
      { assertion: result_label_is_mocked },
      { assertion: not_pending },
      { assertion: no_error },
    ],
    fetched,
  };
});
