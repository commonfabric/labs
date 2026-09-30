import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { TILES } from "./registry.ts";
import { type Ctx, runSourceKey } from "./types.ts";

const context: Ctx = {
  runs: () => Promise.resolve([]),
  runsFor: () => Promise.resolve([]),
  env: () => undefined,
};

describe("registry", () => {
  it("registers tiles in dashboard display order", () => {
    expect(TILES.map((tile) => tile.label)).toEqual([
      "ci",
      "labs ci trust",
      "labs ci duration",
      "all benchmarks",
      "weaver ci duration",
      "loom ci trust",
      "loom ci duration",
      "key benchmarks",
      "flaky tests",
      "test selection",
      "coverage debt",
      "prod errors",
      "dau",
      "discord online",
      "github users",
      "production",
      "weaver ci trust",
      "github spend",
      "model spend",
      "cloud spend",
      "recent main runs",
    ]);
  });

  it("collects every tile reading a workflow's runs together", () => {
    // The scheduler collects a snapshot's due tiles from it and publishes them
    // together, and a tile is due once per its own interval. Tiles sharing a
    // snapshot on different intervals would show different moments of it.
    const intervals = new Map<string, Set<number>>();
    for (const tile of TILES) {
      for (const source of tile.runSources ?? []) {
        const key = runSourceKey(source);
        intervals.set(key, (intervals.get(key) ?? new Set()).add(tile.intervalMs));
      }
    }
    for (const held of intervals.values()) expect(held.size).toBe(1);

    // The ci tile's main builds are the ones the ci trust tiles read.
    const sources = (label: string) =>
      TILES.find((tile) => tile.label === label)?.runSources ?? [];
    expect(sources("ci")).toEqual([
      ...sources("labs ci trust"),
      ...sources("loom ci trust"),
    ]);
  });

  it("links both benchmark tiles when credentials are unavailable", async () => {
    for (const [label, href] of [
      ["all benchmarks", "/bench?view=runtime&repo=labs"],
      ["key benchmarks", "/bench?view=runtime&repo=labs&key=1"],
    ]) {
      const tile = TILES.find((tile) => tile.label === label);
      expect(await tile?.collect(context)).toMatchObject({
        status: "unknown",
        value: "—",
        sub: "set GH_TOKEN",
        href,
      });
    }
  });
});
