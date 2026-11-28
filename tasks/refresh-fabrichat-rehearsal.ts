#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run=git
/**
 * Refreshes the "before" release that the FabriChat update rehearsal
 * (`patterns/integration/fabrichat-update-rehearsal.test.ts`) serves:
 * a copy of FabriChat's pattern source as a git revision holds it, the
 * default branch unless another is named: `upstream/main` where that exists,
 * and `origin/main` otherwise.
 *
 *   deno task refresh-fabrichat-rehearsal              # the default branch
 *   deno task refresh-fabrichat-rehearsal <revision>   # another revision
 *
 * The copy is every non-test module under `patterns/system/fabrichat/`, and
 * `patterns/system/loom/participants.tsx`, whose roster type is part of what a
 * room stores. Each is written beside the test, under
 * `fixtures/fabrichat-update-rehearsal/`, at its path below `patterns/`
 * with `.txt` appended, so that no checker compiles it as a module of this
 * tree. `SOURCE.txt` there records the commit the copy came from. The whole
 * directory is replaced, so a module the revision no longer has goes too.
 *
 * It reads the revision through git, not the working tree, so it never copies
 * an uncommitted change, and it needs that revision to be fetched. Both the
 * revision and the copy belong to the checkout holding the script, wherever
 * it is run from.
 */

import { emptyDir } from "@std/fs";
import { dirname, fromFileUrl, join } from "@std/path";
import { defaultBase, type Git, gitIn } from "./repository-files.ts";

const REPO = fromFileUrl(new URL("..", import.meta.url));

const FIXTURES = join(
  REPO,
  "patterns/integration/fixtures/fabrichat-update-rehearsal",
);

/** The modules outside `fabrichat/` that the copy holds. */
const ALSO = ["patterns/system/loom/participants.tsx"];

/** Whether `path` names a FabriChat module the copy holds. */
const isCopied = (path: string): boolean =>
  /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path);

/** Where a refresh reads the revision from, and where it writes the copy. */
export interface RefreshPlaces {
  readonly git: Git;
  readonly fixtures: string;
}

/** The repository's own git, and the directory the rehearsal reads. */
const CHECKOUT: RefreshPlaces = { git: gitIn(REPO), fixtures: FIXTURES };

/**
 * Replaces the copy in `fixtures` with the one the revision `argv` names
 * holds, the default base when it names none, and returns what it did.
 *
 * Every module is read before the old copy is removed, so a revision missing
 * one leaves the old copy as it was.
 */
export async function refreshRehearsal(
  argv: readonly string[],
  { git, fixtures }: RefreshPlaces,
): Promise<string> {
  const revision = argv[0] ?? await defaultBase(git);
  const commit = (await git("rev-parse", "--verify", `${revision}^{commit}`))
    .trim();
  const listed = await git(
    "ls-tree",
    "--name-only",
    commit,
    "patterns/system/fabrichat/",
  );
  const paths = [
    ...listed.split("\n").filter((path) => path !== "" && isCopied(path)),
    ...ALSO,
  ];
  const modules = await Promise.all(
    paths.map(async (path) => ({
      target: join(fixtures, `${path.slice("patterns/".length)}.txt`),
      text: await git("show", `${commit}:${path}`),
    })),
  );
  await emptyDir(fixtures);
  for (const { target, text } of modules) {
    await Deno.mkdir(dirname(target), { recursive: true });
    await Deno.writeTextFile(target, text);
  }
  await Deno.writeTextFile(join(fixtures, "SOURCE.txt"), `${commit}\n`);
  return `Copied ${paths.length} modules from ${revision} (${commit}) into ` +
    `${fixtures}.`;
}

if (import.meta.main) console.log(await refreshRehearsal(Deno.args, CHECKOUT));
