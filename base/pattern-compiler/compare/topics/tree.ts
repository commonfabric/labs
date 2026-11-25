/**
 * Writes the program of Topics (`patterns/apps/topics/`): the seven files of
 * the program, copied from the repository's `patterns/`, which the compiled
 * pattern language accepts as they are.
 *
 * `deno run -A base/pattern-compiler/compare/topics/tree.ts <directory>`
 *
 * The directory then holds `patterns/` with those files, so that it can be
 * given as `COMPARE_ROOT` to the runs of the comparison (`../corpus.ts`).
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

/** Writes the program under `directory`, which it creates. */
export const writeTopicsTree = async (directory: string): Promise<void> => {
  for (const file of TOPICS_FILES) {
    const target = join(directory, file);
    await Deno.mkdir(dirname(target), { recursive: true });
    await Deno.copyFile(join(repository, file), target);
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
