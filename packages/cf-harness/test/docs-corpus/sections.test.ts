import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { findSectionPassage } from "../../src/docs-corpus/sections.ts";

const section = (text: string) => ({
  path: "docs/collections.md",
  heading: "Collections",
  text,
  integrity: [],
});

describe("sections", () => {
  describe("findSectionPassage()", () => {
    it("returns the complete matching fenced example beyond the opening window", () => {
      const example =
        "```tsx\nconst total = computed(() => items.length);\n```";
      const text = "Unrelated introduction.\n\n".repeat(700) + example +
        "\n\nUnrelated ending.";
      const passage = findSectionPassage(section(text), "computed total");
      expect(passage.content).toBe(example);
      expect(passage.offset).toBe(text.indexOf(example));
      expect(text.slice(passage.offset, passage.end)).toBe(passage.content);
    });

    it("prefers the passage covering both terms over an earlier partial match", () => {
      const text = "counter\n\n" + "background ".repeat(500) +
        "\n\nThe counter accepts a writable initial value.\n\nEnd.";
      expect(findSectionPassage(section(text), "counter writable").content)
        .toBe("The counter accepts a writable initial value.\n");
    });

    it("keeps an exact bounded excerpt when the matching block is larger than the window", () => {
      const text = "x".repeat(10_000) + " desired contract " +
        "y".repeat(10_000);
      const passage = findSectionPassage(
        section(text),
        "desired contract",
        500,
      );
      expect(passage.offset).toBeGreaterThan(8_000);
      expect(passage.content).toContain("desired contract");
      expect(passage.content.length).toBeLessThanOrEqual(500);
      expect(text.slice(passage.offset, passage.end)).toBe(passage.content);
    });
  });
});
