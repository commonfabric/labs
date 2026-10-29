/**
 * Tests for `cf-screen`.
 *
 * The decision this file pins is which footer content makes the main scroller
 * fade into it. That decision is a predicate over slotted elements, so it is
 * checked here rather than in Chrome, where only the arrangement it produces
 * can be measured. `cf-tab-bar/cf-tab-bar-layout.browser.test.ts` measures
 * that arrangement.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { footerFades } from "./cf-screen.ts";
import { CFScreen } from "./index.ts";

/**
 * A stand-in for a slotted element, carrying the two things the decision reads.
 */
function slotted(
  localName: string,
  attributes: Record<string, string> = {},
): Pick<Element, "localName" | "getAttribute"> {
  return {
    localName,
    getAttribute: (name: string) => attributes[name] ?? null,
  };
}

/** The literal parts of the rendered template, with its bindings elided. */
function staticHtml(element: CFScreen): string {
  return element.render().strings.join("");
}

describe("cf-screen", () => {
  describe("footerFades()", () => {
    it("returns `false` for an empty footer", () => {
      expect(footerFades([])).toBe(false);
    });

    it("returns `true` for an inset tab bar with no stated position", () => {
      expect(footerFades([slotted("cf-tab-bar", { variant: "inset" })]))
        .toBe(true);
    });

    it("returns `true` for an inset tab bar along the bottom", () => {
      const bar = slotted("cf-tab-bar", {
        variant: "inset",
        position: "bottom",
      });
      expect(footerFades([bar])).toBe(true);
    });

    it("returns `false` for an inset tab bar along the top", () => {
      const bar = slotted("cf-tab-bar", { variant: "inset", position: "top" });
      expect(footerFades([bar])).toBe(false);
    });

    it("returns `false` for a tab bar that is not inset", () => {
      const bar = slotted("cf-tab-bar", {
        variant: "floating",
        position: "bottom",
      });
      expect(footerFades([bar])).toBe(false);
    });

    it("returns `false` for a tab bar carrying no variant", () => {
      expect(footerFades([slotted("cf-tab-bar")])).toBe(false);
    });

    it("returns `false` for an inset element that is not a tab bar", () => {
      expect(footerFades([slotted("cf-hstack", { variant: "inset" })]))
        .toBe(false);
    });

    it("returns `true` when one of several slotted elements qualifies", () => {
      const slottedElements = [
        slotted("cf-text"),
        slotted("cf-tab-bar", { variant: "inset", position: "bottom" }),
        slotted("cf-hstack"),
      ];
      expect(footerFades(slottedElements)).toBe(true);
    });
  });

  describe("CFScreen", () => {
    it("is the element registered as `cf-screen`", () => {
      expect(customElements.get("cf-screen")).toBe(CFScreen);
    });

    describe("instance members", () => {
      describe("render()", () => {
        it("returns the header, main and footer regions as exported parts", () => {
          const html = staticHtml(new CFScreen());
          expect(html).toContain('part="header"');
          expect(html).toContain('part="main"');
          expect(html).toContain('part="footer"');
        });

        it("returns a named header slot, a named footer slot, and a default slot", () => {
          const html = staticHtml(new CFScreen());
          expect(html).toContain('<slot name="header">');
          expect(html).toContain('<slot name="footer"');
          expect(html).toContain("<slot></slot>");
        });
      });
    });
  });
});
