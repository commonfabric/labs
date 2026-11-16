import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { getEventTargetDataset } from "../src/main/event-provenance.ts";

/** An event target carrying `dataset`, as an element does. */
const withDataset = (dataset: unknown): EventTarget =>
  Object.assign(new EventTarget(), { dataset });

describe("event-provenance", () => {
  describe("getEventTargetDataset()", () => {
    it("copies a target's dataset, with each value as a string", () => {
      expect(getEventTargetDataset(withDataset({ id: "a", count: 2 })))
        .toEqual({ id: "a", count: "2" });
    });

    it("returns nothing for a target without a dataset object", () => {
      expect(getEventTargetDataset(null)).toBeUndefined();
      expect(getEventTargetDataset(new EventTarget())).toBeUndefined();
      expect(getEventTargetDataset(withDataset(null))).toBeUndefined();
      expect(getEventTargetDataset(withDataset("id=a"))).toBeUndefined();
    });

    it("returns nothing for an empty dataset", () => {
      expect(getEventTargetDataset(withDataset({}))).toBeUndefined();
    });
  });
});
