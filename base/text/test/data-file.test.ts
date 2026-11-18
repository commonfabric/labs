import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  dataFileAssets,
  dataFileMediaType,
  dataFileUrl,
  decodeDataFile,
  encodeDataFile,
  isStoredAsDataUrl,
} from "@commonfabric/text/data-file";

/** The first bytes of a PNG file, which are not valid UTF-8. */
const PNG_BYTES = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);

describe("data-file", () => {
  describe("dataFileAssets()", () => {
    it("returns each asset directly in the directory, by its name", () => {
      const assets = dataFileAssets("/donuts/assets", [
        "/donuts/assets/glaze.png",
        "/donuts/assets/menu.woff2",
        "/donuts/assets/README.md",
        "/donuts/assets/old/glaze.png",
        "/donuts/main.tsx",
      ]);

      expect([...assets]).toEqual([
        ["glaze", "/donuts/assets/glaze.png"],
        ["menu", "/donuts/assets/menu.woff2"],
      ]);
    });

    it("reads a directory written with a trailing slash, and the root", () => {
      expect([...dataFileAssets("/donuts/", ["/donuts/glaze.png"])]).toEqual([
        ["glaze", "/donuts/glaze.png"],
      ]);
      expect([...dataFileAssets("/", ["/glaze.png", "/a/b.png"])]).toEqual([
        ["glaze", "/glaze.png"],
      ]);
    });

    it("leaves out a hidden file", () => {
      expect([
        ...dataFileAssets("/a", ["/a/._glaze.png", "/a/.png", "/a/glaze.png"]),
      ]).toEqual([["glaze", "/a/glaze.png"]]);
    });

    it("throws for a file whose name is not an asset name", () => {
      expect(() => dataFileAssets("/a", ["/a/glaze.small.png"])).toThrow(
        "Data file `/a/glaze.small.png` has no asset name: `glaze.small` " +
          "holds characters other than letters, digits, `_`, and `-`.",
      );
    });

    it("throws for two files that would share a name", () => {
      expect(() => dataFileAssets("/a", ["/a/glaze.png", "/a/glaze.webp"]))
        .toThrow(
          "Data files `/a/glaze.png` and `/a/glaze.webp` would both be the " +
            "asset `glaze`.",
        );
    });
  });

  describe("dataFileMediaType()", () => {
    it("returns the media type of an extension in the table", () => {
      expect(dataFileMediaType("glaze.png")).toBe("image/png");
      expect(dataFileMediaType("/sprites/glaze.JPEG")).toBe("image/jpeg");
      expect(dataFileMediaType("menu.woff2")).toBe("font/woff2");
      expect(dataFileMediaType("bell.mp3")).toBe("audio/mpeg");
      expect(dataFileMediaType("logo.svg")).toBe("image/svg+xml");
    });

    it("returns `undefined` for an extension outside the table", () => {
      expect(dataFileMediaType("cities.json")).toBeUndefined();
      expect(dataFileMediaType("README")).toBeUndefined();
      expect(dataFileMediaType(".png")).toBeUndefined();
    });
  });

  describe("isStoredAsDataUrl()", () => {
    it("returns `true` for a binary media file", () => {
      expect(isStoredAsDataUrl("glaze.png")).toBe(true);
      expect(isStoredAsDataUrl("menu.ttf")).toBe(true);
    });

    it("returns `false` for SVG and for a file outside the table", () => {
      expect(isStoredAsDataUrl("logo.svg")).toBe(false);
      expect(isStoredAsDataUrl("cities.json")).toBe(false);
    });
  });

  describe("decodeDataFile()", () => {
    it("returns the text of valid UTF-8, keeping a leading byte order mark", () => {
      const bytes = new TextEncoder().encode("\ufeffcafé \u{1f369}");

      expect(decodeDataFile(bytes, "menu.txt")).toBe(
        "\ufeffcafé \u{1f369}",
      );
    });

    it("throws naming the file for bytes that are not valid UTF-8", () => {
      for (const bytes of [[0xff], [0x61, 0xc3], [0xed, 0xa0, 0x80]]) {
        expect(() => decodeDataFile(new Uint8Array(bytes), "menu.txt"))
          .toThrow("Data file `menu.txt` is not valid UTF-8 text.");
      }
    });

    it("returns a binary media file as a base64 `data:` URL", () => {
      expect(decodeDataFile(PNG_BYTES, "glaze.png")).toBe(
        "data:image/png;base64,iVBORw0KGgo=",
      );
    });

    it("returns SVG as its text", () => {
      expect(decodeDataFile(new TextEncoder().encode("<svg/>"), "logo.svg"))
        .toBe("<svg/>");
    });
  });

  describe("encodeDataFile()", () => {
    it("returns the bytes `decodeDataFile()` read a binary media file from", () => {
      const stored = decodeDataFile(PNG_BYTES, "glaze.png");

      expect(encodeDataFile(stored, "glaze.png")).toEqual(PNG_BYTES);
    });

    it("returns the UTF-8 bytes of a text file", () => {
      const text = "\ufeffcafé \u{1f369}";

      expect(encodeDataFile(text, "menu.txt")).toEqual(
        new TextEncoder().encode(text),
      );
    });

    it("throws for a binary media file whose contents are not its `data:` URL", () => {
      expect(() => encodeDataFile("not a url", "glaze.png")).toThrow(
        "Data file `glaze.png` does not hold an `image/png` `data:` URL.",
      );
      expect(() => encodeDataFile("data:image/gif;base64,AA==", "glaze.png"))
        .toThrow(
          "Data file `glaze.png` does not hold an `image/png` `data:` URL.",
        );
    });
  });

  describe("dataFileUrl()", () => {
    it("returns a binary media file's stored contents", () => {
      const stored = decodeDataFile(PNG_BYTES, "glaze.png");

      expect(dataFileUrl(stored, "glaze.png")).toBe(stored);
    });

    it("returns SVG as a base64 `data:` URL of its UTF-8 bytes", () => {
      const url = dataFileUrl("<svg>é</svg>", "logo.svg");

      expect(url).toBe("data:image/svg+xml;base64,PHN2Zz7DqTwvc3ZnPg==");
    });

    it("throws for a binary media file whose contents are not its `data:` URL", () => {
      expect(() => dataFileUrl("not a url", "glaze.png")).toThrow(
        "Data file `glaze.png` does not hold an `image/png` `data:` URL.",
      );
    });

    it("throws for a binary media file whose `data:` URL holds no base64", () => {
      expect(() =>
        dataFileUrl("data:image/png;base64,not base64!", "glaze.png")
      )
        .toThrow(
          "Data file `glaze.png` does not hold an `image/png` `data:` URL.",
        );
    });

    it("throws listing the table for a file outside it", () => {
      expect(() => dataFileUrl("{}", "cities.json")).toThrow(
        /`cities\.json` has no media type a `data:` URL can carry\. Known extensions: .*`\.png`/,
      );
    });
  });
});
