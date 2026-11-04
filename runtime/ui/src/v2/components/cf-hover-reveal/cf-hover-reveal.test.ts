import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { CFHoverReveal } from "./index.ts";

describe("CFHoverReveal", () => {
  it("registers the custom element", () => {
    expect(customElements.get("cf-hover-reveal")).toBe(CFHoverReveal);
  });

  describe("constructor()", () => {
    it("starts with its actions not forced into view", () => {
      const element = new CFHoverReveal();
      expect(element.revealed).toBe(false);
    });
  });
});
