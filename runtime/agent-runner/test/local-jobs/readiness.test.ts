import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { transitionLane } from "../../src/local-jobs/readiness.ts";

describe("local-jobs/readiness", () => {
  it("keeps since until the state or reason changes", () => {
    const previous = {
      state: "starting",
      since: "2026-10-07T00:10:14.000Z",
      reason: "Connecting",
    } as const;
    const now = new Date("2026-10-07T00:10:24.000Z");
    expect(transitionLane(previous, previous, now)).toBe(previous);
    expect(transitionLane(previous, { state: "up", reason: null }, now))
      .toEqual({ state: "up", reason: null, since: now.toISOString() });
    expect(
      transitionLane(
        previous,
        { state: "starting", reason: "Registering" },
        now,
      ),
    ).toEqual({
      state: "starting",
      reason: "Registering",
      since: now.toISOString(),
    });
  });
});
