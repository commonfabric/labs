import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { CFHoverCard } from "./index.ts";

describe("CFHoverCard", () => {
  it("registers the custom element", () => {
    expect(customElements.get("cf-hover-card")).toBe(CFHoverCard);
  });
});
