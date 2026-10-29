import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { GUEST_BASE_SHEET } from "./guest-base-sheet.ts";
import {
  guestPresentation,
  guestThemeCss,
  themeVariableNames,
} from "./guest-presentation.ts";

describe("guest-presentation", () => {
  describe("themeVariableNames()", () => {
    it("returns only `--cf-theme-*` names, the text color among them", () => {
      const names = themeVariableNames();
      expect(names).toContain("--cf-theme-color-text");
      expect(names.every((name) => name.startsWith("--cf-theme-"))).toBe(true);
    });
  });

  describe("guestThemeCss()", () => {
    it("returns a `:root` block of the values followed by the base sheet", () => {
      expect(guestThemeCss([
        ["--cf-theme-color-text", "rgb(1, 2, 3)"],
        ["--cf-theme-font-family", "Georgia, serif"],
      ])).toBe(
        ":root {\n" +
          "  --cf-theme-color-text: rgb(1, 2, 3);\n" +
          "  --cf-theme-font-family: Georgia, serif;\n" +
          "}\n" + GUEST_BASE_SHEET,
      );
    });

    it("returns the base sheet alone when there are no values", () => {
      expect(guestThemeCss([])).toBe(GUEST_BASE_SHEET);
    });

    it("throws for a name outside the `--cf-theme-` namespace", () => {
      expect(() => guestThemeCss([["--other", "red"]])).toThrow(
        "--cf-theme-",
      );
    });

    it("throws for an empty value", () => {
      expect(() => guestThemeCss([["--cf-theme-color-text", ""]])).toThrow(
        "empty",
      );
    });
  });

  describe("guestPresentation()", () => {
    it("returns the theme CSS, the resolved scheme as a root attribute, and no stylesheets", () => {
      const values = [["--cf-theme-color-text", "rgb(1, 2, 3)"]] as const;
      expect(guestPresentation(values, "dark")).toEqual({
        css: guestThemeCss(values),
        attributes: { "data-color-scheme": "dark" },
        stylesheets: [],
      });
    });
  });
});
