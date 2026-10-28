/** Shares the publisher's current activity between its two dashboard tiles. */

import { REPO, TEST_SELECTION_WORKFLOW } from "./config.ts";
import { RERUN_MS, RunLists } from "./github-runs.ts";
import { dashboardGitHubCredential, github, memo } from "./lib.ts";
import type { Ctx } from "./types.ts";

const readers = new WeakMap<Ctx, () => Promise<boolean | undefined>>();

/** The statuses a run that has not finished is listed under. */
const UNFINISHED = ["queued", "in_progress", "waiting", "requested", "pending"];

/**
 * Whether a publisher run on main is unfinished: one of the runs GitHub could
 * still start again, which reach back RERUN_MS. A run that has been started
 * again since it was read is found through the lists of unfinished runs, which
 * GitHub answers from an index that can be days behind, and is read again by
 * its id.
 */
export function publisherRunning(ctx: Ctx): Promise<boolean | undefined> {
  let read = readers.get(ctx);
  if (!read) {
    const lists = ctx.runLists ?? new RunLists();
    read = memo(20_000, async () => {
      const credential = dashboardGitHubCredential(ctx);
      if (!credential) return undefined;
      const cutoff = Date.now() - RERUN_MS;
      const runs = await lists.runs(
        (path, options) => github(path, credential, options),
        REPO,
        TEST_SELECTION_WORKFLOW,
        {
          reader: "publisher activity",
          wants: (run) => run.head_branch === "main",
          recheck: UNFINISHED.map((status) => ({ branch: "main", status })),
          until: (run) => Date.parse(run.created_at) < cutoff,
        },
      );
      return runs.some((run) => run.status !== "completed");
    });
    readers.set(ctx, read);
  }
  return read();
}
