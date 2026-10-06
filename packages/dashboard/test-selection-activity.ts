/** Shares the publisher's current activity between its two dashboard tiles. */

import { REPO, TEST_SELECTION_WORKFLOW } from "./config.ts";
import { dashboardGitHubCredential, github, memo } from "./lib.ts";
import type { Ctx } from "./types.ts";

interface ActivityRun {
  id: number;
  status: string;
  head_branch: string | null;
}

const readers = new WeakMap<Ctx, () => Promise<boolean | undefined>>();

const RUNS = `repos/${REPO}/actions/workflows/${TEST_SELECTION_WORKFLOW}/runs`;

const unfinishedOnMain = (run: ActivityRun) =>
  run.head_branch === "main" && run.status !== "completed";

/**
 * Whether a publisher run on main is unfinished: one on the workflow's newest
 * page, which GitHub serves current, or a rerun of an older one. Reruns are
 * found by status, which GitHub answers from an index that can be days behind,
 * so each older run found that way counts only once its own current record
 * agrees.
 */
export function publisherRunning(ctx: Ctx): Promise<boolean | undefined> {
  let read = readers.get(ctx);
  if (!read) {
    read = memo(20_000, async () => {
      const credential = dashboardGitHubCredential(ctx);
      if (!credential) return undefined;
      const [newest, ...byStatus] = await Promise.all(
        [
          `${RUNS}?per_page=10`,
          ...["queued", "in_progress", "waiting", "requested", "pending"].map(
            (status) => `${RUNS}?branch=main&status=${status}&per_page=10`,
          ),
        ].map((path) =>
          github<{ workflow_runs: ActivityRun[] }>(path, credential)
        ),
      );
      if (newest.workflow_runs.some(unfinishedOnMain)) return true;
      const seen = new Set(newest.workflow_runs.map((run) => run.id));
      const older = new Set(
        byStatus.flatMap((listed) => listed.workflow_runs)
          .map((run) => run.id)
          .filter((id) => !seen.has(id)),
      );
      const current = await Promise.all(
        [...older].map((id) =>
          github<ActivityRun>(`repos/${REPO}/actions/runs/${id}`, credential)
        ),
      );
      return current.some(unfinishedOnMain);
    });
    readers.set(ctx, read);
  }
  return read();
}
