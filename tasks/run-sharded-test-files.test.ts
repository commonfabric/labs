import { expect } from "@std/expect";
import * as path from "@std/path";
import { describe, it } from "@std/testing/bdd";

import {
  collectTestFiles,
  selectShardedTestFiles,
} from "./run-sharded-test-files.ts";
import { AGENTS_HOST_TEST_WEIGHTS } from "./test-timing-weights.ts";
import {
  memberTestFiles,
  type ParsedTestTask,
} from "./test-topology/deno-task.ts";

const AGENTS_HOST_SHARDS = 5;

describe("run-sharded-test-files", () => {
  it("collects test modules recursively in stable order", async () => {
    const dir = await Deno.makeTempDir({ prefix: "sharded-tests-" });
    try {
      await Deno.mkdir(`${dir}/nested`);
      await Deno.writeTextFile(`${dir}/z.test.ts`, "");
      await Deno.writeTextFile(`${dir}/nested/a_test.ts`, "");
      await Deno.writeTextFile(`${dir}/nested/helper.ts`, "");

      expect(await collectTestFiles(dir)).toEqual([
        "nested/a_test.ts",
        "z.test.ts",
      ]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("leaves out what the member excludes, as the topology does", async () => {
    // What this runner hands `deno test` is what a lane is offered as
    // units. A file one of them takes and the other passes over is a
    // test that runs in the full run and can never be asked for.
    const dir = await Deno.makeTempDir({ prefix: "sharded-rule-" });
    try {
      await Deno.writeTextFile(
        `${dir}/deno.json`,
        JSON.stringify({ test: { exclude: ["fixtures/"] } }),
      );
      await Deno.mkdir(`${dir}/fixtures`);
      await Deno.mkdir(`${dir}/node_modules`);
      await Deno.writeTextFile(`${dir}/taken.test.ts`, "");
      await Deno.writeTextFile(`${dir}/fixtures/sample.test.ts`, "");
      await Deno.writeTextFile(`${dir}/passed-test.ts`, "");
      await Deno.writeTextFile(`${dir}/node_modules/vendored.test.ts`, "");

      const parsed: ParsedTestTask = {
        env: {},
        flags: [],
        paths: ["."],
        ignores: [],
      };
      expect(await collectTestFiles(dir)).toEqual(["taken.test.ts"]);
      expect(await collectTestFiles(dir))
        .toEqual(await memberTestFiles(dir, parsed));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
  it("runs every file locally when no shard is selected", () => {
    expect(selectShardedTestFiles(
      ["b.test.ts", "a.test.ts"],
      undefined,
      {},
      1,
    )).toEqual(["a.test.ts", "b.test.ts"]);
  });

  it("covers every file exactly once across weighted shards", () => {
    const files = ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"];
    const weights = { "a.test.ts": 10, "b.test.ts": 4 };
    const selected = [1, 2, 3].flatMap((index) =>
      selectShardedTestFiles(files, { index, total: 3 }, weights, 1)
    );

    expect(selected.sort()).toEqual(files);
  });

  it("keeps each of the five heaviest agents-host files on its own shard", async () => {
    const root = path.fromFileUrl(
      new URL("../packages/connectors/agents/host", import.meta.url),
    );
    const files = await collectTestFiles(root);
    const expensiveFiles = Object.entries(AGENTS_HOST_TEST_WEIGHTS)
      .toSorted(([, left], [, right]) => right - left)
      .slice(0, AGENTS_HOST_SHARDS)
      .map(([file]) => file);
    const shards = Array.from(
      { length: AGENTS_HOST_SHARDS },
      (_, offset) =>
        selectShardedTestFiles(
          files,
          { index: offset + 1, total: AGENTS_HOST_SHARDS },
          AGENTS_HOST_TEST_WEIGHTS,
          0.4,
        ),
    );

    expect(expensiveFiles).toHaveLength(AGENTS_HOST_SHARDS);
    expect(shards.flat().toSorted()).toEqual(files.toSorted());
    const placements = expensiveFiles.map((file) => ({
      file,
      shardIndexes: shards.flatMap((shard, index) =>
        shard.includes(file) ? [index] : []
      ),
    }));
    expect(
      placements.filter(({ shardIndexes }) => shardIndexes.length !== 1),
    ).toEqual([]);
    expect(
      new Set(placements.flatMap(({ shardIndexes }) => shardIndexes)).size,
    ).toBe(expensiveFiles.length);
  });

  it("rejects more shards than test files", () => {
    expect(() =>
      selectShardedTestFiles(
        ["a.test.ts"],
        { index: 1, total: Number.MAX_SAFE_INTEGER },
        {},
        1,
      )
    ).toThrow("Shard count 9007199254740991 exceeds test file count 1.");
  });
});
