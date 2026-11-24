// First, so that the document it installs is there when Lit loads.
import "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { CFFragment } from "./index.ts";

describe("CFFragment", () => {
  afterEach(() => document.body.replaceChildren());

  it("registers the custom element", () => {
    expect(customElements.get("cf-fragment")).toBe(CFFragment);
  });

  describe("constructor()", () => {
    it("renders its children through a single open slot", () => {
      const fragment = new CFFragment();
      const child = document.createElement("span");
      fragment.append(child);

      const root = fragment.shadowRoot!;
      expect(root.mode).toBe("open");
      expect([...root.children].map((node) => node.localName))
        .toEqual(["slot"]);
      expect(
        root.querySelector("slot")!.assignedElements().map((node) =>
          node.localName
        ),
      ).toEqual(["span"]);
    });
  });

  describe("instance members", () => {
    describe("connectedCallback()", () => {
      it("sets display: contents once connected", () => {
        const fragment = new CFFragment();
        expect(fragment.style.display).toBe("");

        document.body.append(fragment);

        expect(fragment.style.display).toBe("contents");
        expect(getComputedStyle(fragment).display).toBe("contents");
      });
    });
  });
});
