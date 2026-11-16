// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFToolbar } from "./index.ts";

describe("CFToolbar", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-toolbar`", () => {
    expect(customElements.get("cf-toolbar")).toBe(CFToolbar);
  });

  describe("render()", () => {
    it("renders a start, center, and end region, each with its named slot", async () => {
      const element = await mount(new CFToolbar());
      const toolbar = element.shadowRoot!.querySelector('[part="toolbar"]')!;
      const regions = [...toolbar.children].map((region) => [
        region.getAttribute("part"),
        region.querySelector("slot")?.getAttribute("name"),
      ]);
      expect(regions).toEqual([
        ["start", "start"],
        ["center", "center"],
        ["end", "end"],
      ]);
    });
  });

  describe("connected", () => {
    it("reflects no flags by default", async () => {
      const element = await mount(new CFToolbar());
      for (const name of ["dense", "elevated", "sticky"]) {
        expect(element.hasAttribute(name)).toBe(false);
      }
    });

    it("reflects the flags it is given as attributes", async () => {
      const element = await mount(
        Object.assign(new CFToolbar(), {
          dense: true,
          elevated: true,
          sticky: true,
        }),
      );
      for (const name of ["dense", "elevated", "sticky"]) {
        expect(element.hasAttribute(name)).toBe(true);
      }
    });
  });
});
