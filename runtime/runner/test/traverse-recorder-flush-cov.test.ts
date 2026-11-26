import { expect } from "@std/expect";
import { join } from "@std/path";

import type { SchemaPathSelector } from "@commonfabric/api";
import { getLoggerCountsBreakdown } from "@commonfabric/logger";
import { describe, it } from "@commonfabric/test-support/test";

import {
  flushCaptureReportingFailure,
  TraverseCaptureRecorder,
  type TraverseFixture,
} from "../src/traverse-recorder.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";

const failedFlushes = (): number => {
  const counts = getLoggerCountsBreakdown()["traverse-recorder"] as
    | Record<string, { warn?: number }>
    | undefined;
  return counts?.capture?.warn ?? 0;
};

const recorderWithOneInvocation = (): TraverseCaptureRecorder => {
  const recorder = new TraverseCaptureRecorder();
  const address: IMemorySpaceAddress = {
    space: "did:key:zTraverseFlush",
    id: "of:flushed-doc",
    type: "application/json",
    path: ["value"],
  };
  const selector: SchemaPathSelector = { path: ["value"], schema: true };
  recorder.recordInvocation(
    { address },
    selector,
    undefined,
    { traverseCells: false },
    undefined,
  );
  return recorder;
};

describe("traverse-recorder", () => {
  describe("flushCaptureReportingFailure()", () => {
    it("writes the capture to the path without a warning", async () => {
      const dir = await Deno.makeTempDir();
      try {
        const path = join(dir, "periodic.json");
        const before = failedFlushes();

        flushCaptureReportingFailure(recorderWithOneInvocation(), path);

        const fixture: TraverseFixture = JSON.parse(
          await Deno.readTextFile(path),
        );
        expect(fixture.invocations.map((i) => i.address.id)).toEqual([
          "of:flushed-doc",
        ]);
        expect(failedFlushes()).toBe(before);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("warns instead of throwing when the path cannot be written", async () => {
      const dir = await Deno.makeTempDir();
      try {
        const path = join(dir, "missing-directory", "periodic.json");
        const recorder = recorderWithOneInvocation();
        expect(() => recorder.flush(path)).toThrow(Deno.errors.NotFound);
        const before = failedFlushes();

        flushCaptureReportingFailure(recorder, path);

        expect(failedFlushes()).toBe(before + 1);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });
});
