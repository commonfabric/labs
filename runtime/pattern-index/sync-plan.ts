/**
 * The plan step of a repository sync: compiles every pattern entry the
 * repository holds and writes the plan the publish step reads. The action at
 * `.github/actions/pattern-index-sync` runs it; `src/repo-sync.ts` says why a
 * sync runs as two steps in two jobs.
 *
 *   deno run --frozen --allow-read --allow-write --allow-env --allow-net \
 *     --allow-ffi --allow-run=git runtime/pattern-index/sync-plan.ts \
 *     --repo-root <dir> --program-root <dir> --include '<glob>' \
 *     [--include ...] [--exclude '<glob>' ...] --out <plan.json> \
 *     [--summary <file>] [--moves-table <path>]
 *
 * A repository that records how its patterns moved has each entry's former
 * paths in the plan, so a moved file continues its old path's lineage. The
 * table is at `--moves-table`, relative to the repository root, or else at
 * Labs' {@link MOVES_TABLE}; a repository with no file there has no moves to
 * follow.
 *
 * It holds no credential and contacts no index, so it is also the dry run.
 * It compiles in a runtime with in-memory storage, writing nothing to any
 * fabric. The flags that bear on a pattern's identity are the ones this Labs
 * build defaults to, as a shell built from the same commit uses, with any
 * `EXPERIMENTAL_*` variable in the environment winning, as it does for `cf`.
 *
 * Exits 0 when it wrote a plan, even one recording failed entries: the
 * publish step reports those, and fails. Exits 1 when it could not plan, and
 * 2 for a usage error.
 */

import { parseArgs } from "@std/cli/parse-args";
import { join, resolve, toFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import {
  experimentalOptionsFromEnv,
  formerKeyIn,
  Runtime,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { compileProgram } from "./src/publish.ts";
import { formerPathsByKey, planRepo } from "./src/repo-plan.ts";
import type { RepoSyncPlan } from "./src/repo-sync.ts";

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

/**
 * Where a repository records how its patterns moved, from its root, unless
 * `--moves-table` names another place: Labs' own table.
 */
const MOVES_TABLE = "runtime/runner/src/pattern-key-moves.ts";

/** Whether `value` is a table of moves: former keys to current keys. */
const isMovesTable = (value: unknown): value is Record<string, string> =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  Object.values(value).every((to) => typeof to === "string");

/**
 * The former key of each key in the repository's table of moves at `table`,
 * or `undefined` when there is no file there. The table maps former keys to
 * current ones below the program root, as `MOVED_PATTERN_KEYS` does: a JSON
 * object, or a module exporting `MOVED_PATTERN_KEYS`. It is read from the
 * repository being synced, never from this Labs, which a vendoring
 * repository runs from but whose moves are not its own.
 *
 * @throws Error when the file holds no such table.
 */
const repositoryFormerKey = async (
  repoRoot: string,
  table: string,
): Promise<((key: string) => string) | undefined> => {
  const path = join(repoRoot, table);
  let moves: unknown;
  try {
    moves = path.endsWith(".json")
      ? JSON.parse(await Deno.readTextFile(path))
      : (await import(toFileUrl(path).href)).MOVED_PATTERN_KEYS;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    // A module that is not there fails its import with no `NotFound`.
    if (!(await exists(path))) return undefined;
    throw error;
  }
  if (!isMovesTable(moves)) {
    throw new Error(
      `${table} holds no table of moves (former key to current key)`,
    );
  }
  return formerKeyIn(moves);
};

/** Whether a file is at `path`. */
const exists = (path: string): Promise<boolean> =>
  Deno.stat(path).then(() => true, (error) => {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  });

/** What a plan holds, for the job summary. */
const planMarkdown = (plan: RepoSyncPlan): string => {
  const withStatus = (status: string) =>
    plan.entries.filter((entry) => entry.status === status).length;
  const lines = [
    "## Pattern index sync: plan",
    "",
    `${plan.entries.length} entries: ${withStatus("compiled")} compiled, ` +
    `${withStatus("undescribed")} without a description, ` +
    `${withStatus("failed")} failed.`,
  ];
  for (const entry of plan.entries) {
    if (entry.status === "failed") {
      lines.push(`- \`${entry.path}\` failed: ${entry.reason}`);
    }
  }
  return lines.join("\n") + "\n";
};

const main = async (): Promise<number> => {
  const flags = parseArgs(Deno.args, {
    string: [
      "repo-root",
      "program-root",
      "include",
      "exclude",
      "out",
      "summary",
      "moves-table",
    ],
    collect: ["include", "exclude"],
  });
  const programRoot = flags["program-root"];
  const out = flags.out;
  if (programRoot === undefined || out === undefined) {
    console.error("sync-plan: --program-root and --out are required");
    return 2;
  }
  if (flags.include.length === 0) {
    console.error("sync-plan: at least one --include is required");
    return 2;
  }
  const repoRoot = resolve(flags["repo-root"] ?? ".");
  const formerKey = await repositoryFormerKey(
    repoRoot,
    flags["moves-table"] ?? MOVES_TABLE,
  );
  const signer = await Identity.generate();
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    // Never contacted: a compile reads only the program it is handed.
    apiUrl: new URL("http://pattern-index-sync.invalid"),
    storageManager,
    experimental: experimentalOptionsFromEnv(Deno.env.get, "sync-plan"),
  });
  try {
    const plan = await planRepo(
      {
        repoRoot,
        programRoot,
        include: flags.include,
        exclude: flags.exclude,
        ...(formerKey === undefined
          ? {}
          : { formerPaths: formerPathsByKey(programRoot, formerKey) }),
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
        experimental: runtime.experimental,
      },
    );
    await Deno.writeTextFile(out, JSON.stringify(plan));
    const markdown = planMarkdown(plan);
    console.log(markdown);
    if (flags.summary !== undefined) {
      await Deno.writeTextFile(flags.summary, markdown, { append: true });
    }
    return 0;
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

if (import.meta.main) Deno.exit(await main());
