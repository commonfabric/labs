// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFSeparator } from "./index.ts";

/** The line a `cf-separator` mounted with `properties` renders. */
async function lineOf(properties: Partial<CFSeparator> = {}) {
  const element = await mount(Object.assign(new CFSeparator(), properties));
  return element.shadowRoot!.querySelector('[part="separator"]')!;
}

describe("CFSeparator", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-separator`", () => {
    expect(customElements.get("cf-separator")).toBe(CFSeparator);
  });

  describe("render()", () => {
    it("renders a horizontal separator by default", async () => {
      const line = await lineOf();
      expect([...line.classList].sort()).toEqual(["horizontal", "separator"]);
      expect(line.getAttribute("role")).toBe("separator");
      expect(line.getAttribute("aria-orientation")).toBe("horizontal");
    });

    it("renders a vertical separator when asked", async () => {
      const line = await lineOf({ orientation: "vertical" });
      expect(line.classList.contains("vertical")).toBe(true);
      expect(line.classList.contains("horizontal")).toBe(false);
      expect(line.getAttribute("aria-orientation")).toBe("vertical");
    });

    it("hides a decorative separator from assistive technology", async () => {
      const line = await lineOf({ decorative: true, orientation: "vertical" });
      expect(line.getAttribute("role")).toBe("none");
      expect(line.hasAttribute("aria-orientation")).toBe(false);
      expect(line.classList.contains("vertical")).toBe(true);
    });
  });
});
