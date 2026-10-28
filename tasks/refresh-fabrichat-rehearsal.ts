#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run=git
/**
 * Refreshes the "before" release that the FabriChat update rehearsal
 * (`packages/patterns/integration/fabrichat-update-rehearsal.test.ts`) serves:
 * a copy of FabriChat's pattern source as a git revision holds it, `origin/main`
 * unless another is named.
 *
 *   deno task refresh-fabrichat-rehearsal              # from `origin/main`
 *   deno task refresh-fabrichat-rehearsal <revision>   # from another revision
 *
 * The copy is every non-test module under `packages/patterns/fabrichat/`, and
 * `packages/patterns/loom/participants.tsx`, whose roster type is part of what a
 * room stores. Each is written beside the test, under
 * `fixtures/fabrichat-update-rehearsal/`, at its path below `packages/patterns/`
 * with `.txt` appended, so that no checker compiles it as a module of this
 * tree. `SOURCE.txt` there records the commit the copy came from. The whole
 * directory is replaced, so a module the revision no longer has goes too.
 *
 * It reads the revision through git, not the working tree, so it never copies
 * an uncommitted change, and it needs that revision to be fetched.
 */

import { dirname, fromFileUrl, join } from "@std/path";

const REPO = fromFileUrl(new URL("..", import.meta.url));

const FIXTURES = join(
  REPO,
  "packages/patterns/integration/fixtures/fabrichat-update-rehearsal",
);

/** The modules outside `fabrichat/` that the copy holds. */
const ALSO = ["packages/patterns/loom/participants.tsx"];

/** Runs git in the repository, and returns its standard output. */
const git = async (...args: string[]): Promise<string> => {
  const { code, stdout, stderr } = await new Deno.Command("git", {
    args,
    cwd: REPO,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `\`git ${args.join(" ")}\` failed: ${new TextDecoder().decode(stderr)}`,
    );
  }
  return new TextDecoder().decode(stdout);
};

/** Whether `path` names a FabriChat module the copy holds. */
const isCopied = (path: string): boolean =>
  /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path);

if (import.meta.main) {
  const revision = Deno.args[0] ?? "origin/main";
  const commit = (await git("rev-parse", "--verify", `${revision}^{commit}`))
    .trim();
  const listed = await git(
    "ls-tree",
    "--name-only",
    commit,
    "packages/patterns/fabrichat/",
  );
  const paths = [
    ...listed.split("\n").filter((path) => path !== "" && isCopied(path)),
    ...ALSO,
  ];
  // Every module is read before the old copy is removed, so a revision missing
  // one leaves the old copy as it was.
  const modules = await Promise.all(
    paths.map(async (path) => ({
      target: join(FIXTURES, `${path.slice("packages/patterns/".length)}.txt`),
      text: await git("show", `${commit}:${path}`),
    })),
  );
  await Deno.remove(FIXTURES, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  for (const { target, text } of modules) {
    await Deno.mkdir(dirname(target), { recursive: true });
    await Deno.writeTextFile(target, text);
  }
  await Deno.writeTextFile(join(FIXTURES, "SOURCE.txt"), `${commit}\n`);
  console.log(
    `Copied ${paths.length} modules from ${revision} (${commit}) into ` +
      `${FIXTURES}.`,
  );
}
