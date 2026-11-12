// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { defaultTheme } from "../theme-context.ts";
import { CFHeading } from "./index.ts";

/** The heading container a mounted `cf-heading` at `level` renders. */
async function headingAt(level: number): Promise<Element> {
  const element = await mount(Object.assign(new CFHeading(), { level }));
  return element.shadowRoot!.querySelector("[part=heading]")!;
}

describe("CFHeading", () => {
  afterEach(() => document.body.replaceChildren());

  it("registers the custom element", () => {
    expect(customElements.get("cf-heading")).toBe(CFHeading);
  });

  describe("instance members", () => {
    describe("render()", () => {
      it("renders a level-3 heading by default", async () => {
        const element = await mount(new CFHeading());
        const heading = element.shadowRoot!.querySelector("[part=heading]")!;

        expect(heading.getAttribute("role")).toBe("heading");
        expect(heading.getAttribute("aria-level")).toBe("3");
        expect([...heading.classList]).toEqual(["heading", "h3"]);
        expect(element.getAttribute("level")).toBe("3");
      });

      it("renders the level it is given", async () => {
        const heading = await headingAt(1);

        expect(heading.getAttribute("aria-level")).toBe("1");
        expect([...heading.classList]).toEqual(["heading", "h1"]);
      });

      it("renders a level outside 1 to 6 as the nearest of them", async () => {
        expect((await headingAt(9)).getAttribute("aria-level")).toBe("6");
        expect((await headingAt(-2)).getAttribute("aria-level")).toBe("1");
      });

      it("renders level 0 or a non-number as level 3", async () => {
        expect((await headingAt(0)).getAttribute("aria-level")).toBe("3");
        expect((await headingAt(NaN)).classList.contains("h3")).toBe(true);
      });

      it("reflects noMargin to the no-margin attribute", async () => {
        const element = await mount(new CFHeading());
        expect(element.hasAttribute("no-margin")).toBe(false);

        element.noMargin = true;
        await element.updateComplete;
        expect(element.hasAttribute("no-margin")).toBe(true);
      });
    });

    describe("theme", () => {
      it("writes a given theme onto the element, and takes it back", async () => {
        const element = await mount(new CFHeading());
        expect(element.style.getPropertyValue("--cf-theme-font-family"))
          .toBe("");

        element.theme = { ...defaultTheme, fontFamily: "Heading Font" };
        await element.updateComplete;
        expect(element.style.getPropertyValue("--cf-theme-font-family"))
          .toBe("Heading Font");

        element.theme = undefined;
        await element.updateComplete;
        expect(element.style.getPropertyValue("--cf-theme-font-family"))
          .toBe("");
      });

      it("leaves the element's style alone when the theme is unchanged", async () => {
        const element = await mount(
          Object.assign(new CFHeading(), {
            theme: { ...defaultTheme, fontFamily: "Heading Font" },
          }),
        );
        element.style.setProperty("--cf-theme-font-family", "Authored");

        element.level = 2;
        await element.updateComplete;

        expect(element.style.getPropertyValue("--cf-theme-font-family"))
          .toBe("Authored");
      });
    });
  });
});
