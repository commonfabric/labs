/**
 * Writes the program of Topics (`patterns/apps/topics/`) as the compiled
 * pattern language accepts it: the seven files of the program, copied from
 * the repository's `patterns/` and changed by `rewrite.patch`.
 *
 * `deno run -A base/pattern-compiler/compare/topics/tree.ts <directory>`
 *
 * The directory then holds `patterns/` with those files, so that it can be
 * given as `COMPARE_ROOT` to the runs of the comparison (`../corpus.ts`).
 * Each change of the patch is one the documents require, and
 * `base/pattern-compiler/SPEC-NOTES.md` says which rule asks for each.
 */
import { dirname, fromFileUrl, join } from "@std/path";

/** The files of the program, relative to the repository. */
export const TOPICS_FILES = [
  "patterns/apps/topics/main.tsx",
  "patterns/apps/topics/crossref-index.ts",
  "patterns/apps/topics/topic.tsx",
  "patterns/product/collection-naming/mentionable.ts",
  "patterns/product/collection-naming/naming.ts",
  "patterns/product/collection-naming/allocator.ts",
  "patterns/system/profile-face/profile-face.ts",
];

const repository = fromFileUrl(new URL("../../../../", import.meta.url));
const patch = fromFileUrl(new URL("./rewrite.patch", import.meta.url));

/** Writes the rewritten program under `directory`, which it creates. */
export const writeTopicsTree = async (directory: string): Promise<void> => {
  for (const file of TOPICS_FILES) {
    const target = join(directory, file);
    await Deno.mkdir(dirname(target), { recursive: true });
    await Deno.copyFile(join(repository, file), target);
  }
  const { success, stderr } = await new Deno.Command("git", {
    args: ["apply", patch],
    cwd: directory,
  }).output();
  if (!success) {
    throw new Error(
      `rewrite.patch does not apply: ${new TextDecoder().decode(stderr)}`,
    );
  }
};

if (import.meta.main) {
  const [directory] = Deno.args;
  if (directory === undefined) {
    console.error("usage: tree.ts <directory>");
    Deno.exit(2);
  }
  await writeTopicsTree(directory);
}
