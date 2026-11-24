import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/api";
import { commutesWithTailAppends } from "../src/storage/transaction/sidecar-appends.ts";

type Sidecar = {
  cfc: { label: string };
  value: { entries: FabricValue[]; eventWatermark: number };
};

// A stream sidecar document holding `entries`, with the label sibling and the
// per-stream watermark a served sidecar carries beside them.
const sidecar = (
  entries: FabricValue[],
  watermark = 0,
): Sidecar => ({
  cfc: { label: "stream" },
  value: { entries, eventWatermark: watermark },
});

const first = { eventId: "first" };
const second = { eventId: "second" };
// The paths a served delivery's transaction touches: the label it reads, and
// the mark it writes on the entry it delivers.
const labelRead = ["cfc"];
const mark = ["value", "entries", "0", "consequenced"];

describe("commutesWithTailAppends", () => {
  it("accepts entries appended after the ones a mark was written on", () => {
    expect(
      commutesWithTailAppends(
        sidecar([first]),
        sidecar([first, second]),
        [labelRead, mark],
        [mark],
      ),
    ).toBe(true);
  });

  it("refuses a change to an entry the transaction held", () => {
    expect(
      commutesWithTailAppends(
        sidecar([first]),
        sidecar([{ ...first, deliveryDeferral: { attempts: 1 } }, second]),
        [mark],
        [mark],
      ),
    ).toBe(false);
  });

  it("refuses an entry removed from the log", () => {
    expect(
      commutesWithTailAppends(
        sidecar([first, second]),
        sidecar([first]),
        [mark],
        [mark],
      ),
    ).toBe(false);
  });

  it("refuses a change outside the log", () => {
    expect(
      commutesWithTailAppends(
        sidecar([first]),
        sidecar([first, second], 1),
        [mark],
        [mark],
      ),
    ).toBe(false);
    expect(
      commutesWithTailAppends(
        sidecar([first]),
        { ...sidecar([first, second]), cfc: { label: "other" } },
        [mark],
        [mark],
      ),
    ).toBe(false);
  });

  it("refuses a transaction that read the log as a whole, its length, or past its end", () => {
    for (
      const read of [
        [],
        ["value"],
        ["value", "entries"],
        ["value", "entries", "length"],
        ["value", "entries", "1"],
      ]
    ) {
      expect(
        commutesWithTailAppends(
          sidecar([first]),
          sidecar([first, second]),
          [read],
          [mark],
        ),
      ).toBe(false);
    }
  });

  it("refuses a transaction that wrote anything but an entry it held", () => {
    for (
      const write of [
        ["value", "entries"],
        ["value", "entries", "1"],
        ["value", "eventWatermark"],
        ["cfc"],
      ]
    ) {
      expect(
        commutesWithTailAppends(
          sidecar([first]),
          sidecar([first, second]),
          [],
          [write],
        ),
      ).toBe(false);
    }
  });

  it("refuses a value that is not a stream sidecar", () => {
    expect(
      commutesWithTailAppends(
        { value: { entries: "first" } },
        { value: { entries: "first, second" } },
        [],
        [],
      ),
    ).toBe(false);
    expect(commutesWithTailAppends(undefined, sidecar([first]), [], []))
      .toBe(false);
  });
});
