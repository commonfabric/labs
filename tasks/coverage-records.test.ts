import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  coverageFiguresOf,
  readSpool,
} from "@commonfabric/test-support/records";
import {
  coverageMetricForGroup,
  measuredSetCoverageMetric,
} from "./ci-check-lib.ts";
import { recordCoverage } from "./coverage-records.ts";

describe("recordCoverage()", () => {
  const metrics = [
    [coverageMetricForGroup("workspace"), 900],
    [coverageMetricForGroup("runtime/memory"), 40],
    [measuredSetCoverageMetric("workspace-unit/runtime/memory"), 12],
    ["ci duration: Test", 300],
  ] as const;

  /** An environment naming `spool` as the run's. */
  const naming = (spool: string) => (name: string) =>
    name === "CF_TEST_RECORDS_DIR" ? spool : undefined;

  it("appends each metric under the group or the set its name denotes", async () => {
    const spool = await Deno.makeTempDir({ prefix: "coverage-records-" });
    try {
      recordCoverage(metrics, true, naming(spool));
      expect(coverageFiguresOf((await readSpool(spool)).records)).toEqual({
        groups: new Map([["workspace", 900], ["runtime/memory", 40]]),
        sets: new Map([["workspace-unit/runtime/memory", 12]]),
        cold: true,
      });
    } finally {
      await Deno.remove(spool, { recursive: true });
    }
  });

  it("writes nothing to the process's own spool where the environment it is given names none", async () => {
    // The process's own spool is the one a recording run names, and a
    // fixture's figures filed there would read as that run's. Where this
    // process names none, one is named for the case. The group is the
    // case's own, so figures the run itself records cannot be mistaken
    // for it.
    const named = Deno.env.get("CF_TEST_RECORDS_DIR");
    const spool = named ??
      await Deno.makeTempDir({ prefix: "coverage-records-" });
    if (named === undefined) Deno.env.set("CF_TEST_RECORDS_DIR", spool);
    try {
      recordCoverage(
        [[coverageMetricForGroup("coverage-records-fixture"), 7]],
        false,
        () => undefined,
      );
      const { groups } = coverageFiguresOf((await readSpool(spool)).records);
      expect(groups.has("coverage-records-fixture")).toBe(false);
    } finally {
      if (named === undefined) {
        Deno.env.delete("CF_TEST_RECORDS_DIR");
        await Deno.remove(spool, { recursive: true });
      }
    }
  });

  it("writes nothing where no metric is a figure", async () => {
    const spool = await Deno.makeTempDir({ prefix: "coverage-records-" });
    try {
      recordCoverage([["ci duration: Test", 300]], false, naming(spool));
      expect([...Deno.readDirSync(spool)]).toEqual([]);
    } finally {
      await Deno.remove(spool, { recursive: true });
    }
  });
});
