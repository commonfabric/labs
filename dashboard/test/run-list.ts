/**
 * What GitHub answers to a request for a page of a workflow's run list, for
 * the tests of the parts of the dashboard that read run lists.
 */

/** GitHub's answer to a run list holding exactly `runs`, on one page. */
export function runList<T>(
  runs: T[],
): { total_count: number; workflow_runs: T[] } {
  return { total_count: runs.length, workflow_runs: runs };
}
