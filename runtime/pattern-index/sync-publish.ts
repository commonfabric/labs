/**
 * The publish step of a repository sync: reads the plan the plan step wrote,
 * publishes what changed, and withdraws the lineages of paths that are gone. The action at
 * `.github/actions/pattern-index-sync` runs it; `src/repo-sync.ts` says why a
 * sync runs as two steps in two jobs.
 *
 *   deno run --frozen --allow-read --allow-write --allow-env --allow-net \
 *     runtime/pattern-index/sync-publish.ts --plan <plan.json> \
 *     --repository owner/name --commit <sha> [--index-url <url>] \
 *     [--summary <file>]
 *
 * It loads no compiler and evaluates no pattern code. It makes a key for
 * this run alone and signs with it, and a GitHub OIDC token whose audience
 * names that key tells the index which repository, and so which brand, the
 * run acts for (`src/github-oidc.ts`). A token is minted for each call,
 * since one lives only minutes.
 *
 * Exits 1 when any entry failed to compile or publish, or when it could not
 * run, after writing the report; exits 2 for a usage error. An entry with no
 * description or too large for the index is reported, not a failure
 * (`syncFailed` in `src/repo-sync.ts`).
 */

import { parseArgs } from "@std/cli/parse-args";
import { Identity } from "@commonfabric/identity";
import { resolvePatternIndexUrl } from "./src/access.ts";
import { PatternIndexClient } from "./src/client.ts";
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
    const signer = await Identity.generate();
    const indexUrl = resolvePatternIndexUrl(flags["index-url"]);
    const result = await publishPlan(
      // Checked above, as far as this step trusts it: the publish requests
      // themselves are the index's to judge.
      plan as RepoSyncPlan,
      { repository, commit },
      new PatternIndexClient({
        baseUrl: indexUrl,
        signer,
        githubOidc: () =>
          mintGithubOidcToken(indexUrl, signer.did(), Deno.env.get),
      }),
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
