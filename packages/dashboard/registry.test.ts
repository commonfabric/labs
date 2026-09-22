import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { TILES } from "./registry.ts";
import type { Ctx } from "./types.ts";

const context: Ctx = {
  runs: () => Promise.resolve([]),
  runsFor: () => Promise.resolve([]),
  env: () => undefined,
};

describe("registry", () => {
  it("registers tiles in dashboard display order", () => {
    expect(TILES.map((tile) => tile.label)).toEqual([
      "labs ci",
      "labs ci trust",
      "labs ci duration",
      "all benchmarks",
      "loom ci",
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
      "cubic spend",
      "github spend",
      "model spend",
      "cloud spend",
      "recent main runs",
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

  it("reports cubic spend as a named metric with no value", async () => {
    const cubic = TILES.find((tile) => tile.label === "cubic spend");

    expect(await cubic?.collect(context)).toEqual({
      status: "good",
      value: "—",
      sub: "api does not expose value",
    });
  });
});
