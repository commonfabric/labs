import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  CONFIGS,
  runScenario,
  summarizeDiagnostics,
} from "../../perf/run-benchmarks.ts";

describe("run-benchmarks", () => {
  describe("summarizeDiagnostics()", () => {
    it("returns the instantiation count and the check time, in order", () => {
      const output = [
        "Files:                         12",
        "Types:                        345",
        "Instantiations:              6789  ",
        "Memory used:               54321K",
        "Check time:                 0.42s",
        "Total time:                 1.23s",
      ].join("\n");
      expect(summarizeDiagnostics(output)).toEqual([
        "Instantiations:              6789",
        "Check time:                 0.42s",
      ]);
    });

    it("returns nothing for output without those lines", () => {
      expect(summarizeDiagnostics("Files: 12\nTypes: 345\n")).toEqual([]);
      expect(summarizeDiagnostics("  Instantiations: 1\n")).toEqual([]);
    });
  });

  describe("runScenario()", () => {
    // The harness compiles its scenarios with the pinned `tsc` under Node16
    // resolution rather than Deno's, so `deno task check` passing says
    // nothing about it. Compiling the empty control case fails when the pin
    // is missing from the lockfile or the cache, or when the API imports a
    // workspace module that the hand-kept `paths` map in
    // `perf/tsconfig.base.json` does not resolve.

    it("reports the summary of the control case's compile", async () => {
      const report = await runScenario("tsconfig.baseline.json");
      expect(report.startsWith("# tsconfig.baseline.json\n")).toBe(true);
      expect(report).toMatch(/^Instantiations: +\d+ \| Check time: +\S+s$/m);
      expect(report.endsWith("----------------------------------------\n"))
        .toBe(true);
    });

    it("throws for a project the compiler cannot open", async () => {
      await expect(runScenario("tsconfig.missing.json")).rejects.toThrow(
        "Benchmark failed for tsconfig.missing.json",
      );
    });
  });

  describe("CONFIGS", () => {
    it("names only scenario projects that exist", async () => {
      for (const config of CONFIGS) {
        const url = new URL(`../../perf/${config}`, import.meta.url);
        expect((await Deno.stat(url)).isFile).toBe(true);
      }
    });
  });
});
