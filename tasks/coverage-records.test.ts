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
    [coverageMetricForGroup("packages/memory"), 40],
    [measuredSetCoverageMetric("workspace-unit/packages/memory"), 12],
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
        groups: new Map([["workspace", 900], ["packages/memory", 40]]),
        sets: new Map([["workspace-unit/packages/memory", 12]]),
        cold: true,
      });
    } finally {
      await Deno.remove(spool, { recursive: true });
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
