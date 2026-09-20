import { expect } from "@std/expect";
import { beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import {
  getLogger,
  resetAllLoggerCounts,
  resetAllTimingStats,
} from "@commonfabric/utils/logger";

import { printLoggerStats } from "../../lib/test-runner.ts";

describe("printLoggerStats()", () => {
  const logger = getLogger("logger-stats-test", { enabled: false });

  beforeEach(() => {
    resetAllLoggerCounts();
    resetAllTimingStats();
  });

  it("prints each nonzero log level and the total for absolute counts", () => {
    logger.debug("activity", "debug");
    logger.info("activity", "info");
    logger.warn("activity", "warn");
    logger.error("activity", "error");
    logger.error("activity", "another error");

    const output: string[] = [];
    using _log = stub(console, "log", (line: string) => {
      output.push(line.replace(/\s+/g, " ").trim());
    });

    printLoggerStats(0, false);

    expect(output).toContain(
      "logger-stats-test/activity n= 5 (d:1 i:1 w:1 e:2)",
    );
  });

  it("prints only calls since the baseline and omits unused log levels", () => {
    logger.error("activity", "before baseline");
    logger.resetCountBaseline();
    logger.info("activity", "info");
    logger.error("activity", "error");
    logger.error("activity", "another error");

    const output: string[] = [];
    using _log = stub(console, "log", (line: string) => {
      output.push(line.replace(/\s+/g, " ").trim());
    });

    printLoggerStats(0, true);

    expect(output).toContain("logger-stats-test Δn= 3 (i:1 e:2)");
  });
});
