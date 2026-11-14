import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { promptAbout, totalAmount } from "./suggestion.ts";

describe("suggestion", () => {
  describe("promptAbout()", () => {
    it("names the topic between the request and its details", () => {
      expect(promptAbout("a picnic", "Plan: ", ". Keep it short.")).toBe(
        "Plan: a picnic. Keep it short.",
      );
    });

    it("needs no details", () => {
      expect(promptAbout("tides", "Summarize ")).toBe("Summarize tides");
    });

    it("is empty without a topic, so no request is made", () => {
      expect(promptAbout("", "Plan: ", ". Keep it short.")).toBe("");
      expect(promptAbout(undefined, "Plan: ")).toBe("");
    });
  });

  describe("totalAmount()", () => {
    it("adds up every item's amount", () => {
      expect(totalAmount([{ amount: 120 }, { amount: 80 }, { amount: 5 }]))
        .toBe(205);
    });

    it("counts a missing amount as zero", () => {
      expect(totalAmount([{ amount: 40 }, {}])).toBe(40);
    });

    it("is zero for no items", () => {
      expect(totalAmount([])).toBe(0);
    });
  });
});
