import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getMimeType } from "@/lib/mime-type.ts";

describe("mime-type", () => {
  describe("getMimeType", () => {
    it("returns the mapped type for each known extension", () => {
      expect(getMimeType("style.css")).toBe("text/css");
      expect(getMimeType("index.html")).toBe("text/html");
      expect(getMimeType("bundle.js")).toBe("text/javascript");
      expect(getMimeType("data.json")).toBe("application/json");
      expect(getMimeType("notes.md")).toBe("text/plain");
      expect(getMimeType("logo.svg")).toBe("image/svg+xml");
      expect(getMimeType("body.ttf")).toBe("font/ttf");
      expect(getMimeType("notes.txt")).toBe("text/plain");
    });

    it("returns the type for the extension after the last dot", () => {
      expect(getMimeType("bundle.js.map")).toBe("application/json");
      expect(getMimeType("dom.d.ts")).toBe("application/octet-stream");
    });

    it("returns `application/octet-stream` for an unknown extension", () => {
      expect(getMimeType("archive.tar")).toBe("application/octet-stream");
    });

    it("returns `application/octet-stream` for a name with no dot", () => {
      expect(getMimeType("LICENSE")).toBe("application/octet-stream");
    });

    it("reads the extension from the last path segment", () => {
      expect(getMimeType("some.dir/index.html")).toBe("text/html");
      expect(getMimeType("some.dir/LICENSE")).toBe("application/octet-stream");
    });
  });
});
