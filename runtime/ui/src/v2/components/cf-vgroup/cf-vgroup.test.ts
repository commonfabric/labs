// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFVGroup } from "./index.ts";

/** The classes on the group a `cf-vgroup` mounted with `properties` renders. */
async function groupClasses(properties: Partial<CFVGroup> = {}) {
  const element = await mount(Object.assign(new CFVGroup(), properties));
  const group = element.shadowRoot!.querySelector('[part="group"]')!;
  expect(group.querySelector("slot")).not.toBeNull();
  return [...group.classList].sort();
}

describe("CFVGroup", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-vgroup`", () => {
    expect(customElements.get("cf-vgroup")).toBe(CFVGroup);
  });

  describe("render()", () => {
    it("stretches its items from the start with a medium gap by default", async () => {
      expect(await groupClasses()).toEqual([
        "align-stretch",
        "gap-md",
        "group",
        "justify-start",
      ]);
    });

    it("classes the group by the gap, alignment, and justification it is given", async () => {
      expect(
        await groupClasses({ gap: "2", align: "center", justify: "between" }),
      ).toEqual(["align-center", "gap-2", "group", "justify-between"]);
    });
  });
});
