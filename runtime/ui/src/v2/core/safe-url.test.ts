import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { safeImageUrl, safeUrl } from "./safe-url.ts";

describe("safe-url", () => {
  describe("safeUrl()", () => {
    it("returns an `https` URL unchanged", () => {
      expect(safeUrl("https://example.com/a?b=c#d")).toBe(
        "https://example.com/a?b=c#d",
      );
    });

    it("returns a `mailto` URL unchanged", () => {
      expect(safeUrl("mailto:someone@example.com")).toBe(
        "mailto:someone@example.com",
      );
    });

    it("returns a relative URL unchanged", () => {
      expect(safeUrl("/docs/guide.md")).toBe("/docs/guide.md");
      expect(safeUrl("../sibling.png")).toBe("../sibling.png");
    });

    it("returns a fragment unchanged", () => {
      expect(safeUrl("#section-one")).toBe("#section-one");
    });

    it("returns a relative path whose later segment contains a colon", () => {
      // The colon is not a scheme separator here, because what precedes it is
      // not a scheme: a path segment intervenes.
      expect(safeUrl("path/to:file")).toBe("path/to:file");
      expect(safeUrl("/of:bafy123/field")).toBe("/of:bafy123/field");
    });

    it("returns `null` for a `javascript` URL", () => {
      expect(safeUrl("javascript:alert(1)")).toBeNull();
    });

    it("returns `null` for a `javascript` URL in any casing", () => {
      expect(safeUrl("JaVaScRiPt:alert(1)")).toBeNull();
    });

    it("returns `null` for a scheme split or padded by whitespace", () => {
      // The URL parser discards these before it reads the scheme, so each of
      // these names the `javascript` scheme to a browser.
      expect(safeUrl("java\tscript:alert(1)")).toBeNull();
      expect(safeUrl("java\nscript:alert(1)")).toBeNull();
      expect(safeUrl("java\rscript:alert(1)")).toBeNull();
      expect(safeUrl("  javascript:alert(1)")).toBeNull();
    });

    it("returns `null` for a `data` URL", () => {
      expect(safeUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
      expect(safeUrl("data:image/png;base64,AAAA")).toBeNull();
    });

    it("returns `null` for a scheme outside the allowlist", () => {
      expect(safeUrl("vbscript:msgbox(1)")).toBeNull();
      expect(safeUrl("file:///etc/passwd")).toBeNull();
      expect(safeUrl("blob:https://example.com/abc")).toBeNull();
    });
  });

  describe("safeImageUrl()", () => {
    it("returns an `https` URL unchanged", () => {
      expect(safeImageUrl("https://example.com/a.png")).toBe(
        "https://example.com/a.png",
      );
    });

    it("returns a `data:image` URL unchanged", () => {
      expect(safeImageUrl("data:image/png;base64,AAAA")).toBe(
        "data:image/png;base64,AAAA",
      );
      expect(safeImageUrl("DATA:IMAGE/SVG+XML,%3Csvg%3E")).toBe(
        "DATA:IMAGE/SVG+XML,%3Csvg%3E",
      );
    });

    it("returns `null` for a `data` URL that is not an image", () => {
      expect(safeImageUrl("data:text/html,<script>alert(1)</script>"))
        .toBeNull();
    });

    it("returns `null` for a `javascript` URL", () => {
      expect(safeImageUrl("javascript:alert(1)")).toBeNull();
    });

    it("reads the scheme past a control character in a `data:image` URL", () => {
      expect(safeImageUrl("data\t:image/png;base64,AAAA")).toBe(
        "data\t:image/png;base64,AAAA",
      );
    });
  });
});
