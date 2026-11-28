import { expect } from "@std/expect";

import { createMockElement, installMockDocument } from "./mock-document.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("mock-document", () => {
  describe("createMockElement()", () => {
    it("removeChild detaches only the given child, and ignores an element that is not a child", () => {
      const parent = createMockElement("div");
      const kept = parent.appendChild(createMockElement("span"));
      const removed = parent.appendChild(createMockElement("span"));
      const stranger = createMockElement("span");

      expect(parent.removeChild(removed)).toBe(removed);
      expect(parent.children).toEqual([kept]);
      expect(removed.parentNode).toBeNull();
      expect(kept.parentNode).toBe(parent);

      parent.removeChild(stranger);
      expect(parent.children).toEqual([kept]);
    });

    it("replaceChildren detaches the old children and adopts the new ones", () => {
      const parent = createMockElement("div");
      const old = parent.appendChild(createMockElement("span"));
      const first = createMockElement("b");
      const second = createMockElement("i");

      parent.replaceChildren(first, second);
      expect(parent.children).toEqual([first, second]);
      expect(old.parentNode).toBeNull();
      expect(first.parentNode).toBe(parent);
      expect(second.parentNode).toBe(parent);

      parent.replaceChildren();
      expect(parent.children).toEqual([]);
      expect(first.parentNode).toBeNull();
    });
  });

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
