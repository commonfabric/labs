import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { expect } from "@std/expect";
import {
  clearTimingMeasures,
  detailOfMeasure,
  getGlobalLogFloor,
  getLogger,
  getLoggerCountsBreakdown,
  getTimingMeasuresState,
  getTimingStatsBreakdown,
  getTotalLoggerCounts,
  log,
  LOG_COLORS,
  parseTimingMeasureCap,
  resetAllLoggerCounts,
  resetAllTimingStats,
  resetTimingMeasureBudget,
  setGlobalLogFloor,
  setLoggerCountObserver,
  setTimingMeasuresEnabled,
  TIMING_MEASURE_PREFIX,
} from "../src/logger.ts";

describe("logger", () => {
  beforeEach(() => {
    // Reset to default log level before each test
    log.level = "info";
    // Clear global floor so it doesn't interfere with tests
    setGlobalLogFloor(undefined);
  });

  afterEach(() => {
    // Clean up global logger registry after each test
    const global = globalThis as unknown as {
      commonfabric?: { logger?: Record<string, unknown> };
    };
    if (global.commonfabric?.logger) {
      global.commonfabric.logger = {};
    }
  });

  // Helper to check styled timestamp format
  function expectStyledTimestamp(
    calls: unknown[][],
    index: number,
    color: string,
    level: string,
  ) {
    expect(calls[index]![0]).toMatch(
      new RegExp(`^%c\\[${level}\\]\\[\\d{2}:\\d{2}:\\d{2}\\.\\d{3}\\]$`),
    );
    expect(calls[index]![1]).toBe(color);
  }

  // Helper to check styled module::timestamp format
  function expectStyledModuleTimestamp(
    calls: unknown[][],
    index: number,
    module: string,
    color: string,
    level: string,
  ) {
    const pattern = new RegExp(
      `^%c\\[${level}\\]\\[${module}::\\d{2}:\\d{2}:\\d{2}\\.\\d{3}\\]$`,
    );
    expect(calls[index]![0]).toMatch(pattern);
    expect(calls[index]![1]).toBe(color);
  }

  // Helper to capture console output
  function captureConsole<T>(
    method: keyof Console,
    fn: () => T,
  ): { result: T; calls: unknown[][] } {
    const originalMethod = console[method];
    const calls: unknown[][] = [];

    // Mock the console method
    (console[method] as (...args: unknown[]) => void) = (
      ...args: unknown[]
    ) => {
      calls.push(args);
    };

    try {
      const result = fn();
      return { result, calls };
    } finally {
      // Restore original method
      (console[method] as unknown) = originalMethod;
    }
  }

  describe("basic log function", () => {
    it("is enabled by default", () => {
      expect(log.disabled).toBe(false);
    });

    it("logs a message to the console", () => {
      const { calls } = captureConsole("log", () => {
        log.info("test-key", "hello", "world");
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0]!.slice(2)).toEqual(["test-key", "hello", "world"]);
    });

    it("logs every argument it is given", () => {
      const { calls } = captureConsole("log", () => {
        log.info("test-key", "a", 1, true, { key: "value" });
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0]!.slice(2)).toEqual(["test-key", "a", 1, true, {
        key: "value",
      }]);
    });

    it("evaluates a lazy message function", () => {
      let evaluated = false;
      const lazyMessage = () => {
        evaluated = true;
        return "lazy value";
      };

      const { calls } = captureConsole("log", () => {
        log.info("test-key", "static", lazyMessage);
      });

      expect(evaluated).toBe(true);
      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0]!.slice(2)).toEqual(["test-key", "static", "lazy value"]);
    });

    it("logs static and lazy messages together", () => {
      const { calls } = captureConsole("log", () => {
        log.info(
          "test-key",
          "start",
          () => "lazy1",
          "middle",
          () => "lazy2",
          "end",
        );
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0]!.slice(2)).toEqual([
        "test-key",
        "start",
        "lazy1",
        "middle",
        "lazy2",
        "end",
      ]);
    });

    it("flattens an array returned by a lazy message function", () => {
      const { calls } = captureConsole("log", () => {
        log.info(
          "test-key",
          "prefix",
          () => ["array", "of", "values"],
          "suffix",
        );
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0]!.slice(2)).toEqual([
        "test-key",
        "prefix",
        "array",
        "of",
        "values",
        "suffix",
      ]);
    });
  });

  describe("severity levels", () => {
    it("logs at debug level", () => {
      log.level = "debug"; // Enable debug level
      const { calls } = captureConsole("debug", () => {
        log.debug("test-key", "debug message");
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.debug, "DEBUG");
      expect(calls[0]!.slice(2)).toEqual(["test-key", "debug message"]);
    });

    it("logs at info level", () => {
      const { calls } = captureConsole("log", () => {
        log.info("test-key", "info message");
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0]!.slice(2)).toEqual(["test-key", "info message"]);
    });

    it("logs at warn level", () => {
      const { calls } = captureConsole("warn", () => {
        log.warn("test-key", "warning message");
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.warn, "WARN");
      expect(calls[0]!.slice(2)).toEqual(["test-key", "warning message"]);
    });

    it("logs at error level", () => {
      const { calls } = captureConsole("error", () => {
        log.error("test-key", "error message");
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.error, "ERROR");
      expect(calls[0]!.slice(2)).toEqual(["test-key", "error message"]);
    });

    it("logs at info level via `log.info()`", () => {
      const { calls } = captureConsole("log", () => {
        log.info("test-key", "default message");
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0]!.slice(2)).toEqual(["test-key", "default message"]);
    });

    it("logs at info level via `log.log()`", () => {
      const { calls } = captureConsole("log", () => {
        log.log("test-key", "message via log()");
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0]!.slice(2)).toEqual(["test-key", "message via log()"]);
    });
  });

  describe("lazy evaluation", () => {
    it("evaluates a lazy message function at every level", () => {
      log.level = "debug"; // Enable debug level
      const lazyDebug = () => "lazy debug";
      const lazyInfo = () => "lazy info";
      const lazyWarn = () => "lazy warn";
      const lazyError = () => "lazy error";

      const { calls: debugCalls } = captureConsole("debug", () => {
        log.debug("test-key", lazyDebug);
      });
      const { calls: infoCalls } = captureConsole("log", () => {
        log.info("test-key", lazyInfo);
      });
      const { calls: warnCalls } = captureConsole("warn", () => {
        log.warn("test-key", lazyWarn);
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        log.error("test-key", lazyError);
      });

      expect(debugCalls[0]!.slice(2)).toEqual(["test-key", "lazy debug"]);
      expect(infoCalls[0]!.slice(2)).toEqual(["test-key", "lazy info"]);
      expect(warnCalls[0]!.slice(2)).toEqual(["test-key", "lazy warn"]);
      expect(errorCalls[0]!.slice(2)).toEqual(["test-key", "lazy error"]);
    });

    it("does not evaluate a lazy message function when disabled", () => {
      log.disabled = true;
      let evaluated = false;
      const lazyMessage = () => {
        evaluated = true;
        return "should not be evaluated";
      };

      const { calls } = captureConsole("log", () => {
        log.info("test-key", lazyMessage);
      });

      expect(evaluated).toBe(false);
      expect(calls).toHaveLength(0);

      // Re-enable for other tests
      log.disabled = false;
    });
  });

  describe("log level filtering", () => {
    it("drops a message below the current level", () => {
      log.level = "warn"; // Only show warn and error

      const { calls: debugCalls } = captureConsole("debug", () => {
        log.debug("test-key", "debug message");
      });
      const { calls: infoCalls } = captureConsole("log", () => {
        log.info("test-key", "info message");
      });
      const { calls: warnCalls } = captureConsole("warn", () => {
        log.warn("test-key", "warning message");
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        log.error("test-key", "error message");
      });

      expect(debugCalls).toHaveLength(0);
      expect(infoCalls).toHaveLength(0);
      expect(warnCalls).toHaveLength(1);
      expect(errorCalls).toHaveLength(1);
    });

    it("logs at every level when the level is `debug`", () => {
      log.level = "debug"; // Enable all levels
      const { calls: debugCalls } = captureConsole("debug", () => {
        log.debug("test-key", "debug message");
      });
      const { calls: infoCalls } = captureConsole("log", () => {
        log.info("test-key", "info message");
      });
      const { calls: warnCalls } = captureConsole("warn", () => {
        log.warn("test-key", "warning message");
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        log.error("test-key", "error message");
      });

      expect(debugCalls).toHaveLength(1);
      expect(infoCalls).toHaveLength(1);
      expect(warnCalls).toHaveLength(1);
      expect(errorCalls).toHaveLength(1);
    });

    it("logs only errors when the level is `error`", () => {
      log.level = "error";
      const { calls: debugCalls } = captureConsole("debug", () => {
        log.debug("test-key", "debug message");
      });
      const { calls: infoCalls } = captureConsole("log", () => {
        log.info("test-key", "info message");
      });
      const { calls: warnCalls } = captureConsole("warn", () => {
        log.warn("test-key", "warning message");
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        log.error("test-key", "error message");
      });

      expect(debugCalls).toHaveLength(0);
      expect(infoCalls).toHaveLength(0);
      expect(warnCalls).toHaveLength(0);
      expect(errorCalls).toHaveLength(1);
    });
  });

  describe("log level management", () => {
    it("takes effect when `.level` is reassigned", () => {
      // Test default level
      expect(log.level).toBe("info"); // Default

      // Test setting to debug
      log.level = "debug";
      expect(log.level).toBe("debug");

      // Test setting to error
      log.level = "error";
      expect(log.level).toBe("error");
    });
  });

  describe("tagged logger", () => {
    it("prefixes output with the module name", () => {
      const logger = getLogger("test-module");
      const { calls } = captureConsole("log", () => {
        logger.info("test-key", "test message");
      });

      expect(calls).toHaveLength(1);
      expectStyledModuleTimestamp(
        calls,
        0,
        "test-module",
        LOG_COLORS.taggedInfo,
        "INFO",
      );
      expect(calls[0]!.slice(2)).toEqual(["test-key", "test message"]);
    });

    it("logs at info level via `log()`", () => {
      const logger = getLogger("test-module");
      const { calls } = captureConsole("log", () => {
        logger.log("test-key", "test message via log()");
      });

      expect(calls).toHaveLength(1);
      expectStyledModuleTimestamp(
        calls,
        0,
        "test-module",
        LOG_COLORS.taggedInfo,
        "INFO",
      );
      expect(calls[0]!.slice(2)).toEqual([
        "test-key",
        "test message via log()",
      ]);
    });

    it("logs at every level", () => {
      const logger = getLogger("test-module");
      logger.level = "debug"; // Enable all levels

      const { calls: debugCalls } = captureConsole("debug", () => {
        logger.debug("test-key", "debug message");
      });
      const { calls: infoCalls } = captureConsole("log", () => {
        logger.info("test-key", "info message");
      });
      const { calls: warnCalls } = captureConsole("warn", () => {
        logger.warn("test-key", "warning message");
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        logger.error("test-key", "error message");
      });

      expect(debugCalls).toHaveLength(1);
      expect(infoCalls).toHaveLength(1);
      expect(warnCalls).toHaveLength(1);
      expect(errorCalls).toHaveLength(1);

      expectStyledModuleTimestamp(
        debugCalls,
        0,
        "test-module",
        LOG_COLORS.taggedDebug,
        "DEBUG",
      );
      expectStyledModuleTimestamp(
        infoCalls,
        0,
        "test-module",
        LOG_COLORS.taggedInfo,
        "INFO",
      );
      expectStyledModuleTimestamp(
        warnCalls,
        0,
        "test-module",
        LOG_COLORS.taggedWarn,
        "WARN",
      );
      expectStyledModuleTimestamp(
        errorCalls,
        0,
        "test-module",
        LOG_COLORS.taggedError,
        "ERROR",
      );
    });

    it("drops a message below its own level", () => {
      const logger = getLogger("test-module", { level: "warn" });

      const { calls: debugCalls } = captureConsole("debug", () => {
        logger.debug("test-key", "debug message");
      });
      const { calls: infoCalls } = captureConsole("log", () => {
        logger.info("test-key", "info message");
      });
      const { calls: warnCalls } = captureConsole("warn", () => {
        logger.warn("test-key", "warning message");
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        logger.error("test-key", "error message");
      });

      expect(debugCalls).toHaveLength(0);
      expect(infoCalls).toHaveLength(0);
      expect(warnCalls).toHaveLength(1);
      expect(errorCalls).toHaveLength(1);
    });

    it("evaluates a lazy message function", () => {
      const logger = getLogger("test-module");
      let evaluated = false;
      const lazyMessage = () => {
        evaluated = true;
        return "lazy tagged message";
      };

      const { calls } = captureConsole("log", () => {
        logger.info("test-key", lazyMessage);
      });

      expect(evaluated).toBe(true);
      expect(calls).toHaveLength(1);
      expectStyledModuleTimestamp(
        calls,
        0,
        "test-module",
        LOG_COLORS.taggedInfo,
        "INFO",
      );
      expect(calls[0]!.slice(2)).toEqual(["test-key", "lazy tagged message"]);
    });

    it("logs nothing and evaluates nothing when constructed disabled", () => {
      const logger = getLogger("test-module", { enabled: false });
      let evaluated = false;
      const lazyMessage = () => {
        evaluated = true;
        return "should not be evaluated";
      };

      const { calls } = captureConsole("log", () => {
        logger.info("test-key", lazyMessage);
      });

      expect(evaluated).toBe(false);
      expect(calls).toHaveLength(0);
      expect(logger.disabled).toBe(true);
    });

    it("is enabled by default", () => {
      const logger = getLogger("test-module");
      expect(logger.disabled).toBe(false);

      const { calls } = captureConsole("log", () => {
        logger.info("test-key", "should show by default");
      });

      expect(calls).toHaveLength(1);
    });

    it("starts and stops logging as `.disabled` is reassigned", () => {
      const logger = getLogger("test-module", { enabled: false });

      // Initially disabled
      const { calls: disabledCalls } = captureConsole("log", () => {
        logger.info("test-key", "should not show");
      });
      expect(disabledCalls).toHaveLength(0);

      // Enable at runtime
      logger.disabled = false;
      const { calls: enabledCalls } = captureConsole("log", () => {
        logger.info("test-key", "should show");
      });
      expect(enabledCalls).toHaveLength(1);

      // Disable again
      logger.disabled = true;
      const { calls: disabledAgainCalls } = captureConsole("log", () => {
        logger.info("test-key", "should not show again");
      });
      expect(disabledAgainCalls).toHaveLength(0);
    });
  });

  describe("global vs tagged logger", () => {
    it("formats a tagged logger's output differently from the global one", () => {
      const taggedLogger = getLogger("test-module");

      const { calls: globalCalls } = captureConsole("log", () => {
        log.info("test-key", "global message");
      });
      const { calls: taggedCalls } = captureConsole("log", () => {
        taggedLogger.info("tagged message");
      });

      expect(globalCalls).toHaveLength(1);
      expect(taggedCalls).toHaveLength(1);

      // Global should not have module name
      expect(globalCalls[0]![0]).toMatch(
        /^%c\[INFO\]\[\d{2}:\d{2}:\d{2}\.\d{3}\]$/,
      );
      expect(globalCalls[0]![1]).toBe(LOG_COLORS.info);

      // Tagged should have module name
      expect(taggedCalls[0]![0]).toMatch(
        /^%c\[INFO\]\[test-module::\d{2}:\d{2}:\d{2}\.\d{3}\]$/,
      );
      expect(taggedCalls[0]![1]).toBe(LOG_COLORS.taggedInfo);
    });

    it("keeps its level independent of the global logger's", () => {
      const taggedLogger = getLogger("test-module");

      // Set different levels
      log.level = "warn";
      taggedLogger.level = "debug";

      const { calls: globalDebugCalls } = captureConsole("debug", () => {
        log.debug("test-key", "global debug");
      });
      const { calls: globalWarnCalls } = captureConsole("warn", () => {
        log.warn("test-key", "global warn");
      });
      const { calls: taggedDebugCalls } = captureConsole("debug", () => {
        taggedLogger.debug("tagged debug");
      });
      const { calls: taggedWarnCalls } = captureConsole("warn", () => {
        taggedLogger.warn("tagged warn");
      });

      // Global logger should filter debug
      expect(globalDebugCalls).toHaveLength(0);
      expect(globalWarnCalls).toHaveLength(1);

      // Tagged logger should show debug
      expect(taggedDebugCalls).toHaveLength(1);
      expect(taggedWarnCalls).toHaveLength(1);
    });
  });

  describe("call counting", () => {
    it("starts every count at `0`", () => {
      const logger = getLogger("count-test");
      expect(logger.counts.debug).toBe(0);
      expect(logger.counts.info).toBe(0);
      expect(logger.counts.warn).toBe(0);
      expect(logger.counts.error).toBe(0);
      expect(logger.counts.total).toBe(0);
    });

    it("reports `total` as a data property", () => {
      const logger = getLogger("count-inert-test");
      captureConsole("log", () => logger.info("test-key", "test"));

      // A caller may carry the snapshot across a realm boundary, and an
      // accessor is live code rather than the inert data such a crossing
      // takes.
      expect(Object.getOwnPropertyDescriptor(logger.counts, "total")).toEqual({
        value: 1,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    });

    it("increments the count for the level logged at", () => {
      const logger = getLogger("count-test");
      logger.level = "debug"; // Enable all levels

      captureConsole("debug", () => logger.debug("test-key", "test"));
      expect(logger.counts.debug).toBe(1);
      expect(logger.counts.total).toBe(1);

      captureConsole("log", () => logger.info("test-key", "test"));
      expect(logger.counts.info).toBe(1);
      expect(logger.counts.total).toBe(2);

      captureConsole("warn", () => logger.warn("test-key", "test"));
      expect(logger.counts.warn).toBe(1);
      expect(logger.counts.total).toBe(3);

      captureConsole("error", () => logger.error("test-key", "test"));
      expect(logger.counts.error).toBe(1);
      expect(logger.counts.total).toBe(4);
    });

    it("increments the count when the logger is disabled", () => {
      const logger = getLogger("count-test", { enabled: false });

      captureConsole("debug", () => logger.debug("test-key", "test"));
      captureConsole("log", () => logger.info("test-key", "test"));
      captureConsole("warn", () => logger.warn("test-key", "test"));
      captureConsole("error", () => logger.error("test-key", "test"));

      expect(logger.counts.debug).toBe(1);
      expect(logger.counts.info).toBe(1);
      expect(logger.counts.warn).toBe(1);
      expect(logger.counts.error).toBe(1);
      expect(logger.counts.total).toBe(4);
    });

    it("increments the count when the level filters the message out", () => {
      const logger = getLogger("count-test", { level: "error" });

      captureConsole("debug", () => logger.debug("test-key", "test"));
      captureConsole("log", () => logger.info("test-key", "test"));
      captureConsole("warn", () => logger.warn("test-key", "test"));
      captureConsole("error", () => logger.error("test-key", "test"));

      // All counts should increment even though only error was logged
      expect(logger.counts.debug).toBe(1);
      expect(logger.counts.info).toBe(1);
      expect(logger.counts.warn).toBe(1);
      expect(logger.counts.error).toBe(1);
      expect(logger.counts.total).toBe(4);
    });

    it("increments the count without evaluating a lazy message function", () => {
      const logger = getLogger("count-test", { enabled: false });
      let evaluated = false;
      const lazyMessage = () => {
        evaluated = true;
        return "should not be evaluated";
      };

      captureConsole("log", () => logger.info("test-key", lazyMessage));

      expect(evaluated).toBe(false); // Function not evaluated
      expect(logger.counts.info).toBe(1); // But count was incremented
    });

    it("reports `.total` as the sum of the per-level counts", () => {
      const logger = getLogger("count-test");
      logger.level = "debug";

      captureConsole("debug", () => {
        logger.debug("test-key", "test1");
        logger.debug("test-key", "test2");
      });
      captureConsole("log", () => {
        logger.info("test-key", "test1");
        logger.info("test-key", "test2");
        logger.info("test-key", "test3");
      });
      captureConsole("warn", () => logger.warn("test-key", "test"));
      captureConsole("error", () => {
        logger.error("test-key", "test1");
        logger.error("test-key", "test2");
      });

      expect(logger.counts.debug).toBe(2);
      expect(logger.counts.info).toBe(3);
      expect(logger.counts.warn).toBe(1);
      expect(logger.counts.error).toBe(2);
      expect(logger.counts.total).toBe(8);
    });

    it("returns every count to `0` on `resetCounts()`", () => {
      const logger = getLogger("count-test");
      logger.level = "debug";

      // Generate some counts
      captureConsole("debug", () => logger.debug("test-key", "test"));
      captureConsole("log", () => logger.info("test-key", "test"));
      captureConsole("warn", () => logger.warn("test-key", "test"));
      captureConsole("error", () => logger.error("test-key", "test"));

      expect(logger.counts.total).toBe(4);

      // Reset counts
      logger.resetCounts();

      expect(logger.counts.debug).toBe(0);
      expect(logger.counts.info).toBe(0);
      expect(logger.counts.warn).toBe(0);
      expect(logger.counts.error).toBe(0);
      expect(logger.counts.total).toBe(0);
    });

    it("counts a `log()` call as info", () => {
      const logger = getLogger("count-test");

      captureConsole("log", () => logger.log("test-key", "test"));

      expect(logger.counts.info).toBe(1);
      expect(logger.counts.debug).toBe(0);
      expect(logger.counts.total).toBe(1);
    });
  });

  describe("logger reuse", () => {
    it("returns the same instance for the same module name", () => {
      const logger1 = getLogger("reuse-test");
      const logger2 = getLogger("reuse-test");

      expect(logger1).toBe(logger2);
    });

    it("keeps its counts across a second `getLogger()` call", () => {
      const logger1 = getLogger("reuse-test");

      captureConsole("log", () => logger1.info("test-key", "test"));
      expect(logger1.counts.info).toBe(1);

      // Get the "same" logger again
      const logger2 = getLogger("reuse-test");
      expect(logger2.counts.info).toBe(1); // Count preserved
      expect(logger2).toBe(logger1); // Same instance
    });

    it("ignores options given for a module name it already has", () => {
      const logger1 = getLogger("reuse-test", { enabled: true, level: "info" });
      const logger2 = getLogger("reuse-test", {
        enabled: false,
        level: "debug",
      });

      expect(logger1).toBe(logger2);
      expect(logger2.disabled).toBe(false); // Original options preserved
      expect(logger2.level).toBe("info"); // Original options preserved
    });

    it("is reachable at `globalThis.commonfabric.logger`", () => {
      const logger = getLogger("global-test");
      const global = globalThis as unknown as {
        commonfabric: { logger: Record<string, typeof logger> };
      };

      expect(global.commonfabric.logger["global-test"]).toBe(logger);
    });
  });

  describe("count baselines", () => {
    it("reports every count as a delta once a baseline is set", () => {
      const logger = getLogger("count-baseline-test");
      logger.info("before", () => ["before"]);
      logger.warn("before", () => ["before"]);

      logger.resetCountBaseline();
      logger.warn("after", () => ["after"]);
      logger.error("after", () => ["after"]);

      expect(logger.getCountDeltas()).toEqual({
        debug: 0,
        info: 0,
        warn: 1,
        error: 1,
        total: 2,
      });
    });

    it("reports the counts themselves while no baseline is set", () => {
      const logger = getLogger("count-no-baseline-test");
      logger.debug("one", () => ["one"]);
      logger.info("two", () => ["two"]);

      expect(logger.getCountDeltas()).toEqual({
        debug: 1,
        info: 1,
        warn: 0,
        error: 0,
        total: 2,
      });
    });
  });

  describe("resetAllLoggerCounts()", () => {
    it("returns every logger's counts to `0`", () => {
      const logger1 = getLogger("reset-all-test-1");
      const logger2 = getLogger("reset-all-test-2");
      const logger3 = getLogger("reset-all-test-3");

      // Generate counts
      captureConsole("log", () => {
        logger1.info("test-key", "test");
        logger1.info("test-key", "test");
        logger2.info("test-key", "test");
        logger3.info("test-key", "test");
        logger3.info("test-key", "test");
        logger3.info("test-key", "test");
      });

      expect(logger1.counts.info).toBe(2);
      expect(logger2.counts.info).toBe(1);
      expect(logger3.counts.info).toBe(3);

      // Reset all
      resetAllLoggerCounts();

      expect(logger1.counts.info).toBe(0);
      expect(logger2.counts.info).toBe(0);
      expect(logger3.counts.info).toBe(0);
      expect(logger1.counts.total).toBe(0);
      expect(logger2.counts.total).toBe(0);
      expect(logger3.counts.total).toBe(0);
    });

    it("does not throw when the registry is empty", () => {
      // Clean up registry
      const global = globalThis as unknown as {
        commonfabric?: { logger?: Record<string, unknown> };
      };
      if (global.commonfabric?.logger) {
        global.commonfabric.logger = {};
      }

      // Should not throw
      expect(() => resetAllLoggerCounts()).not.toThrow();
    });

    it("leaves later increments working normally", () => {
      const logger = getLogger("reset-all-test");

      captureConsole("log", () => logger.info("test-key", "test"));
      expect(logger.counts.info).toBe(1);

      resetAllLoggerCounts();
      expect(logger.counts.info).toBe(0);

      // Counts should work normally after reset
      captureConsole("log", () => logger.info("test-key", "test"));
      expect(logger.counts.info).toBe(1);
    });
  });

  describe("setLoggerCountObserver()", () => {
    afterEach(() => setLoggerCountObserver(undefined));

    it("reports each counted call with its logger, key and level, disabled or not", () => {
      const counted: string[] = [];
      setLoggerCountObserver((moduleName, key, level) => {
        counted.push(`${moduleName}/${key}/${level}`);
      });
      const logger = getLogger("count-observer-test", { enabled: false });

      logger.debug("a", "x");
      logger.warn("b", "x");
      logger.error("a", "x");

      expect(counted).toStrictEqual([
        "count-observer-test/a/debug",
        "count-observer-test/b/warn",
        "count-observer-test/a/error",
      ]);
    });

    it("reports nothing once given `undefined`", () => {
      const counted: string[] = [];
      setLoggerCountObserver((_moduleName, key) => {
        counted.push(key);
      });
      const logger = getLogger("count-observer-removal-test", {
        enabled: false,
      });

      logger.warn("before", "x");
      setLoggerCountObserver(undefined);
      logger.warn("after", "x");

      expect(counted).toStrictEqual(["before"]);
      expect(logger.countsByKey["after"]?.warn).toBe(1);
    });
  });

  describe("getTotalLoggerCounts()", () => {
    it("returns the total across every logger", () => {
      const logger1 = getLogger("total-test-1");
      const logger2 = getLogger("total-test-2");
      const logger3 = getLogger("total-test-3");

      logger1.level = "debug";
      logger2.level = "debug";
      logger3.level = "debug";

      // Generate different counts for each logger
      captureConsole("debug", () => logger1.debug("test-key", "test"));
      captureConsole("log", () => {
        logger1.info("test-key", "test");
        logger1.info("test-key", "test");
      });

      captureConsole("warn", () => {
        logger2.warn("test-key", "test");
        logger2.warn("test-key", "test");
        logger2.warn("test-key", "test");
      });

      captureConsole("error", () => {
        logger3.error("test-key", "test");
        logger3.error("test-key", "test");
        logger3.error("test-key", "test");
        logger3.error("test-key", "test");
      });

      // logger1: 1 debug + 2 info = 3
      // logger2: 3 warn = 3
      // logger3: 4 error = 4
      // Total: 10
      expect(getTotalLoggerCounts()).toBe(10);
    });

    it("returns `0` when no logger exists", () => {
      // Clean up registry
      const global = globalThis as unknown as {
        commonfabric?: { logger?: Record<string, unknown> };
      };
      if (global.commonfabric?.logger) {
        global.commonfabric.logger = {};
      }

      expect(getTotalLoggerCounts()).toBe(0);
    });

    it("returns `0` when every count is `0`", () => {
      getLogger("total-test-zero-1");
      getLogger("total-test-zero-2");

      expect(getTotalLoggerCounts()).toBe(0);
    });

    it("rises as further calls are logged", () => {
      const logger = getLogger("total-test-update");

      expect(getTotalLoggerCounts()).toBe(0);

      captureConsole("log", () => logger.info("test-key", "test"));
      expect(getTotalLoggerCounts()).toBe(1);

      captureConsole("log", () => logger.info("test-key", "test"));
      expect(getTotalLoggerCounts()).toBe(2);
    });

    it("returns to `0` after `resetAllLoggerCounts()`", () => {
      const logger1 = getLogger("total-test-reset-1");
      const logger2 = getLogger("total-test-reset-2");

      captureConsole("log", () => {
        logger1.info("test-key", "test");
        logger2.info("test-key", "test");
        logger2.info("test-key", "test");
      });

      expect(getTotalLoggerCounts()).toBe(3);

      resetAllLoggerCounts();
      expect(getTotalLoggerCounts()).toBe(0);
    });
  });

  describe("getLoggerCountsBreakdown()", () => {
    it("returns a per-logger breakdown plus a total", () => {
      const logger1 = getLogger("breakdown-test-1");
      const logger2 = getLogger("breakdown-test-2");
      const logger3 = getLogger("breakdown-test-3");

      captureConsole("log", () => {
        logger1.info("test-key", "test");
        logger1.info("test-key", "test");
        logger2.info("test-key", "test");
        logger2.info("test-key", "test");
        logger2.info("test-key", "test");
        logger3.info("test-key", "test");
      });

      const breakdown = getLoggerCountsBreakdown();

      // Now returns nested structure with message keys
      expect(breakdown["breakdown-test-1"]!.total).toBe(2);
      expect(breakdown["breakdown-test-2"]!.total).toBe(3);
      expect(breakdown["breakdown-test-3"]!.total).toBe(1);
      expect(breakdown.total).toBe(6);
    });

    it("returns an empty breakdown and a `0` total when no logger exists", () => {
      // Clean up registry
      const global = globalThis as unknown as {
        commonfabric?: { logger?: Record<string, unknown> };
      };
      if (global.commonfabric?.logger) {
        global.commonfabric.logger = {};
      }

      const breakdown = getLoggerCountsBreakdown();
      expect(breakdown.total).toBe(0);
      expect(Object.keys(breakdown).length).toBe(1); // Only 'total' key
    });

    it("rises as further calls are logged", () => {
      const logger = getLogger("breakdown-update-test");

      let breakdown = getLoggerCountsBreakdown();
      expect(breakdown["breakdown-update-test"]!.total).toBe(0);
      expect(breakdown.total).toBe(0);

      captureConsole("log", () => logger.info("test-key", "test"));

      breakdown = getLoggerCountsBreakdown();
      expect(breakdown["breakdown-update-test"]!.total).toBe(1);
      expect(breakdown.total).toBe(1);
    });

    it("returns to `0` after `resetAllLoggerCounts()`", () => {
      const logger1 = getLogger("breakdown-reset-1");
      const logger2 = getLogger("breakdown-reset-2");

      captureConsole("log", () => {
        logger1.info("test-key", "test");
        logger2.info("test-key", "test");
        logger2.info("test-key", "test");
      });

      let breakdown = getLoggerCountsBreakdown();
      expect(breakdown["breakdown-reset-1"]!.total).toBe(1);
      expect(breakdown["breakdown-reset-2"]!.total).toBe(2);
      expect(breakdown.total).toBe(3);

      resetAllLoggerCounts();

      breakdown = getLoggerCountsBreakdown();
      expect(breakdown["breakdown-reset-1"]!.total).toBe(0);
      expect(breakdown["breakdown-reset-2"]!.total).toBe(0);
      expect(breakdown.total).toBe(0);
    });

    it("reports the same total as `getTotalLoggerCounts()`", () => {
      const logger1 = getLogger("breakdown-match-1");
      const logger2 = getLogger("breakdown-match-2");

      captureConsole("log", () => {
        logger1.info("test-key", "test");
        logger1.info("test-key", "test");
        logger2.info("test-key", "test");
      });

      const breakdown = getLoggerCountsBreakdown();
      const total = getTotalLoggerCounts();

      expect(breakdown.total).toBe(total);
      expect(breakdown.total).toBe(3);
    });
  });

  describe("logCountEvery", () => {
    it("logs a summary every `100` calls by default", () => {
      const logger = getLogger("count-every-test");
      logger.level = "debug"; // Enable debug to see summary

      const { calls } = captureConsole("debug", () => {
        // Make exactly 100 calls
        for (let i = 0; i < 100; i++) {
          logger.info("test-key", "test");
        }
      });

      // Should have logged the summary once
      const summaryLogs = calls.filter((call) =>
        call.some((arg) => String(arg).includes("100 log calls made"))
      );
      expect(summaryLogs).toHaveLength(1);
      expect(summaryLogs[0]!.some((arg) => String(arg).includes("info: 100")))
        .toBe(true);
    });

    it("logs a summary at the configured interval", () => {
      const logger = getLogger("count-every-custom", {
        logCountEvery: 50,
        level: "debug",
      });

      const { calls } = captureConsole("debug", () => {
        // Make exactly 50 calls
        for (let i = 0; i < 50; i++) {
          logger.info("test-key", "test");
        }
      });

      // Should have logged the summary once at 50
      const summaryLogs = calls.filter((call) =>
        call.some((arg) => String(arg).includes("50 log calls made"))
      );
      expect(summaryLogs).toHaveLength(1);
    });

    it("logs no summary when `logCountEvery` is `0`", () => {
      const logger = getLogger("count-every-disabled", {
        logCountEvery: 0,
        level: "debug",
      });

      const { calls } = captureConsole("debug", () => {
        // Make 150 calls
        for (let i = 0; i < 150; i++) {
          logger.info("test-key", "test");
        }
      });

      // Should not have any summary logs
      const summaryLogs = calls.filter((call) =>
        call.some((arg) => String(arg).includes("log calls made"))
      );
      expect(summaryLogs).toHaveLength(0);
    });

    it("logs a summary at each successive threshold", () => {
      const logger = getLogger("count-every-multiple", {
        logCountEvery: 25,
        level: "debug",
      });

      const { calls } = captureConsole("debug", () => {
        // Make 75 calls (should trigger at 25, 50, 75)
        for (let i = 0; i < 75; i++) {
          logger.info("test-key", "test");
        }
      });

      const summaryLogs = calls.filter((call) =>
        call.some((arg) => String(arg).includes("log calls made"))
      );
      expect(summaryLogs).toHaveLength(3);

      // Check each threshold
      expect(
        summaryLogs[0]!.some((arg) =>
          String(arg).includes("25 log calls made")
        ),
      ).toBe(true);
      expect(
        summaryLogs[1]!.some((arg) =>
          String(arg).includes("50 log calls made")
        ),
      ).toBe(true);
      expect(
        summaryLogs[2]!.some((arg) =>
          String(arg).includes("75 log calls made")
        ),
      ).toBe(true);
    });

    it("logs no summary when the level excludes debug", () => {
      const logger = getLogger("count-every-no-debug", {
        logCountEvery: 50,
        level: "info", // Debug not enabled
      });

      const { calls } = captureConsole("debug", () => {
        // Make 100 calls
        for (let i = 0; i < 100; i++) {
          logger.info("test-key", "test");
        }
      });

      // Summary should not be logged since debug level is filtered
      expect(calls).toHaveLength(0);
    });

    it("names every log level in the summary", () => {
      const logger = getLogger("count-every-breakdown", {
        logCountEvery: 10,
        level: "debug",
      });

      const { calls } = captureConsole("debug", () => {
        logger.debug("test-key", "test");
        logger.debug("test-key", "test");
        logger.info("test-key", "test");
        logger.info("test-key", "test");
        logger.info("test-key", "test");
        logger.warn("test-key", "test");
        logger.warn("test-key", "test");
        logger.error("test-key", "test");
        logger.error("test-key", "test");
        logger.error("test-key", "test");
      });

      // Should have one summary at 10
      const summaryLogs = calls.filter((call) =>
        call.some((arg) => String(arg).includes("10 log calls made"))
      );
      expect(summaryLogs).toHaveLength(1);

      // Check breakdown
      const summaryText = summaryLogs[0]!.join(" ");
      expect(summaryText).toContain("debug: 2");
      expect(summaryText).toContain("info: 3");
      expect(summaryText).toContain("warn: 2");
      expect(summaryText).toContain("error: 3");
    });

    it("does not count the summary it logs", () => {
      const logger = getLogger("count-every-no-increment", {
        logCountEvery: 10,
        level: "debug",
      });

      captureConsole("debug", () => {
        // Make exactly 10 calls
        for (let i = 0; i < 10; i++) {
          logger.info("test-key", "test");
        }
      });

      // Counter should be exactly 10, not 11
      expect(logger.counts.total).toBe(10);
      expect(logger.counts.debug).toBe(0); // Summary didn't increment debug
    });

    it("names the module in the summary", () => {
      const logger = getLogger("my-module", {
        logCountEvery: 5,
        level: "debug",
      });

      const { calls } = captureConsole("debug", () => {
        for (let i = 0; i < 5; i++) {
          logger.info("test-key", "test");
        }
      });

      const summaryLogs = calls.filter((call) =>
        call.some((arg) => String(arg).includes("my-module: 5 log calls made"))
      );
      expect(summaryLogs).toHaveLength(1);
    });

    it("counts but logs no summary when the logger is disabled", () => {
      const logger = getLogger("count-every-disabled-logger", {
        logCountEvery: 10,
        level: "debug",
        enabled: false,
      });

      const { calls } = captureConsole("debug", () => {
        for (let i = 0; i < 10; i++) {
          logger.info("test-key", "test");
        }
      });

      // Summary should not be logged because logger is disabled
      expect(calls).toHaveLength(0);

      // But counter should still be at 10
      expect(logger.counts.total).toBe(10);
    });
  });

  describe("countsByKey", () => {
    it("counts separately per message key", () => {
      const logger = getLogger("key-test");
      logger.level = "debug";

      captureConsole("debug", () => {
        logger.debug("user-login", "User logged in");
        logger.debug("user-login", "Another login");
      });
      captureConsole("log", () => {
        logger.info("data-fetch", "Fetched data");
        logger.info("user-login", "Login info message");
      });
      captureConsole("warn", () => {
        logger.warn("user-login", "Login warning");
      });

      const byKey = logger.countsByKey;

      expect(byKey["user-login"]!.debug).toBe(2);
      expect(byKey["user-login"]!.info).toBe(1);
      expect(byKey["user-login"]!.warn).toBe(1);
      expect(byKey["user-login"]!.error).toBe(0);
      expect(byKey["user-login"]!.total).toBe(4);

      expect(byKey["data-fetch"]!.info).toBe(1);
      expect(byKey["data-fetch"]!.total).toBe(1);
    });

    it("reports each key's `total` as a data property", () => {
      const logger = getLogger("key-inert-test");

      captureConsole("log", () => {
        logger.info("key-1", "Message 1");
        logger.info("key-1", "Message 2");
      });

      expect(
        Object.getOwnPropertyDescriptor(logger.countsByKey["key-1"]!, "total"),
      ).toEqual({
        value: 2,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    });

    it("keeps one key's count clear of another's", () => {
      const logger = getLogger("multi-key-test");

      captureConsole("log", () => {
        logger.info("key-a", "Message A");
        logger.info("key-b", "Message B");
        logger.info("key-a", "Another A");
        logger.info("key-c", "Message C");
      });

      const byKey = logger.countsByKey;
      expect(byKey["key-a"]!.total).toBe(2);
      expect(byKey["key-b"]!.total).toBe(1);
      expect(byKey["key-c"]!.total).toBe(1);
    });

    it("clears `.countsByKey` on `resetCounts()`", () => {
      const logger = getLogger("reset-key-test");

      captureConsole("log", () => {
        logger.info("key-1", "Message 1");
        logger.info("key-2", "Message 2");
      });

      expect(logger.countsByKey["key-1"]!.total).toBe(1);
      expect(logger.countsByKey["key-2"]!.total).toBe(1);

      logger.resetCounts();

      expect(Object.keys(logger.countsByKey).length).toBe(0);
    });

    it("counts a key when the logger is disabled", () => {
      const logger = getLogger("disabled-key-test", { enabled: false });

      captureConsole("log", () => {
        logger.info("key-disabled", "Should count");
        logger.info("key-disabled", "Should count again");
      });

      expect(logger.countsByKey["key-disabled"]!.total).toBe(2);
    });
  });

  describe("`getLoggerCountsBreakdown()` with message keys", () => {
    it("nests message keys under each logger", () => {
      const logger1 = getLogger("breakdown-keys-1");
      const logger2 = getLogger("breakdown-keys-2");

      captureConsole("log", () => {
        logger1.info("login", "Login 1");
        logger1.info("login", "Login 2");
        logger1.info("logout", "Logout 1");
        logger2.info("fetch", "Fetch 1");
        logger2.info("fetch", "Fetch 2");
        logger2.info("fetch", "Fetch 3");
      });

      const breakdown = getLoggerCountsBreakdown();

      // Check logger1 breakdown
      expect(breakdown["breakdown-keys-1"]!["login"]!.total).toBe(2);
      expect(breakdown["breakdown-keys-1"]!["logout"]!.total).toBe(1);
      expect(breakdown["breakdown-keys-1"]!.total).toBe(3);

      // Check logger2 breakdown
      expect(breakdown["breakdown-keys-2"]!["fetch"]!.total).toBe(3);
      expect(breakdown["breakdown-keys-2"]!.total).toBe(3);

      // Check global total
      expect(breakdown.total).toBe(6);
    });

    it("gives per-level counts for each message key", () => {
      const logger = getLogger("breakdown-levels");
      logger.level = "debug";

      captureConsole("debug", () => {
        logger.debug("test-op", "Debug 1");
        logger.debug("test-op", "Debug 2");
      });
      captureConsole("log", () => {
        logger.info("test-op", "Info 1");
      });
      captureConsole("warn", () => {
        logger.warn("test-op", "Warn 1");
      });
      captureConsole("error", () => {
        logger.error("test-op", "Error 1");
        logger.error("test-op", "Error 2");
      });

      const breakdown = getLoggerCountsBreakdown();
      const testOp = breakdown["breakdown-levels"]!["test-op"]!;

      expect(testOp.debug).toBe(2);
      expect(testOp.info).toBe(1);
      expect(testOp.warn).toBe(1);
      expect(testOp.error).toBe(2);
      expect(testOp.total).toBe(6);
    });

    it("reports several keys across several loggers", () => {
      const logger1 = getLogger("multi-1");
      const logger2 = getLogger("multi-2");

      captureConsole("log", () => {
        logger1.info("action-a", "A1");
        logger1.info("action-b", "B1");
        logger2.info("action-a", "A2");
        logger2.info("action-c", "C2");
      });

      const breakdown = getLoggerCountsBreakdown();

      expect(breakdown["multi-1"]!["action-a"]!.total).toBe(1);
      expect(breakdown["multi-1"]!["action-b"]!.total).toBe(1);
      expect(breakdown["multi-2"]!["action-a"]!.total).toBe(1);
      expect(breakdown["multi-2"]!["action-c"]!.total).toBe(1);
      expect(breakdown.total).toBe(4);
    });
  });

  describe("timing statistics", () => {
    describe("timeStart/timeEnd", () => {
      it("records an elapsed time for a `timeStart()`/`timeEnd()` pair", () => {
        const logger = getLogger("timing-test-basic");

        logger.timeStart("operation");
        // Small delay to ensure measurable time
        const start = performance.now();
        while (performance.now() - start < 2) {
          // busy wait
        }
        const elapsed = logger.timeEnd("operation");

        expect(elapsed).toBeDefined();
        expect(elapsed).toBeGreaterThanOrEqual(0);

        const stats = logger.getTimeStats("operation");
        expect(stats).toBeDefined();
        expect(stats?.count).toBe(1);
        expect(stats?.min).toBeGreaterThanOrEqual(0);
        expect(stats?.max).toBeGreaterThanOrEqual(0);
      });

      it("returns `undefined` for a `timeEnd()` with no `timeStart()`", () => {
        const logger = getLogger("timing-test-no-start");

        const elapsed = logger.timeEnd("nonexistent");
        expect(elapsed).toBeUndefined();
      });

      it("records a hierarchical key under each of its parents", () => {
        const logger = getLogger("timing-test-hierarchy");

        logger.timeStart("cell", "get", "user-data");
        const elapsed = logger.timeEnd("cell", "get", "user-data");

        expect(elapsed).toBeDefined();

        // Stats are only recorded at the leaf level (no hierarchical rollup)
        const cellStats = logger.getTimeStats("cell");
        const cellGetStats = logger.getTimeStats("cell", "get");
        const cellGetUserStats = logger.getTimeStats(
          "cell",
          "get",
          "user-data",
        );

        expect(cellStats).toBeUndefined();
        expect(cellGetStats).toBeUndefined();
        expect(cellGetUserStats).toBeDefined();

        // Only leaf level has count of 1
        expect(cellGetUserStats?.count).toBe(1);
      });

      it("returns the same stats for a joined path as for segments", () => {
        const logger = getLogger("timing-test-path");

        logger.timeStart("a", "b", "c");
        logger.timeEnd("a", "b", "c");

        // Both ways should work
        const stats1 = logger.getTimeStats("a", "b", "c");
        const stats2 = logger.getTimeStats("a/b/c");

        expect(stats1).toBeDefined();
        expect(stats2).toBeDefined();
        expect(stats1?.count).toBe(1);
        expect(stats2?.count).toBe(1);
      });
    });

    describe("`time()` direct recording", () => {
      it("records an elapsed time from an explicit start", () => {
        const logger = getLogger("timing-test-direct");

        const startTime = performance.now();
        // Small delay
        const delay = performance.now();
        while (performance.now() - delay < 2) {
          // busy wait
        }

        const elapsed = logger.time(startTime, "ipc", "request");

        expect(elapsed).toBeGreaterThanOrEqual(0);

        const stats = logger.getTimeStats("ipc", "request");
        expect(stats).toBeDefined();
        expect(stats?.count).toBe(1);
      });

      it("records an elapsed time from an explicit start and end", () => {
        const logger = getLogger("timing-test-explicit");

        const startTime = 100;
        const endTime = 150;

        const elapsed = logger.time(startTime, endTime, "ipc", "test");

        expect(elapsed).toBe(50);

        const stats = logger.getTimeStats("ipc", "test");
        expect(stats?.min).toBe(50);
        expect(stats?.max).toBe(50);
      });

      it("records a hierarchical key given directly", () => {
        const logger = getLogger("timing-test-direct-hierarchy");

        logger.time(100, 120, "ipc", "CellGet");

        // Only leaf level is recorded (no hierarchical rollup)
        expect(logger.getTimeStats("ipc")?.count).toBeUndefined();
        expect(logger.getTimeStats("ipc", "CellGet")?.count).toBe(1);
        expect(logger.getTimeStats("ipc", "CellGet")?.min).toBe(20);
      });
    });

    describe("timing statistics calculation", () => {
      it("reports `.min`, `.max`, and `.average` over the samples", () => {
        const logger = getLogger("timing-test-stats");

        // Record with explicit times for predictable values
        logger.time(0, 10, "op");
        logger.time(0, 20, "op");
        logger.time(0, 30, "op");
        logger.time(0, 40, "op");
        logger.time(0, 50, "op");

        const stats = logger.getTimeStats("op");

        expect(stats?.count).toBe(5);
        expect(stats?.min).toBe(10);
        expect(stats?.max).toBe(50);
        expect(stats?.totalTime).toBe(150);
        expect(stats?.average).toBe(30);
      });

      it("reports percentiles over the samples", () => {
        const logger = getLogger("timing-test-percentiles");

        // Record 100 samples: 1-100ms
        for (let i = 1; i <= 100; i++) {
          logger.time(0, i, "op");
        }

        const stats = logger.getTimeStats("op");

        expect(stats?.count).toBe(100);
        expect(stats?.min).toBe(1);
        expect(stats?.max).toBe(100);

        // p50 should be around 50
        expect(stats?.p50).toBeGreaterThanOrEqual(40);
        expect(stats?.p50).toBeLessThanOrEqual(60);

        // p95 should be around 95
        expect(stats?.p95).toBeGreaterThanOrEqual(85);
        expect(stats?.p95).toBeLessThanOrEqual(100);
      });

      it("reports `.lastTime` and `.lastTimestamp` from the latest sample", () => {
        const logger = getLogger("timing-test-last");

        logger.time(0, 25, "op");
        const stats1 = logger.getTimeStats("op");
        expect(stats1?.lastTime).toBe(25);
        expect(stats1?.lastTimestamp).toBeGreaterThan(0);

        logger.time(0, 75, "op");
        const stats2 = logger.getTimeStats("op");
        expect(stats2?.lastTime).toBe(75);
        expect(stats2?.lastTimestamp).toBeGreaterThanOrEqual(
          stats1?.lastTimestamp ?? 0,
        );
      });
    });

    describe("`timeStats` property", () => {
      it("returns every recorded key in one flat map", () => {
        const logger = getLogger("timing-test-all");

        logger.time(0, 10, "a", "b");
        logger.time(0, 20, "c");
        logger.time(0, 30, "d", "e", "f");

        const allStats = logger.timeStats;

        // Only leaf level keys are stored (no hierarchical rollup)
        expect(Object.keys(allStats)).toContain("a/b");
        expect(Object.keys(allStats)).toContain("c");
        expect(Object.keys(allStats)).toContain("d/e/f");
      });

      it("returns an empty object when nothing is recorded", () => {
        const logger = getLogger("timing-test-empty");
        const allStats = logger.timeStats;

        expect(Object.keys(allStats)).toHaveLength(0);
      });
    });

    describe("slowest measurements", () => {
      it("keeps the longest five, longest first, with their details", () => {
        const logger = getLogger("timing-test-slowest");

        for (const elapsed of [30, 10, 50, 20, 60, 40, 5]) {
          logger.timeDetailed(`run-${elapsed}`, 0, elapsed, "op");
        }

        const slowest = logger.getTimeStats("op")?.slowest ?? [];
        expect(slowest.map((entry) => entry.elapsed)).toEqual([
          60,
          50,
          40,
          30,
          20,
        ]);
        expect(slowest.map((entry) => entry.detail)).toEqual([
          "run-60",
          "run-50",
          "run-40",
          "run-30",
          "run-20",
        ]);
      });

      it("records when each of the slowest ended on both clocks", () => {
        const logger = getLogger("timing-test-slowest-when");
        const beforeNow = performance.now();
        const beforeEpoch = Date.now();

        logger.time(0, 25, "op");

        const [entry] = logger.getTimeStats("op")?.slowest ?? [];
        expect(entry?.at).toBeGreaterThanOrEqual(beforeNow);
        expect(entry?.at).toBe(logger.getTimeStats("op")?.lastTimestamp);
        expect(entry?.epochMs).toBeGreaterThanOrEqual(beforeEpoch);
        expect(entry?.detail).toBeUndefined();
      });

      it("builds a detail only for a measurement among the slowest", () => {
        const logger = getLogger("timing-test-slowest-lazy");
        let built = 0;
        const detail = () => {
          built++;
          return "built";
        };

        for (let i = 0; i < 5; i++) logger.timeDetailed(detail, 0, 100, "op");
        expect(built).toBe(5);

        logger.timeDetailed(detail, 0, 1, "op");
        expect(built).toBe(5);

        logger.timeDetailed(detail, 0, 200, "op");
        expect(built).toBe(6);
        expect(logger.getTimeStats("op")?.slowest[0]?.elapsed).toBe(200);
      });

      it("keeps a measurement whose detail builder throws, unnamed", () => {
        const logger = getLogger("timing-test-slowest-throws");

        logger.timeDetailed(
          () => {
            throw new Error("no name today");
          },
          0,
          40,
          "op",
        );

        const stats = logger.getTimeStats("op");
        expect(stats?.count).toBe(1);
        expect(stats?.max).toBe(40);
        expect(stats?.slowest).toEqual([
          expect.objectContaining({ elapsed: 40 }),
        ]);
        expect(stats?.slowest[0]?.detail).toBeUndefined();
      });

      it("builds a detail once when both the slowest and the timeline keep it", () => {
        setTimingMeasuresEnabled(true);
        try {
          const logger = getLogger("timing-test-slowest-once");
          let built = 0;

          logger.timeDetailed(
            () => {
              built++;
              return "once";
            },
            0,
            30,
            "op",
          );

          expect(built).toBe(1);
          expect(logger.getTimeStats("op")?.slowest[0]?.detail).toBe("once");
        } finally {
          setTimingMeasuresEnabled(false);
        }
      });

      it("names a timer's span through `timeEndDetailed()` too", () => {
        const logger = getLogger("timing-test-slowest-timer");

        logger.timeStart("phase");
        logger.timeEndDetailed("the-one", "phase");

        expect(logger.getTimeStats("phase")?.slowest[0]?.detail).toBe(
          "the-one",
        );
      });

      it("reports none for a key with no measurements", () => {
        const logger = getLogger("timing-test-slowest-empty");

        logger.time(0, 10, "op");
        logger.resetTimeStats();
        logger.time(0, 10, "op");

        expect(logger.getTimeStats("op")?.slowest).toHaveLength(1);
      });
    });

    describe("resetTimeStats()", () => {
      it("clears every recorded timing", () => {
        const logger = getLogger("timing-test-reset");

        logger.time(0, 10, "op1");
        logger.time(0, 20, "op2");
        logger.timeStart("op3");

        expect(Object.keys(logger.timeStats).length).toBeGreaterThan(0);

        logger.resetTimeStats();

        expect(Object.keys(logger.timeStats)).toHaveLength(0);
        expect(logger.getTimeStats("op1")).toBeUndefined();
        expect(logger.getTimeStats("op2")).toBeUndefined();

        // Active timer should also be cleared
        const elapsed = logger.timeEnd("op3");
        expect(elapsed).toBeUndefined();
      });
    });

    describe("getTimingStatsBreakdown()", () => {
      it("aggregates timings across every logger", () => {
        const logger1 = getLogger("timing-breakdown-1");
        const logger2 = getLogger("timing-breakdown-2");

        logger1.time(0, 10, "op1");
        logger2.time(0, 20, "op2");

        const breakdown = getTimingStatsBreakdown();

        expect(breakdown["timing-breakdown-1"]).toBeDefined();
        expect(breakdown["timing-breakdown-2"]).toBeDefined();
        expect(breakdown["timing-breakdown-1"]!["op1"]?.count).toBe(1);
        expect(breakdown["timing-breakdown-2"]!["op2"]?.count).toBe(1);
      });

      it("omits a logger with no timings", () => {
        const loggerWithTiming = getLogger("timing-breakdown-has-data");
        getLogger("timing-breakdown-no-data"); // Create logger without timing data

        loggerWithTiming.time(0, 10, "op");

        const breakdown = getTimingStatsBreakdown();

        expect(breakdown["timing-breakdown-has-data"]).toBeDefined();
        expect(breakdown["timing-breakdown-no-data"]).toBeUndefined();
      });
    });

    describe("resetAllTimingStats()", () => {
      it("clears every logger's timings", () => {
        const logger1 = getLogger("timing-reset-all-1");
        const logger2 = getLogger("timing-reset-all-2");

        logger1.time(0, 10, "op");
        logger2.time(0, 20, "op");

        expect(Object.keys(logger1.timeStats).length).toBeGreaterThan(0);
        expect(Object.keys(logger2.timeStats).length).toBeGreaterThan(0);

        resetAllTimingStats();

        expect(Object.keys(logger1.timeStats)).toHaveLength(0);
        expect(Object.keys(logger2.timeStats)).toHaveLength(0);
      });

      it("does not throw when the registry is empty", () => {
        // Clean up registry
        const global = globalThis as unknown as {
          commonfabric?: { logger?: Record<string, unknown> };
        };
        if (global.commonfabric?.logger) {
          global.commonfabric.logger = {};
        }

        expect(() => resetAllTimingStats()).not.toThrow();
      });
    });

    describe("timing baselines", () => {
      it("reports totals measured from the baseline", () => {
        const logger = getLogger("timing-baseline-total");

        logger.time(0, 10, "op");
        logger.time(0, 20, "op");
        logger.resetTimingBaseline();
        logger.time(0, 30, "op");
        logger.time(0, 40, "op");

        const stats = logger.getTimeStats("op");
        expect(stats?.count).toBe(4);
        expect(stats?.totalTime).toBe(100);
        expect(stats?.countSinceBaseline).toBe(2);
        expect(stats?.totalTimeSinceBaseline).toBe(70);
        expect(stats?.averageSinceBaseline).toBe(35);
        expect(stats?.cdfSinceBaseline).not.toBeNull();
      });

      it("includes a key first seen after the baseline reset", () => {
        const logger = getLogger("timing-baseline-new-key");

        logger.resetTimingBaseline();
        logger.time(0, 15, "new-op");

        const stats = logger.getTimeStats("new-op");
        expect(stats?.count).toBe(1);
        expect(stats?.countSinceBaseline).toBe(1);
        expect(stats?.totalTimeSinceBaseline).toBe(15);
        expect(stats?.averageSinceBaseline).toBe(15);
        expect(stats?.cdfSinceBaseline).not.toBeNull();
      });
    });

    describe("reservoir sampling", () => {
      it("holds a bounded number of samples however many arrive", () => {
        const logger = getLogger("timing-reservoir-test");

        // Record many samples to test reservoir behavior
        for (let i = 1; i <= 2000; i++) {
          logger.time(0, i, "high-volume");
        }

        const stats = logger.getTimeStats("high-volume");

        expect(stats?.count).toBe(2000);
        expect(stats?.min).toBe(1);
        expect(stats?.max).toBe(2000);

        // Reservoir sampling keeps the percentiles approximately correct. With
        // 2000 samples distributed uniformly over 1-2000, p50 lands around
        // 1000 and p95 around 1900; the margins below are wide enough to
        // absorb the sampling randomness.
        expect(stats?.p50).toBeGreaterThan(500);
        expect(stats?.p50).toBeLessThan(1500);
        expect(stats?.p95).toBeGreaterThan(1500);
        expect(stats?.p95).toBeLessThanOrEqual(2000);
      });
    });

    describe("edge cases", () => {
      it("reports `0` for a zero-length measurement", () => {
        const logger = getLogger("timing-zero");

        logger.time(100, 100, "zero-time");

        const stats = logger.getTimeStats("zero-time");
        expect(stats?.min).toBe(0);
        expect(stats?.max).toBe(0);
        expect(stats?.average).toBe(0);
      });

      it("creates no parent paths for a single-segment key", () => {
        const logger = getLogger("timing-single");

        logger.time(0, 10, "single");

        const stats = logger.getTimeStats("single");
        expect(stats?.count).toBe(1);

        // Should NOT create parent paths for single keys
        expect(Object.keys(logger.timeStats)).toEqual(["single"]);
      });

      it("accumulates repeated measurements under one key", () => {
        const logger = getLogger("timing-accumulate");

        logger.time(0, 10, "op");
        logger.time(0, 20, "op");
        logger.time(0, 30, "op");

        const stats = logger.getTimeStats("op");
        expect(stats?.count).toBe(3);
        expect(stats?.totalTime).toBe(60);
      });

      it("returns `undefined` for a key never recorded", () => {
        const logger = getLogger("timing-nonexistent");

        const stats = logger.getTimeStats("does-not-exist");
        expect(stats).toBeUndefined();
      });
    });
  });

  describe("global log floor", () => {
    // Helper to capture console output (duplicated for scope)
    function captureConsole<T>(
      method: keyof Console,
      fn: () => T,
    ): { result: T; calls: unknown[][] } {
      const originalMethod = console[method];
      const calls: unknown[][] = [];
      (console[method] as (...args: unknown[]) => void) = (
        ...args: unknown[]
      ) => {
        calls.push(args);
      };
      try {
        const result = fn();
        return { result, calls };
      } finally {
        (console[method] as unknown) = originalMethod;
      }
    }

    afterEach(() => {
      setGlobalLogFloor(undefined);
    });

    it("is `undefined` by default", () => {
      expect(getGlobalLogFloor()).toBeUndefined();
    });

    it("suppresses all output when the floor is `silent`", () => {
      setGlobalLogFloor("silent");
      const logger = getLogger("floor-silent-test", {
        level: "debug",
        enabled: true,
      });

      const { calls: debugCalls } = captureConsole("debug", () => {
        logger.debug("d", "debug msg");
      });
      const { calls: logCalls } = captureConsole("log", () => {
        logger.info("i", "info msg");
      });
      const { calls: warnCalls } = captureConsole("warn", () => {
        logger.warn("w", "warn msg");
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        logger.error("e", "error msg");
      });

      expect(debugCalls).toHaveLength(0);
      expect(logCalls).toHaveLength(0);
      expect(warnCalls).toHaveLength(0);
      expect(errorCalls).toHaveLength(0);
    });

    it("passes error and above when the floor is `error`", () => {
      setGlobalLogFloor("error");
      const logger = getLogger("floor-error-test", {
        level: "debug",
        enabled: true,
      });

      const { calls: logCalls } = captureConsole("log", () => {
        logger.info("i", "info msg");
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        logger.error("e", "error msg");
      });

      expect(logCalls).toHaveLength(0);
      expect(errorCalls).toHaveLength(1);
    });

    it("passes warn and above when the floor is `warn`", () => {
      setGlobalLogFloor("warn");
      const logger = getLogger("floor-warn-test", {
        level: "debug",
        enabled: true,
      });

      const { calls: logCalls } = captureConsole("log", () => {
        logger.info("i", "info msg");
      });
      const { calls: warnCalls } = captureConsole("warn", () => {
        logger.warn("w", "warn msg");
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        logger.error("e", "error msg");
      });

      expect(logCalls).toHaveLength(0);
      expect(warnCalls).toHaveLength(1);
      expect(errorCalls).toHaveLength(1);
    });

    it("applies whichever of the floor and the logger's level is stricter", () => {
      // Floor is "info" but logger is "error" — logger is more restrictive
      setGlobalLogFloor("info");
      const logger = getLogger("floor-restrictive-test", {
        level: "error",
        enabled: true,
      });

      const { calls: logCalls } = captureConsole("log", () => {
        logger.info("i", "info msg");
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        logger.error("e", "error msg");
      });

      expect(logCalls).toHaveLength(0); // filtered by per-logger "error" level
      expect(errorCalls).toHaveLength(1);
    });

    it("logs nothing from a disabled logger whatever the floor", () => {
      setGlobalLogFloor("debug");
      const logger = getLogger("floor-disabled-test", {
        level: "debug",
        enabled: false,
      });

      const { calls } = captureConsole("error", () => {
        logger.error("e", "error msg");
      });

      expect(calls).toHaveLength(0);
    });

    it("stops filtering once set to `undefined`", () => {
      setGlobalLogFloor("silent");
      expect(getGlobalLogFloor()).toBe("silent");

      setGlobalLogFloor(undefined);
      expect(getGlobalLogFloor()).toBeUndefined();

      // After clearing, normal logging should work
      const logger = getLogger("floor-clear-test", {
        level: "info",
        enabled: true,
      });
      const { calls } = captureConsole("log", () => {
        logger.info("i", "info msg");
      });
      expect(calls).toHaveLength(1);
    });

    it("counts a call the floor suppresses", () => {
      setGlobalLogFloor("silent");
      const logger = getLogger("floor-counts-test", {
        level: "debug",
        enabled: true,
      });

      logger.debug("d", "debug msg");
      logger.info("i", "info msg");
      logger.warn("w", "warn msg");
      logger.error("e", "error msg");

      expect(logger.counts.total).toBe(4);
      expect(logger.counts.debug).toBe(1);
      expect(logger.counts.info).toBe(1);
      expect(logger.counts.warn).toBe(1);
      expect(logger.counts.error).toBe(1);
    });
  });

  describe("timing measures", () => {
    afterEach(() => {
      // The cap deliberately survives toggling emission, so a test that set a
      // small one would otherwise silently throttle every test after it.
      setTimingMeasuresEnabled(false, { cap: 1_000 });
      clearTimingMeasures();
    });

    const measureNames = () =>
      performance.getEntriesByType("measure").map((entry) => entry.name);

    it("records a span without emitting a measure until asked", () => {
      clearTimingMeasures();
      const logger = getLogger("measure-off");
      logger.timeStart("phase", "one");
      logger.timeEnd("phase", "one");

      expect(
        measureNames().some((n) =>
          n.startsWith(`${TIMING_MEASURE_PREFIX}phase/one#`)
        ),
      ).toBe(
        false,
      );
      // The statistics are recorded either way — that is the whole point of
      // emission being separable from measurement.
      expect(logger.getTimeStats("phase", "one")?.count).toBe(1);
    });

    it("emits one measure per span, keyed by the joined path", () => {
      setTimingMeasuresEnabled(true);
      const logger = getLogger("measure-on");
      logger.timeStart("phase", "two");
      logger.timeEnd("phase", "two");

      const mine = measureNames().filter((n) =>
        n.startsWith(`${TIMING_MEASURE_PREFIX}phase/two#`)
      );
      expect(mine.length).toBe(1);
    });

    it("gives two spans on one key distinguishable names", () => {
      setTimingMeasuresEnabled(true);
      const logger = getLogger("measure-twice");
      for (let i = 0; i < 2; i++) {
        logger.timeStart("phase", "three");
        logger.timeEnd("phase", "three");
      }

      const mine = measureNames().filter((n) =>
        n.startsWith(`${TIMING_MEASURE_PREFIX}phase/three#`)
      );
      expect(mine.length).toBe(2);
      expect(new Set(mine).size).toBe(2);
    });

    it("measures the span it recorded, not the moment it was emitted", () => {
      setTimingMeasuresEnabled(true);
      const logger = getLogger("measure-span");
      const started = performance.now();
      logger.timeStart("phase", "four");
      logger.timeEnd("phase", "four");

      const entry = performance.getEntriesByType("measure").find((e) =>
        e.name.startsWith(`${TIMING_MEASURE_PREFIX}phase/four#`)
      );
      expect(entry).toBeDefined();
      expect(entry!.startTime).toBeGreaterThanOrEqual(started);
      const recorded = logger.getTimeStats("phase", "four")!;
      expect(Math.abs(entry!.duration - recorded.totalTime)).toBeLessThan(1);
    });

    it("stops emitting at the cap rather than growing without bound", () => {
      setTimingMeasuresEnabled(true, { cap: 3 });
      const logger = getLogger("measure-cap");
      for (let i = 0; i < 10; i++) {
        logger.timeStart("phase", "five");
        logger.timeEnd("phase", "five");
      }

      expect(
        measureNames().filter((n) =>
          n.startsWith(`${TIMING_MEASURE_PREFIX}phase/five#`)
        ).length,
      )
        .toBe(3);
      expect(getTimingMeasuresState().emitted).toBe(3);
      // Every span still reached the statistics; only emission stopped.
      expect(logger.getTimeStats("phase", "five")?.count).toBe(10);
    });

    it("gives the budget back when the entries are drained", () => {
      setTimingMeasuresEnabled(true, { cap: 2 });
      const logger = getLogger("measure-drain");
      logger.timeStart("phase", "six");
      logger.timeEnd("phase", "six");
      expect(getTimingMeasuresState().emitted).toBe(1);

      clearTimingMeasures();
      expect(getTimingMeasuresState().emitted).toBe(0);
      expect(
        measureNames().some((n) =>
          n.startsWith(`${TIMING_MEASURE_PREFIX}phase/six#`)
        ),
      ).toBe(
        false,
      );
    });

    it("leaves measures it did not emit alone", () => {
      setTimingMeasuresEnabled(true);
      performance.measure("someone-elses-measure", {
        start: performance.now(),
        end: performance.now(),
      });
      const logger = getLogger("measure-foreign");
      logger.timeStart("phase", "seven");
      logger.timeEnd("phase", "seven");

      clearTimingMeasures();
      // The host's timeline is shared; draining this feature must not take a
      // page's own instrumentation with it.
      expect(measureNames()).toContain("someone-elses-measure");
      expect(
        measureNames().some((n) => n.startsWith(TIMING_MEASURE_PREFIX)),
      ).toBe(false);
      performance.clearMeasures("someone-elses-measure");
    });

    it("calls `performance.clearMeasures()` once to drain any number of spans", () => {
      // Every span has a name of its own, and a host that keeps its timeline
      // as a list reads all of it to remove one name. A removal per span
      // therefore costs the square of the span count, which the number of
      // calls shows without anything being timed.

      setTimingMeasuresEnabled(true);
      const logger = getLogger("measure-drain-calls");
      for (let i = 0; i < 20; i++) {
        logger.timeStart("phase", "drain-calls");
        logger.timeEnd("phase", "drain-calls");
      }
      expect(getTimingMeasuresState().emitted).toBe(20);

      using clear = spy(performance, "clearMeasures");
      clearTimingMeasures();
      expect(clear.calls.length).toBe(1);
      expect(
        measureNames().some((n) => n.startsWith(TIMING_MEASURE_PREFIX)),
      ).toBe(false);
    });

    describe("beside a measure the host recorded", () => {
      const HOST_MEASURE = "host/phase";
      const BACKWARDS_MEASURE = "host/backwards";
      const REFUSED_MEASURE = "host/refused";
      const LATER_MEASURE = "host/later";

      const measuresNamed = (name: string) =>
        performance.getEntriesByName(name, "measure").map((entry) => ({
          startTime: entry.startTime,
          duration: entry.duration,
          detail: "detail" in entry ? entry.detail : undefined,
        }));

      const emitOneSpan = (name: string) => {
        setTimingMeasuresEnabled(true);
        const logger = getLogger(name);
        logger.timeStart("phase", name);
        logger.timeEnd("phase", name);
        expect(getTimingMeasuresState().emitted).toBe(1);
      };

      beforeEach(() => {
        performance.measure(HOST_MEASURE, {
          start: 100,
          end: 350,
          detail: { phase: "host" },
        });
      });

      afterEach(() => {
        for (
          const name of [
            HOST_MEASURE,
            BACKWARDS_MEASURE,
            REFUSED_MEASURE,
            LATER_MEASURE,
          ]
        ) {
          performance.clearMeasures(name);
        }
      });

      it("calls `performance.clearMeasures()` once to drain any number of spans", () => {
        setTimingMeasuresEnabled(true);
        const logger = getLogger("measure-drain-calls-beside-host");
        for (let i = 0; i < 20; i++) {
          logger.timeStart("phase", "drain-calls-beside-host");
          logger.timeEnd("phase", "drain-calls-beside-host");
        }
        expect(getTimingMeasuresState().emitted).toBe(20);

        using clear = spy(performance, "clearMeasures");
        clearTimingMeasures();
        expect(clear.calls.length).toBe(1);
        expect(
          measureNames().some((n) => n.startsWith(TIMING_MEASURE_PREFIX)),
        ).toBe(false);
      });

      it("keeps that measure's start, duration, and detail", () => {
        emitOneSpan("measure-keep-host");

        clearTimingMeasures();
        expect(measuresNamed(HOST_MEASURE)).toEqual([
          { startTime: 100, duration: 250, detail: { phase: "host" } },
        ]);
      });

      it("keeps a measure that ends before it starts, and the one recorded after it", () => {
        // A host admits a measure whose end precedes its start, and refuses
        // the negative duration that measure then reports when it is handed
        // back as a duration.

        performance.measure(BACKWARDS_MEASURE, { start: 100, end: 50 });
        performance.measure(LATER_MEASURE, { start: 400, end: 425 });
        emitOneSpan("measure-keep-backwards");

        clearTimingMeasures();
        expect(measuresNamed(BACKWARDS_MEASURE)).toEqual([
          { startTime: 100, duration: -50, detail: null },
        ]);
        expect(measuresNamed(LATER_MEASURE)).toEqual([
          { startTime: 400, duration: 25, detail: null },
        ]);
      });

      it("drops only the measure the host refuses to record again", () => {
        performance.measure(REFUSED_MEASURE, { start: 200, end: 210 });
        performance.measure(LATER_MEASURE, { start: 400, end: 425 });
        emitOneSpan("measure-refused-host");

        const realMeasure = performance.measure;
        using _refusal = stub(performance, "measure", (...args) => {
          if (args[0] === REFUSED_MEASURE) throw new TypeError("refused");
          return realMeasure.apply(performance, args);
        });
        clearTimingMeasures();
        expect(measuresNamed(HOST_MEASURE)).toEqual([
          { startTime: 100, duration: 250, detail: { phase: "host" } },
        ]);
        expect(measuresNamed(REFUSED_MEASURE)).toEqual([]);
        expect(measuresNamed(LATER_MEASURE)).toEqual([
          { startTime: 400, duration: 25, detail: null },
        ]);
      });

      it("leaves that measure's entry in place when it has no spans to drain", () => {
        // A drain with nothing of its own to remove has no reason to touch a
        // timeline it shares, so the host's entry is the same object after it.

        expect(
          measureNames().some((n) => n.startsWith(TIMING_MEASURE_PREFIX)),
        ).toBe(false);
        const [before] = performance.getEntriesByName(HOST_MEASURE, "measure");
        expect(before).toBeDefined();

        using clear = spy(performance, "clearMeasures");
        using measure = spy(performance, "measure");
        clearTimingMeasures();
        expect(clear.calls.length).toBe(0);
        expect(measure.calls.length).toBe(0);
        expect(performance.getEntriesByName(HOST_MEASURE, "measure")[0]).toBe(
          before,
        );
      });
    });

    it("emits again after something else clears the timeline", () => {
      setTimingMeasuresEnabled(true, { cap: 2 });
      const logger = getLogger("measure-external-clear");
      for (let i = 0; i < 5; i++) {
        logger.timeStart("phase", "eight");
        logger.timeEnd("phase", "eight");
      }
      expect(getTimingMeasuresState().emitted).toBe(2);

      // A test runner resetting between files does exactly this, and the
      // budget has to follow or later files emit nothing at all.
      performance.clearMeasures();
      resetTimingMeasureBudget();
      logger.timeStart("phase", "eight");
      logger.timeEnd("phase", "eight");
      expect(
        measureNames().filter((n) =>
          n.startsWith(`${TIMING_MEASURE_PREFIX}phase/eight#`)
        ).length,
      ).toBe(1);
    });

    it("refuses a cap that would disable the guard rather than set it", () => {
      // NaN and Infinity both make the `emitted >= cap` test never fire, and
      // the cap is the only thing bounding retention — so these are refused
      // rather than quietly accepted.
      for (const bad of [Number.NaN, Infinity, 0, -1, 1.5]) {
        expect(() => setTimingMeasuresEnabled(true, { cap: bad })).toThrow(
          RangeError,
        );
      }
      setTimingMeasuresEnabled(true, { cap: 5 });
      expect(getTimingMeasuresState().cap).toBe(5);
    });

    it("keeps the budget across a toggle, since the entries are still there", () => {
      setTimingMeasuresEnabled(true, { cap: 2 });
      const logger = getLogger("measure-toggle");
      for (let i = 0; i < 2; i++) {
        logger.timeStart("phase", "nine");
        logger.timeEnd("phase", "nine");
      }
      expect(getTimingMeasuresState().emitted).toBe(2);

      // Turning it off and on again must not hand back a budget the retained
      // entries are still spending, or a toggling caller grows without bound.
      setTimingMeasuresEnabled(false);
      setTimingMeasuresEnabled(true);
      expect(getTimingMeasuresState().emitted).toBe(2);
      logger.timeStart("phase", "nine");
      logger.timeEnd("phase", "nine");
      expect(
        measureNames().filter((n) =>
          n.startsWith(`${TIMING_MEASURE_PREFIX}phase/nine#`)
        ).length,
      ).toBe(2);
    });

    it("reads a cap out of an environment value, or refuses it", () => {
      expect(parseTimingMeasureCap("4242")).toBe(4242);
      // Anything that does not name a positive integer is ignored rather than
      // applied: a zero or NaN cap would disable the guard from outside the
      // process, which is the one thing the environment must not be able to do.
      for (const bad of ["", undefined, "0", "-1", "1.5", "not-a-number"]) {
        expect(parseTimingMeasureCap(bad)).toBeUndefined();
      }
    });

    it("keeps working when the host's performance API refuses", () => {
      // Instrumentation must never fail the thing it is measuring, and not
      // every host implements every part of the timeline. Both seams swallow
      // it: the span is still recorded into the statistics, and draining still
      // returns the budget.
      const realMeasure = performance.measure;
      const realClear = performance.clearMeasures;
      const boom = () => {
        throw new Error("no performance API here");
      };
      setTimingMeasuresEnabled(true);
      const logger = getLogger("measure-hostile-host");
      try {
        // A real entry first, so the drain below has something to reach for —
        // otherwise it finds nothing to clear and never calls the seam under
        // test.
        logger.timeStart("phase", "ten");
        logger.timeEnd("phase", "ten");
        expect(getTimingMeasuresState().emitted).toBe(1);

        (performance as { clearMeasures: unknown }).clearMeasures = boom;
        expect(() => clearTimingMeasures()).not.toThrow();
        expect(getTimingMeasuresState().emitted).toBe(0);

        (performance as { measure: unknown }).measure = boom;
        expect(() => {
          logger.timeStart("phase", "eleven");
          logger.timeEnd("phase", "eleven");
        }).not.toThrow();
        // The statistics still hold it: only the timeline entry was lost.
        expect(logger.getTimeStats("phase", "eleven")?.count).toBe(1);
      } finally {
        performance.measure = realMeasure;
        performance.clearMeasures = realClear;
      }
    });

    it("names one span on the timeline without touching the statistics", () => {
      setTimingMeasuresEnabled(true);
      const logger = getLogger("measure-detail");
      logger.timeStart("scheduler", "run", "action");
      logger.timeEndDetailed("topics/main", "scheduler", "run", "action");
      logger.timeStart("scheduler", "run", "action");
      logger.timeEndDetailed("topics/topic", "scheduler", "run", "action");

      // One row, because a key is a place in the code — naming the occurrence
      // in the key instead would multiply the statistics by every action the
      // runtime has ever run, which is the cost this split exists to avoid.
      expect(logger.getTimeStats("scheduler", "run", "action")?.count).toBe(2);

      const details = performance.getEntriesByType("measure")
        .filter((entry) =>
          entry.name.startsWith(`${TIMING_MEASURE_PREFIX}scheduler/run/action`)
        )
        .map((entry) => detailOfMeasure(entry.name));
      expect(details.sort()).toEqual(["topics/main", "topics/topic"]);
    });

    it("carries a detail containing separators through unchanged", () => {
      setTimingMeasuresEnabled(true);
      const logger = getLogger("measure-detail-hostile");
      logger.timeStart("phase", "twelve");
      logger.timeEndDetailed("a|b#c%d", "phase", "twelve");

      const entry = performance.getEntriesByType("measure").find((e) =>
        e.name.startsWith(`${TIMING_MEASURE_PREFIX}phase/twelve`)
      );
      expect(entry).toBeDefined();
      // Reversibly, not by substitution: two details differing only in which
      // separator they contain must not come back as the same string, or two
      // distinct actions report as one row.
      expect(detailOfMeasure(entry!.name)).toBe("a|b#c%d");
    });

    it("keeps details that differ only by a separator distinct", () => {
      setTimingMeasuresEnabled(true);
      const logger = getLogger("measure-detail-collide");
      for (const detail of ["a|b", "a/b", "a#b", "a_b"]) {
        logger.timeStart("phase", "collide");
        logger.timeEndDetailed(detail, "phase", "collide");
      }
      const seen = performance.getEntriesByType("measure")
        .filter((e) =>
          e.name.startsWith(`${TIMING_MEASURE_PREFIX}phase/collide`)
        )
        .map((e) => detailOfMeasure(e.name));
      expect(new Set(seen).size).toBe(4);
    });

    it("does not build a detail that will not be emitted", () => {
      setTimingMeasuresEnabled(false);
      const logger = getLogger("measure-detail-lazy");
      // Five long spans fill the key's slowest entries, so the short spans
      // below are kept nowhere but the timeline.
      for (let i = 0; i < 5; i++) logger.time(0, 1_000_000, "phase", "lazy");
      let built = 0;
      logger.timeStart("phase", "lazy");
      logger.timeEndDetailed(
        () => {
          built++;
          return "expensive";
        },
        "phase",
        "lazy",
      );
      // Emission is off on every production run, and a caller whose detail
      // costs anything to produce must not pay for it there.
      expect(built).toBe(0);
      expect(logger.getTimeStats("phase", "lazy")?.count).toBe(6);

      setTimingMeasuresEnabled(true);
      logger.timeStart("phase", "lazy");
      logger.timeEndDetailed(
        () => {
          built++;
          return "expensive";
        },
        "phase",
        "lazy",
      );
      expect(built).toBe(1);
    });

    it("stops building details once the cap has stopped emission", () => {
      const logger = getLogger("measure-detail-capped");
      // Five long spans fill the key's slowest entries, so the short spans
      // below are kept nowhere but the timeline.
      for (let i = 0; i < 5; i++) logger.time(0, 1_000_000, "phase", "capped");
      setTimingMeasuresEnabled(true, { cap: 2 });
      let built = 0;
      for (let i = 0; i < 6; i++) {
        logger.timeStart("phase", "capped");
        logger.timeEndDetailed(
          () => {
            built++;
            return `run-${i}`;
          },
          "phase",
          "capped",
        );
      }
      // Emission being on is not the same as a measure being written: past the
      // cap nothing reaches the timeline, so nothing should be built for it —
      // and that is the longest run, where it would cost the most.
      expect(built).toBe(2);
      expect(logger.getTimeStats("phase", "capped")?.count).toBe(11);
    });

    it("reports no detail for a span that was not named", () => {
      setTimingMeasuresEnabled(true);
      const logger = getLogger("measure-no-detail");
      logger.timeStart("phase", "thirteen");
      logger.timeEnd("phase", "thirteen");

      const entry = performance.getEntriesByType("measure").find((e) =>
        e.name.startsWith(`${TIMING_MEASURE_PREFIX}phase/thirteen#`)
      );
      expect(entry).toBeDefined();
      expect(detailOfMeasure(entry!.name)).toBeUndefined();

      // Ending a timer that was never started reports nothing rather than
      // inventing a span, exactly as the undetailed `timeEnd` does.
      expect(logger.timeEndDetailed("x", "phase", "never-started"))
        .toBeUndefined();
    });
  });
});
