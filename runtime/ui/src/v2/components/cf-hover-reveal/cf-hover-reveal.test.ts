// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { CFHoverReveal } from "./index.ts";

describe("CFHoverReveal", () => {
  afterEach(() => document.body.replaceChildren());

  it("registers the custom element", () => {
    expect(customElements.get("cf-hover-reveal")).toBe(CFHoverReveal);
  });

  describe("constructor()", () => {
    it("starts with its actions not forced into view", () => {
      const element = new CFHoverReveal();
      expect(element.revealed).toBe(false);
    });
  });

  describe("rendering", () => {
    it("slots its content into the content part and its actions into the actions part", async () => {
      const element = new CFHoverReveal();
      const message = document.createElement("p");
      const react = document.createElement("button");
      react.slot = "actions";
      element.append(message, react);
      await mount(element);

      // Compared by identity, since `toEqual()` would compare the elements'
      // own properties.
      const slotIn = (part: string) =>
        element.shadowRoot!.querySelector<HTMLSlotElement>(
          `[part="${part}"] > slot`,
        )!.assignedElements().map((slotted) =>
          slotted === message ? "message" : slotted === react ? "react" : "?"
        );
      expect(slotIn("content")).toEqual(["message"]);
      expect(slotIn("actions")).toEqual(["react"]);
    });

    it("reflects `revealed` as an attribute, which the styles show the actions by", async () => {
      const element = await mount(new CFHoverReveal());
      expect(element.hasAttribute("revealed")).toBe(false);

      element.revealed = true;
      await element.updateComplete;
      expect(element.hasAttribute("revealed")).toBe(true);
    });
  });
});
