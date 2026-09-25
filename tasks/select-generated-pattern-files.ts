#!/usr/bin/env -S deno run --allow-read

import { parseShard, type Shard } from "./shard-utils.ts";
export { parseShard };

export function selectGeneratedPatternFiles(
  names: string[],
  shard: Shard,
): string[] {
  return [...names]
    .sort()
    .filter((_, index) => index % shard.total === shard.index - 1);
}

export async function listGeneratedPatternTests(): Promise<string[]> {
  const integrationDir = new URL(
    "../packages/generated-patterns/integration/patterns/",
    import.meta.url,
  );
  const files: string[] = [];

  for await (const entry of Deno.readDir(integrationDir)) {
    if (entry.isFile && entry.name.endsWith(".test.ts")) {
      files.push(entry.name);
    }
  }

  files.sort();
  return files;
}

/**
 * The generated pattern test paths, relative to the generated-patterns
 * package, that the shard `rawShard` (such as `1/2`) runs out of `files`.
 * Throws when the shard selects no file.
 */
export function selectGeneratedPatternPaths(
  files: string[],
  rawShard: string,
): string[] {
  const selected = selectGeneratedPatternFiles(files, parseShard(rawShard))
    .map((name) => `./integration/patterns/${name}`);

  if (selected.length === 0) {
    throw new Error(`No generated pattern files selected for ${rawShard}`);
  }

  return selected;
}

if (import.meta.main) {
  const files = await listGeneratedPatternTests();
  console.log(
    selectGeneratedPatternPaths(files, Deno.args[0] ?? "").join("\n"),
  );
}
