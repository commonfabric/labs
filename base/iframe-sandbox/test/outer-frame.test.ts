import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { HOST_ORIGIN } from "../src/csp.ts";
import outerFrame, { outerFrameDocument } from "../src/outer-frame.ts";

describe("outer-frame", () => {
  describe("outerFrameDocument()", () => {
    it("returns a document carrying the script and the host's origin", () => {
      const document = outerFrameDocument("toHost({ type: 'probe' });");
      expect(document).toContain(
        `<script data-host-origin="${HOST_ORIGIN}">`,
      );
      expect(document).toContain("toHost({ type: 'probe' });");
    });

    it("throws given a script carrying `</script>`", () => {
      expect(() => outerFrameDocument("x = '</script>';")).toThrow(
        "must not contain",
      );
    });

    it("throws given a script carrying `</script` in any case", () => {
      expect(() => outerFrameDocument("x = '</SCRIPT';")).toThrow();
    });
  });

  describe("default export", () => {
    it("is a document carrying the outer frame's script", () => {
      expect(outerFrame).toContain("function toHost(");
    });
  });
});
