// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { CFHGroup } from "./index.ts";

/** The group container a mounted `cf-hgroup` with `properties` renders. */
async function groupOf(properties: Partial<CFHGroup> = {}): Promise<Element> {
  const element = await mount(Object.assign(new CFHGroup(), properties));
  return element.shadowRoot!.querySelector("[part=group]")!;
}

describe("CFHGroup", () => {
  afterEach(() => document.body.replaceChildren());

  it("registers the custom element", () => {
    expect(customElements.get("cf-hgroup")).toBe(CFHGroup);
  });

  describe("instance members", () => {
    describe("render()", () => {
      it("renders the default gap, alignment, and justification", async () => {
        const group = await groupOf();

        expect([...group.classList].sort()).toEqual([
          "align-center",
          "gap-md",
          "group",
          "justify-start",
        ]);
        expect(group.querySelector("slot")).not.toBeNull();
      });

      it("renders the classes its properties name", async () => {
        const group = await groupOf({
          gap: "2",
          align: "baseline",
          justify: "between",
          wrap: true,
        });

        expect([...group.classList].sort()).toEqual([
          "align-baseline",
          "gap-2",
          "group",
          "justify-between",
          "wrap",
        ]);
      });

      it("reflects wrap to the host attribute", async () => {
        const element = await mount(new CFHGroup());
        expect(element.hasAttribute("wrap")).toBe(false);

        element.wrap = true;
        await element.updateComplete;
        expect(element.hasAttribute("wrap")).toBe(true);
      });
    });
  });
});
