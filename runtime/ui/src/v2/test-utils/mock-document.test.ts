import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { installMockDocument } from "./mock-document.ts";

describe("mock-document", () => {
  describe("installMockDocument()", () => {
    it("puts its document on the global object, and takes it off on restore", () => {
      const installed = installMockDocument();
      try {
        expect(Reflect.get(globalThis, "document")).toBe(installed.document);
      } finally {
        installed.restore();
      }
      expect("document" in globalThis).toBe(false);
    });

    it("puts back on restore the document it replaced", () => {
      const outer = installMockDocument();
      try {
        const inner = installMockDocument();
        inner.restore();
        expect(Reflect.get(globalThis, "document")).toBe(outer.document);
      } finally {
        outer.restore();
      }
      expect("document" in globalThis).toBe(false);
    });
  });
});
