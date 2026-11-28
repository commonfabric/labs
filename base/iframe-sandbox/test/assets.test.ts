import { expect } from "@std/expect";

import {
  assetUrlParts,
  missingAssets,
  sameAssets,
  substituteAssets,
  toAssetRecord,
} from "../src/assets.ts";
import { describe, it } from "@commonfabric/test-support/test";

const GLAZE = "data:image/png;base64,iVBORw0KGgo=";
const MENU = "data:font/woff2;base64,d09GMg==";

describe("assets", () => {
  describe("assetUrlParts()", () => {
    it("returns the media type and the base64 bytes of a base64 `data:` URL", () => {
      expect(assetUrlParts(GLAZE)).toEqual({
        mediaType: "image/png",
        base64: "iVBORw0KGgo=",
      });
    });

    it("keeps the parameters of the media type", () => {
      expect(
        assetUrlParts("data:image/svg+xml;charset=utf-8;base64,PHN2Zy8+"),
      ).toEqual({
        mediaType: "image/svg+xml;charset=utf-8",
        base64: "PHN2Zy8+",
      });
    });

    it("returns empty bytes for an empty asset", () => {
      expect(assetUrlParts("data:audio/wav;base64,")).toEqual({
        mediaType: "audio/wav",
        base64: "",
      });
    });

    for (
      const [what, url] of [
        ["a URL that is not a `data:` URL", "https://example.com/glaze.png"],
        ["a `data:` URL that is not base64", "data:image/svg+xml,<svg/>"],
        ["a `data:` URL with no media type", "data:;base64,AAAA"],
        ["base64 missing its padding", "data:image/png;base64,iVBORw0KGgo"],
        ["base64 padded past its length", "data:image/png;base64,AAAA===="],
        ["bytes outside the base64 alphabet", "data:image/png;base64,AA-_"],
        ["a quote in the media type", 'data:image/png";base64,AAAA'],
        ["a parenthesis after the bytes", "data:image/png;base64,AAAA)"],
        ["whitespace in the bytes", "data:image/png;base64,AA AA"],
      ] as const
    ) {
      it(`returns \`undefined\` for ${what}`, () => {
        expect(assetUrlParts(url)).toBeUndefined();
      });
    }
  });

  describe("toAssetRecord()", () => {
    it("returns a frozen copy of a record of base64 `data:` URLs", () => {
      const value = { glaze: GLAZE, "menu_2-bold": MENU };
      const record = toAssetRecord(value);
      value.glaze = MENU;

      expect(record).toEqual({ glaze: GLAZE, "menu_2-bold": MENU });
      expect(Object.isFrozen(record)).toBe(true);
    });

    it("keeps `__proto__` as a name of its own", () => {
      const value = JSON.parse(`{"__proto__": "${GLAZE}"}`);
      const record = toAssetRecord(value);

      expect(Object.hasOwn(record, "__proto__")).toBe(true);
      expect(record.__proto__).toBe(GLAZE);
      expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    });

    for (
      const [what, value, message] of [
        ["`null`", null, "Assets are a record"],
        ["an array", [GLAZE], "Assets are a record"],
        ["a string", GLAZE, "Assets are a record"],
        [
          "a name with a dot",
          { "glaze.small": GLAZE },
          'The asset name `"glaze.small"` does not match',
        ],
        ["an empty name", { "": GLAZE }, 'The asset name `""` does not match'],
        [
          "a URL that is not a base64 `data:` URL",
          { glaze: "https://example.com/glaze.png" },
          "The asset `glaze` is not a base64 `data:` URL",
        ],
        [
          "a value that is not a string",
          { glaze: 1 },
          "The asset `glaze` is not a base64 `data:` URL",
        ],
      ] as const
    ) {
      it(`throws a \`TypeError\` naming the problem given ${what}`, () => {
        expect(() => toAssetRecord(value)).toThrow(TypeError);
        expect(() => toAssetRecord(value)).toThrow(message);
      });
    }
  });

  describe("sameAssets()", () => {
    it("returns `true` for records holding the same names and URLs", () => {
      expect(sameAssets({ glaze: GLAZE, menu: MENU }, {
        menu: MENU,
        glaze: GLAZE,
      })).toBe(true);
      expect(sameAssets({}, {})).toBe(true);
    });

    it("returns `false` for records whose names or URLs differ", () => {
      expect(sameAssets({ glaze: GLAZE }, { glaze: MENU })).toBe(false);
      expect(sameAssets({ glaze: GLAZE }, { menu: GLAZE })).toBe(false);
      expect(sameAssets({ glaze: GLAZE }, { glaze: GLAZE, menu: MENU }))
        .toBe(false);
      expect(sameAssets({ glaze: GLAZE, menu: MENU }, { glaze: GLAZE }))
        .toBe(false);
    });
  });

  describe("substituteAssets()", () => {
    it("replaces every reference, in attributes, styles and inline scripts", () => {
      const html = `<img src="cf-asset:glaze">` +
        `<style>@font-face { src: url(cf-asset:menu); }</style>` +
        `<div style='background: url(cf-asset:glaze)'></div>` +
        `<script>const url = "cf-asset:glaze";</script>`;

      expect(substituteAssets(html, { glaze: GLAZE, menu: MENU })).toBe(
        `<img src="${GLAZE}">` +
          `<style>@font-face { src: url(${MENU}); }</style>` +
          `<div style='background: url(${GLAZE})'></div>` +
          `<script>const url = "${GLAZE}";</script>`,
      );
    });

    it("ends a name at the first character outside its grammar", () => {
      expect(
        substituteAssets("cf-asset:glaze.png cf-asset:glaze-2", {
          glaze: GLAZE,
          "glaze-2": MENU,
        }),
      ).toBe(`${GLAZE}.png ${MENU}`);
    });

    it("leaves a reference to a name the record lacks in place", () => {
      expect(
        substituteAssets(
          '<img src="cf-asset:logo"><img src="cf-asset:glaze">',
          {
            glaze: GLAZE,
          },
        ),
      ).toBe(`<img src="cf-asset:logo"><img src="${GLAZE}">`);
    });

    it("leaves a reference to a name only the prototype holds in place", () => {
      expect(substituteAssets("cf-asset:constructor", {})).toBe(
        "cf-asset:constructor",
      );
    });

    it("leaves `cf-asset:` with no name after it, and other spellings, alone", () => {
      const html = "cf-asset: CF-ASSET:glaze cf-asset:&#58;glaze";
      expect(substituteAssets(html, { glaze: GLAZE })).toBe(html);
    });
  });

  describe("missingAssets()", () => {
    it("returns each name the record lacks once, in the order first referred to", () => {
      const html = "cf-asset:logo cf-asset:glaze cf-asset:bell cf-asset:logo";
      expect(missingAssets(html, { glaze: GLAZE })).toEqual(["logo", "bell"]);
    });

    it("returns no names when the record holds every one referred to", () => {
      expect(missingAssets("cf-asset:glaze cf-asset:menu", {
        glaze: GLAZE,
        menu: MENU,
      })).toEqual([]);
    });

    it("returns a name only the prototype holds", () => {
      expect(missingAssets("cf-asset:toString", {})).toEqual(["toString"]);
    });
  });
});
