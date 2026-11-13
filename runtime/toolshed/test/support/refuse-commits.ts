import type { CommitError, Runtime } from "@commonfabric/runner";

/**
 * Refuses with `refusal` the commit of every transaction `runtime` opens from
 * now on whose written documents `wanted` accepts, leaving its reads and
 * writes real and only its outcome injected. Returns a count of the commits
 * refused, so a test can state how many transactions the condition matched.
 */
export function refuseCommits(
  runtime: Runtime,
  refusal: CommitError,
  wanted: (written: readonly string[]) => boolean,
): () => number {
  let refused = 0;
  const outcome = Promise.resolve({ error: refusal });
  const edit = runtime.edit.bind(runtime);
  runtime.edit = (...args) => {
    const opened = edit(...args);
    const commit = opened.commit.bind(opened);
    opened.commit = (...commitArgs) => {
      const written = (opened.getWriteAttemptLog?.() ?? [])
        .map((attempt) => attempt.id);
      if (!wanted(written)) return commit(...commitArgs);
      refused++;
      opened.abort(refusal);
      return {
        verdict: outcome,
        settled: outcome,
        then: () => {
          throw new TypeError("Select a receipt's verdict or settled");
        },
      };
    };
    return opened;
  };
  return () => refused;
}
