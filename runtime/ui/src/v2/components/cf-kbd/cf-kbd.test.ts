// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { CFKbd } from "./index.ts";
import { afterEach, describe, it } from "@commonfabric/test-support/test";

describe("CFKbd", () => {
  afterEach(() => document.body.replaceChildren());

  it("registers the custom element", () => {
    expect(customElements.get("cf-kbd")).toBe(CFKbd);
  });

  describe("instance members", () => {
    describe("render()", () => {
      it("renders its content inside the kbd part", async () => {
        const element = new CFKbd();
        element.textContent = "⌘N";
        await mount(element);

        const kbd = element.shadowRoot!.querySelector(".kbd")!;
        expect(kbd.getAttribute("part")).toBe("kbd");
        const slot = kbd.querySelector("slot")!;
        expect(slot.assignedNodes().map((node) => node.textContent))
          .toEqual(["⌘N"]);
      });
    });
  });
});
