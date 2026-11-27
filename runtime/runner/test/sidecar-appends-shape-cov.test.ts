import { expect } from "@std/expect";
import { commutesWithTailAppends } from "../src/storage/transaction/sidecar-appends.ts";
import { describe, it } from "@commonfabric/test-support/test";

const mark = ["value", "entries", "0", "consequenced"];
const sidecar = { value: { entries: [{ eventId: "first" }] } };
const appended = {
  value: { entries: [{ eventId: "first" }, { eventId: "second" }] },
};

describe("commutesWithTailAppends", () => {
  it("returns `true` for a mark on an entry that a tail append to an object `value` leaves in place", () => {
    expect(commutesWithTailAppends(sidecar, appended, [mark], [mark])).toBe(
      true,
    );
  });

  it("returns `false` when either document's `value` is not an object", () => {
    expect(commutesWithTailAppends({ value: 1 }, appended, [mark], [mark]))
      .toBe(false);
    expect(
      commutesWithTailAppends(sidecar, { value: [appended.value] }, [mark], [
        mark,
      ]),
    ).toBe(false);
  });
});
