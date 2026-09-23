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
      "ci",
      "labs ci trust",
      "labs ci duration",
      "all benchmarks",
      "your metric here",
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

  it("keeps a green slot open for a metric nobody has chosen yet", async () => {
    const empty = TILES.find((tile) => tile.label === "your metric here");

    expect(await empty?.collect(context)).toEqual({
      status: "good",
      value: "—",
      sub: "do you have data to show?",
    });
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
