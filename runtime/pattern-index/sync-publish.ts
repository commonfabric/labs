/**
 * The publish step of a repository sync: reads the plan the plan step wrote
 * and sends it to the index, which makes a version of each entry whose
 * source changed. The action at `.github/actions/pattern-index-sync` runs it;
 * `src/repo-sync.ts` says why a sync runs as two steps in two jobs.
 *
 *   deno run --frozen --allow-read --allow-write --allow-env --allow-net \
 *     runtime/pattern-index/sync-publish.ts --plan <plan.json> \
 *     --repository owner/name --commit <sha> [--index-url <url>] \
 *     [--summary <file>]
 *
 * It loads no compiler and evaluates no pattern code. Its credential is a
 * GitHub OIDC token whose audience is the index's base URL, minted for each
 * call since one lives only minutes (`src/github-oidc.ts`); the index reads
 * from it which repository, and so which brand, the run acts for.
 *
 * Exits 1 when any entry failed to compile or publish, or when it could not
 * run, after writing the report; exits 2 for a usage error.
 */

import { parseArgs } from "@std/cli/parse-args";
import { resolvePatternIndexUrl } from "./src/access.ts";
import { syncBrandPatterns } from "./src/brand-sync-client.ts";
import { mintGithubOidcToken } from "./src/github-oidc.ts";
import {
  planProblem,
  publishPlan,
  reportMarkdown,
  type RepoSyncPlan,
  syncFailed,
} from "./src/repo-sync.ts";

const main = async (): Promise<number> => {
  const flags = parseArgs(Deno.args, {
    string: ["plan", "repository", "commit", "index-url", "summary"],
  });
  const { plan: planPath, repository, commit } = flags;
  if (
    planPath === undefined || repository === undefined || commit === undefined
  ) {
    console.error(
      "sync-publish: --plan, --repository and --commit are required",
    );
    return 2;
  }
  const report = async (markdown: string) => {
    console.log(markdown);
    if (flags.summary !== undefined) {
      await Deno.writeTextFile(flags.summary, markdown, { append: true });
    }
  };
  try {
    const plan: unknown = JSON.parse(await Deno.readTextFile(planPath));
    const problem = planProblem(plan);
    if (problem !== undefined) throw new Error(`Unreadable plan: ${problem}`);
    // The index checks the token's audience against its own base URL, which
    // it writes without a trailing slash.
    const indexUrl = resolvePatternIndexUrl(flags["index-url"]).replace(
      /\/+$/,
      "",
    );
    const result = await publishPlan(
      // Checked above, as far as this step trusts it: the patterns
      // themselves are the index's to judge.
      plan as RepoSyncPlan,
      { repository, commit },
      async (request) =>
        syncBrandPatterns(
          indexUrl,
          await mintGithubOidcToken(indexUrl, Deno.env.get),
          request,
        ),
    );
    await report(reportMarkdown(result));
    return syncFailed(result) ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await report(
      `## Pattern index sync: ${repository}\n\nThe sync could not run: ${message}\n`,
    );
    return 1;
  }
};

if (import.meta.main) Deno.exit(await main());
