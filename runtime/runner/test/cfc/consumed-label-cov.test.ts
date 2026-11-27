import { expect } from "@std/expect";
import { entriesForConsumedLabel } from "../../src/cfc/consumed-label.ts";
import type { LabelMapEntry } from "../../src/cfc/types.ts";
import { describe, it } from "@commonfabric/test-support/test";

const note: LabelMapEntry = {
  path: ["note"],
  origin: "declared",
  label: { confidentiality: ["a"] },
};
const secret: LabelMapEntry = {
  path: ["note", "secret"],
  origin: "declared",
  label: { confidentiality: ["b"] },
};
const elsewhere: LabelMapEntry = {
  path: ["other", "deep"],
  origin: "declared",
  label: { confidentiality: ["c"] },
};

describe("entriesForConsumedLabel()", () => {
  it("returns, for a recursive read, the entry at the path and every entry below it, and none beside it", () => {
    expect(entriesForConsumedLabel([note, secret, elsewhere], ["note"], false))
      .toEqual([note, secret]);
  });

  it("returns, for a non-recursive read, only the entry at the path", () => {
    expect(entriesForConsumedLabel([note, secret, elsewhere], ["note"], true))
      .toEqual([note]);
  });
});
