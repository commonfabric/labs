// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFProgress } from "./index.ts";

/** A progress bar mounted with `properties`. */
function progressWith(
  properties: Partial<Pick<CFProgress, "value" | "max" | "indeterminate">>,
): Promise<CFProgress> {
  return mount(Object.assign(new CFProgress(), properties));
}

/** Changes `properties` on a mounted bar and waits for it to render them. */
async function change(
  element: CFProgress,
  properties: Partial<Pick<CFProgress, "value" | "max" | "indeterminate">>,
): Promise<void> {
  Object.assign(element, properties);
  await element.updateComplete;
}

const base = (element: CFProgress) =>
  element.shadowRoot!.querySelector<HTMLElement>('[part="base"]')!;

const indicator = (element: CFProgress) =>
  element.shadowRoot!.querySelector<HTMLElement>('[part="indicator"]')!;

describe("CFProgress", () => {
  afterEach(() => document.body.replaceChildren());

  describe("indicator", () => {
    it("fills the share of `max` that `value` reaches", async () => {
      const element = await progressWith({ value: 30, max: 200 });

      expect(indicator(element).style.width).toBe("15%");
      expect(base(element).classList.contains("indeterminate")).toBe(false);
    });

    it("follows `value` as it changes", async () => {
      const element = await progressWith({ value: 30 });

      await change(element, { value: 80 });

      expect(indicator(element).style.width).toBe("80%");
    });

    it("carries no width and the `indeterminate` class while indeterminate", async () => {
      const element = await progressWith({ value: 30, indeterminate: true });

      expect(indicator(element).style.width).toBe("");
      expect(base(element).classList.contains("indeterminate")).toBe(true);
    });

    it("shows an empty bar when `max` is zero or not finite", async () => {
      for (const max of [0, Infinity]) {
        const element = await progressWith({ value: 5, max });

        expect(indicator(element).style.width).toBe("0%");
      }
    });
  });

  describe("value", () => {
    it("is clamped into the range from zero to `max`", async () => {
      expect((await progressWith({ value: 150, max: 120 })).value).toBe(120);
      expect((await progressWith({ value: -5 })).value).toBe(0);
      expect((await progressWith({ value: 42 })).value).toBe(42);
    });

    it("is clamped again when `max` drops below it", async () => {
      const element = await progressWith({ value: 90 });

      await change(element, { max: 50 });

      expect(element.value).toBe(50);
      expect(indicator(element).style.width).toBe("100%");
    });
  });

  describe("accessibility", () => {
    it("describes a determinate bar", async () => {
      const element = await progressWith({ value: 25, max: 200 });

      expect(element.getAttribute("role")).toBe("progressbar");
      expect(element.getAttribute("aria-valuemin")).toBe("0");
      expect(element.getAttribute("aria-valuemax")).toBe("200");
      expect(element.getAttribute("aria-valuenow")).toBe("25");
      expect(element.getAttribute("aria-valuetext")).toBe("13%");
    });

    it("drops `aria-valuenow` and reads as loading once indeterminate", async () => {
      const element = await progressWith({ value: 25 });

      await change(element, { indeterminate: true });

      expect(element.hasAttribute("aria-valuenow")).toBe(false);
      expect(element.getAttribute("aria-valuetext")).toBe("Loading");
      expect(element.hasAttribute("indeterminate")).toBe(true);
    });

    it("leaves attributes the page set alone when nothing they describe changed", async () => {
      const element = await progressWith({ value: 25 });
      element.setAttribute("aria-valuetext", "a quarter");

      element.requestUpdate();
      await element.updateComplete;

      expect(element.getAttribute("aria-valuetext")).toBe("a quarter");
    });
  });
});
