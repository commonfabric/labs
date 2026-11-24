import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { reconstructOutcome, reconstructRevision } from "../reconstruct.ts";
import { replayRangeFixture } from "./reconstruct-range-fixture.ts";

describe("reconstruct", () => {
  for (const snapshots of [false, true]) {
    it(`bounds same-sequence replay by operation index with snapshots ${snapshots}`, () => {
      using fixture = replayRangeFixture(20, { snapshots });
      const { space, targetSeq: seq } = fixture;
      expect(reconstructRevision(space, { id: "of:range", seq, opIndex: 0 }))
        .toEqual({ value: { items: ["base", "first"] } });
      expect(reconstructRevision(space, { id: "of:range", seq, opIndex: 1 }))
        .toEqual({ value: { items: ["base", "first", "second"] } });
      expect(reconstructOutcome(space, { id: "of:range", atSeq: seq }))
        .toEqual({
          status: "present",
          document: { value: { items: ["base", "first", "second"] } },
        });
      expect(reconstructOutcome(space, { id: "of:range" }))
        .toEqual({
          status: "present",
          document: { value: { items: ["future"] } },
        });
    });
  }

  it("reports a corrupt set base even when snapshots cover the read", () => {
    using fixture = replayRangeFixture(20, { corruptBase: true });
    const at = { id: "of:range", atSeq: fixture.targetSeq };
    expect(reconstructOutcome(fixture.space, at).status).toBe("undecodable");
    expect(() =>
      reconstructRevision(fixture.space, {
        id: at.id,
        seq: fixture.targetSeq,
        opIndex: 0,
      })
    ).toThrow();
  });
});
