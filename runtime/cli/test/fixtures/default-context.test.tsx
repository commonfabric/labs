import { assert, pattern, resultOf, TESTS, wish } from "commonfabric";

export default pattern(() => {
  const summaryRequest = wish<string>({ query: "#learnedSummary" });
  const indexRequest = wish<{ entries: unknown[] }>({ query: "#summaryIndex" });
  const summary = resultOf(summaryRequest.result);
  const index = resultOf(indexRequest.result);
  return {
    [TESTS]: [
      { assertion: assert(() => summary === "") },
      { assertion: assert(() => index.entries.length === 0) },
    ],
  };
});
