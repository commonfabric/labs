// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFSkeleton } from "./index.ts";

/** A `cf-skeleton` mounted with `properties`, and the placeholder it renders. */
async function skeletonWith(properties: Partial<CFSkeleton> = {}) {
  const element = await mount(Object.assign(new CFSkeleton(), properties));
  const placeholder = element.shadowRoot!.querySelector<HTMLElement>(
    '[part="skeleton"]',
  )!;
  return { element, placeholder };
}

describe("CFSkeleton", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-skeleton`", () => {
    expect(customElements.get("cf-skeleton")).toBe(CFSkeleton);
  });

  describe("render()", () => {
    it("renders an animated default placeholder announced as loading", async () => {
      const { placeholder } = await skeletonWith();
      expect([...placeholder.classList].sort()).toEqual([
        "animate",
        "default",
        "skeleton",
      ]);
      expect(placeholder.getAttribute("role")).toBe("status");
      expect(placeholder.getAttribute("aria-label")).toBe("Loading");
      expect(placeholder.textContent!.trim()).toBe("Loading...");
      expect(placeholder.getAttribute("style") ?? "").toBe("");
    });

    it("renders the variant it is given, without animation when asked", async () => {
      const { placeholder } = await skeletonWith({
        variant: "circular",
        animated: false,
      });
      expect([...placeholder.classList].sort()).toEqual([
        "circular",
        "skeleton",
      ]);
    });

    it("sizes the placeholder by the width and height it is given", async () => {
      const { placeholder } = await skeletonWith({
        width: "40px",
        height: "1em",
      });
      expect(placeholder.style.width).toBe("40px");
      expect(placeholder.style.height).toBe("1em");
    });

    it("falls back to the default variant for an unknown one", async () => {
      const { element, placeholder } = await skeletonWith({
        // @ts-expect-error: a page can set any string as the attribute.
        variant: "wavy",
      });
      expect(element.variant).toBe("default");
      expect(placeholder.classList.contains("default")).toBe(true);
      expect(placeholder.classList.contains("wavy")).toBe(false);
    });
  });
});
