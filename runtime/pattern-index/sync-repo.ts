/**
 * `sync-repo.ts`: publishes the patterns a repository holds to the pattern
 * index, one lineage per entry file, from a GitHub Actions job. The action
 * at `.github/actions/pattern-index-sync` runs it; `src/repo-sync.ts` says
 * what a sync does.
 *
 * It holds no secret. It makes a key for this run alone and signs with it,
 * and a GitHub OIDC token whose audience names that key tells the index which
 * repository, and so which brand, the run acts for (`src/github-oidc.ts`).
 *
 * It compiles in a runtime of its own with in-memory storage, so it writes
 * nothing to any fabric and needs no fabric's address. The flags that bear
 * on a pattern's identity are the ones this build defaults to, as a shell
 * built from the same commit uses, with any `EXPERIMENTAL_*` variable in the
 * environment winning, as it does for `cf`.
 *
 * Usage, from the repository's root:
 *
 *   deno run -A runtime/pattern-index/sync-repo.ts \
 *     --repository owner/name --commit <sha> --program-root <dir> \
 *     --include '<glob>' [--include ...] [--exclude '<glob>' ...] \
 *     [--repo-root <dir>] [--index-url <url>] [--summary <file>] [--dry-run]
 *
 * `--dry-run` finds the entries and compiles every one, against no index and
 * with no token, and publishes nothing: what a sync would publish into an
 * index that holds nothing from this repository yet.
 *
 * Exits 1 when any entry failed to resolve, compile or publish, after
 * writing the report; exits 2 for a usage error.
 */

import { parseArgs } from "@std/cli/parse-args";
import { resolve } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { experimentalOptionsFromEnv, Runtime } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { resolvePatternIndexUrl } from "./src/access.ts";
import { PatternIndexClient } from "./src/client.ts";
import { mintGithubOidcToken } from "./src/github-oidc.ts";
import { compileProgram } from "./src/publish.ts";
import {
  reportMarkdown,
  type RepoSyncDeps,
  syncFailed,
  syncRepo,
} from "./src/repo-sync.ts";

/** A flag given once or repeated, as a list. */
const listOf = (value: unknown): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value.map(String) : [
    String(value),
  ];

/** A required flag's value. */
const required = (flags: Record<string, unknown>, name: string): string => {
  const value = flags[name];
  if (typeof value !== "string" || value === "") {
    console.error(`sync-repo: --${name} is required`);
    Deno.exit(2);
  }
  return value;
};

/** The repository's tracked files, relative to its root. */
const gitTrackedFiles = async (repoRoot: string): Promise<string[]> => {
  const { code, stdout, stderr } = await new Deno.Command("git", {
    args: ["-C", repoRoot, "ls-files", "-z"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `git ls-files failed in ${repoRoot}: ${new TextDecoder().decode(stderr)}`,
    );
  }
  return new TextDecoder().decode(stdout).split("\0").filter((path) =>
    path !== ""
  );
};

/** An index that holds nothing and publishes nowhere, for `--dry-run`. */
const dryRunClient: RepoSyncDeps["client"] = {
  listRepoHeads: () => Promise.resolve({ heads: [] }),
  publishPattern: (request) =>
    Promise.resolve({ patternId: request.patternId, created: true }),
  requestListing: (request) =>
    Promise.resolve({ patternId: request.patternId, listing: "pending" }),
};

const main = async (): Promise<number> => {
  const flags = parseArgs(Deno.args, {
    string: [
      "repository",
      "commit",
      "repo-root",
      "program-root",
      "include",
      "exclude",
      "index-url",
      "summary",
    ],
    boolean: ["dry-run"],
    collect: ["include", "exclude"],
  });
  const repository = required(flags, "repository");
  const commit = required(flags, "commit");
  const programRoot = required(flags, "program-root");
  const include = listOf(flags.include);
  if (include.length === 0) {
    console.error("sync-repo: at least one --include is required");
    return 2;
  }
  const repoRoot = resolve(flags["repo-root"] ?? ".");
  const dryRun = flags["dry-run"];

  const signer = await Identity.generate();
  const client = dryRun ? dryRunClient : new PatternIndexClient({
    baseUrl: resolvePatternIndexUrl(flags["index-url"]),
    signer,
    githubOidc: await mintGithubOidcToken(signer.did(), Deno.env.get),
  });
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    // Nothing is fetched from it: the compile reads local files only.
    apiUrl: new URL("http://pattern-index-sync.invalid"),
    storageManager,
    experimental: experimentalOptionsFromEnv(Deno.env.get, "sync-repo"),
  });
  try {
    const report = await syncRepo(
      {
        repository,
        commit,
        repoRoot,
        programRoot,
        include,
        exclude: listOf(flags.exclude),
      },
      {
        trackedFiles: () => gitTrackedFiles(repoRoot),
        readTextFile: (path) => Deno.readTextFile(path),
        resolveProgram: (entry, root) =>
          resolveLocalProgram(
            (resolver) => runtime.harness.resolve(resolver),
            { main: entry, root },
          ),
        compileProgram: (program) =>
          compileProgram(runtime, signer.did(), program),
        client,
      },
    );
    const markdown = (dryRun ? "_Dry run: nothing was published._\n\n" : "") +
      reportMarkdown(report);
    console.log(markdown);
    if (flags.summary !== undefined) {
      await Deno.writeTextFile(flags.summary, markdown, { append: true });
    }
    return syncFailed(report) ? 1 : 0;
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

if (import.meta.main) Deno.exit(await main());
