import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getLogger } from "@commonfabric/logger";
import {
  appendLoggerDeltaMessages,
  snapshotLoggerErrorWarnCounts,
} from "../lib/console-capture.ts";

describe("appendLoggerDeltaMessages()", () => {
  const logger = getLogger("console-capture-test", { enabled: false });

  it("appends a line for each key that logged errors or warnings since the snapshot, and none for one that logged before it", () => {
    logger.error("before", "logged before the snapshot");
    const snapshot = snapshotLoggerErrorWarnCounts();
    logger.error("during", "first");
    logger.error("during", "second");
    logger.warn("during", "warning");
    logger.info("quiet", "neither an error nor a warning");

    const errors: string[] = [];
    const warnings: string[] = [];
    appendLoggerDeltaMessages(snapshot, errors, warnings);

    const ours = (lines: string[]) =>
      lines.filter((line) => line.includes("console-capture-test"));
    expect(ours(errors)).toEqual([
      "[logger:console-capture-test] 2 error(s) (key: during)",
    ]);
    expect(ours(warnings)).toEqual([
      "[logger:console-capture-test] 1 warning(s) (key: during)",
    ]);
  });
});
