import { expect } from "@std/expect";

import { warnWhenSidecarRunWithdrawn } from "../../src/builtins/wish.ts";
import { captureLogs } from "../support/captured-logs.ts";
import { describe, it } from "@commonfabric/test-support/test";

const SOURCE = "of:sidecar-result";

describe("warnWhenSidecarRunWithdrawn()", () => {
  it("warns, naming the sidecar and the withdrawal, when the wave withdrew the run", async () => {
    using captured = captureLogs("runner.wish-flow");

    await warnWhenSidecarRunWithdrawn(
      Promise.resolve({ error: { message: "read a dropped write" } }),
      SOURCE,
    );

    expect(captured.textsOf("sidecar-run-withdrawn")).toEqual([
      `sidecar run for ${SOURCE} committed but the wave withdrew it; ` +
      "nothing re-issues this instantiation: read a dropped write",
    ]);
  });

  it("logs nothing when the wave accepted the run", async () => {
    using captured = captureLogs("runner.wish-flow");

    await warnWhenSidecarRunWithdrawn(Promise.resolve({}), SOURCE);

    expect(captured.textsOf("sidecar-run-withdrawn")).toEqual([]);
  });

  it("resolves, logging nothing, when the settlement rejects", async () => {
    using captured = captureLogs("runner.wish-flow");

    await warnWhenSidecarRunWithdrawn(
      Promise.reject(new Error("wave failed")),
      SOURCE,
    );

    expect(captured.textsOf("sidecar-run-withdrawn")).toEqual([]);
  });
});
