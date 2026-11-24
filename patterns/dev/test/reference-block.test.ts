import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  attachDefinitions,
  splitDefinitions,
} from "../../system/notes/reference-block.ts";

const A = { key: "a3f9zz", address: "/of:fid1:aaa" };
const B = { key: "b7k2m1", address: "/of:fid1:bbb" };

describe("reference-block", () => {
  describe("attachDefinitions()", () => {
    it("returns the content unchanged when there are no definitions", () => {
      expect(attachDefinitions("Some prose.", [])).toBe("Some prose.");
    });

    it("attaches a block beneath the content", () => {
      expect(attachDefinitions("Some prose.", [A])).toBe(
        "Some prose.\n\n[a3f9zz]: /of:fid1:aaa",
      );
    });

    it("keeps the definitions in the order given", () => {
      expect(attachDefinitions("x", [B, A])).toBe(
        "x\n\n[b7k2m1]: /of:fid1:bbb\n[a3f9zz]: /of:fid1:aaa",
      );
    });
  });

  describe("splitDefinitions()", () => {
    it("reads a block back", () => {
      const split = splitDefinitions("Some prose.\n\n[a3f9zz]: /of:fid1:aaa");
      expect(split.content).toBe("Some prose.");
      expect(split.definitions).toEqual([A]);
    });

    it("returns no definitions for prose that has none", () => {
      const split = splitDefinitions("Just words.\n\nMore words.");
      expect(split.content).toBe("Just words.\n\nMore words.");
      expect(split.definitions).toEqual([]);
    });

    it("leaves a run holding a non-definition line as prose", () => {
      const body = "Prose.\n\n[a3f9zz]: /of:fid1:aaa\nand a stray line";
      const split = splitDefinitions(body);
      expect(split.content).toBe(body);
      expect(split.definitions).toEqual([]);
      expect(split.malformed).toEqual(["and a stray line"]);
    });

    it("reads a definition the user added", () => {
      const split = splitDefinitions(
        "Prose.\n\n[a3f9zz]: /of:fid1:aaa\n[b7k2m1]: /of:fid1:bbb",
      );
      expect(split.definitions).toEqual([A, B]);
    });

    it("reads a definition whose address the user changed", () => {
      const split = splitDefinitions("Prose.\n\n[a3f9zz]: /of:fid1:zzz");
      expect(split.definitions).toEqual([
        { key: "a3f9zz", address: "/of:fid1:zzz" },
      ]);
    });

    it("reads an address that is an ordinary URL", () => {
      const split = splitDefinitions(
        "Prose.\n\n[a3f9zz]: https://example.com/page",
      );
      expect(split.definitions[0].address).toBe("https://example.com/page");
    });

    it("returns empty content for a body that is only a block", () => {
      const split = splitDefinitions("[a3f9zz]: /of:fid1:aaa");
      expect(split.content).toBe("");
      expect(split.definitions).toEqual([A]);
    });
  });

  describe("the round trip", () => {
    const bodies = [
      "",
      "Some prose.",
      "Prose.\n\nWith paragraphs.",
      "A line ending in a bracket [like this]",
      "Trailing newline.\n",
      "- a list\n- of things",
    ];

    it("returns a body attached and split back to exactly itself", () => {
      for (const content of bodies) {
        for (const definitions of [[], [A], [A, B]]) {
          const attached = attachDefinitions(content, definitions);
          const split = splitDefinitions(attached);
          expect(split.content).toBe(content);
          expect(split.definitions).toEqual(definitions);
        }
      }
    });

    it("returns a file written back untouched as no change at all", () => {
      // The property every `touch` depends on: attach(split(x)) === x.
      for (const content of bodies) {
        for (const definitions of [[], [A], [A, B]]) {
          const attached = attachDefinitions(content, definitions);
          const split = splitDefinitions(attached);
          expect(attachDefinitions(split.content, split.definitions)).toBe(
            attached,
          );
        }
      }
    });
  });
});
