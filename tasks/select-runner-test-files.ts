#!/usr/bin/env -S deno run --allow-read

/** Discovers runner tests and assigns files to weighted CI shards. */

import { fromFileUrl } from "@std/path";
import { collectTestFiles } from "./run-sharded-test-files.ts";
import { parseShard } from "./shard-utils.ts";
import { RUNNER_TEST_WEIGHTS } from "./test-timing-weights.ts";
import { assignWeightedShards } from "./weighted-shards.ts";
export { parseShard };

// Observed timings place expensive files first. Files absent from the profile
// receive a unit weight, so newly added tests remain covered and spread evenly.
export function selectRunnerTestFiles(
  files: { name: string }[],
  shard: { index: number; total: number },
  weights: Readonly<Record<string, number>> = RUNNER_TEST_WEIGHTS,
): string[] {
  const names = files.map((file) => file.name);
  const assignments = assignWeightedShards(
    names.map((name) => ({ name, weight: weights[name] ?? 1 })),
    shard.total,
  );
  return names
    .filter((name) => assignments.get(name) === shard.index)
    .sort();
}

/** Lists package test modules by their path relative to the test directory. */
export async function listRunnerTests(
  testDir = fromFileUrl(new URL("../packages/runner/test/", import.meta.url)),
): Promise<{ name: string }[]> {
  return (await collectTestFiles(testDir))
    .filter((file) => /\.test\.tsx?$/.test(file))
    .map((name) => ({ name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The runner test paths, relative to the runner package, that the shard
 * `rawShard` (such as `1/8`) runs out of `files`. Throws when the shard
 * selects no file.
 */
export function selectRunnerTestPaths(
  files: { name: string }[],
  rawShard: string,
  weights: Readonly<Record<string, number>> = RUNNER_TEST_WEIGHTS,
): string[] {
  const selected = selectRunnerTestFiles(files, parseShard(rawShard), weights)
    .map((name) => `./test/${name}`);

  if (selected.length === 0) {
    throw new Error(`No runner test files selected for ${rawShard}`);
  }

  return selected;
}

if (import.meta.main) {
  const files = await listRunnerTests();
  console.log(selectRunnerTestPaths(files, Deno.args[0] ?? "").join("\n"));
}
