import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFSuggestions } from "./index.ts";

describe("cf-suggestions", () => {
  it("registers CFSuggestions as cf-suggestions", () => {
    expect(customElements.get("cf-suggestions")).toBe(CFSuggestions);
  });

  it("draws nothing and holds nothing takeable before it is bound", () => {
    const element = new CFSuggestions();
    const access = element.accessForTestingOnly;
    expect(access.drawn).toEqual([]);
    expect(access.isTakeable("one")).toBe(false);
    access.minimumShownMs = 0;
    expect(access.minimumShownMs).toBe(0);
  });

  it("emits no take for an untrusted event", () => {
    const element = new CFSuggestions();
    const taken: Event[] = [];
    element.addEventListener(
      "cf-suggestion-take",
      (event) => taken.push(event),
    );
    element.accessForTestingOnly.take(new Event("click"));
    expect(taken).toEqual([]);
  });
});
