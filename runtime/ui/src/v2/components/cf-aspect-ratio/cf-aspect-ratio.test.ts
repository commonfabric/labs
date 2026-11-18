// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { CFAspectRatio } from "./index.ts";

/** The bottom padding of `element`'s container, which sets its height. */
const paddingOf = (element: CFAspectRatio): string =>
  element.shadowRoot!.querySelector<HTMLElement>(".aspect-ratio-container")!
    .style.paddingBottom;

describe("CFAspectRatio", () => {
  afterEach(() => document.body.replaceChildren());

  it("registers the custom element", () => {
    expect(customElements.get("cf-aspect-ratio")).toBe(CFAspectRatio);
  });

  it("pads its container to a 16/9 height by default", async () => {
    const element = await mount(new CFAspectRatio());
    expect(paddingOf(element)).toBe("56.25%");
  });

  it("pads its container to the height its ratio gives", async () => {
    const element = await mount(new CFAspectRatio());
    element.setAttribute("ratio", "4/3");
    await element.updateComplete;
    expect(paddingOf(element)).toBe("75%");

    element.ratio = "1/2";
    await element.updateComplete;
    expect(paddingOf(element)).toBe("200%");
  });

  it("renders its slot inside the sized container", async () => {
    const element = await mount(new CFAspectRatio());
    const slot = element.shadowRoot!.querySelector(
      ".aspect-ratio-container .aspect-ratio-content slot",
    );
    expect(slot).not.toBeNull();
  });

  describe("given an invalid ratio", () => {
    for (const ratio of ["16:9", "1/2/3", "wide/9", "0/9", "16/-9"]) {
      it(`warns and pads to 16/9 for "${ratio}"`, async () => {
        using warn = stub(console, "warn");
        const element = new CFAspectRatio();
        element.ratio = ratio;
        await mount(element);
        expect(paddingOf(element)).toBe("56.25%");
        expect(warn.calls.map((call) => call.args)).toEqual([[
          `Invalid aspect ratio: ${ratio}. Using default 16/9.`,
        ]]);
      });
    }
  });
});
