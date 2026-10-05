import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  buildSnapshot,
  compareSections,
  functionsOf,
  normalizeBlock,
  sectionsOf,
  sha256Hex,
} from "./cfc-spec-snapshot.ts";

const chapter = [
  "# 8. Label Transition Rules",
  "",
  "## 8.12 Store Label Monotonicity",
  "",
  "### 8.12.1 Comparison",
  "",
  "```typescript",
  "function atomLe(proposed: Atom, current: Atom): boolean {  ",
  "  return proposed === current;",
  "}",
  "",
  "export function isMoreRestrictiveCNF(a: Clause[], b: Clause[]): boolean {",
  "  return true;",
  "}",
  "```",
  "",
  "#### Unnumbered aside",
  "",
  "```ts",
  "async function canUpdateStoreLabel<T>(label: T): Promise<boolean> {",
  "  return true;",
  "}",
  "```",
  "",
  "```json",
  '{ "function": "notCode(" }',
  "```",
  "",
  "### 8.12.4 Reads",
  "",
  "```typescript",
  "const canWrite = (label: Label) => true;",
  "```",
].join("\n");

describe("cfc-spec-snapshot", () => {
  describe("sectionsOf()", () => {
    it("returns every numbered heading's number, chapter dot dropped, and skips unnumbered headings", () => {
      expect(sectionsOf(chapter)).toEqual(["8", "8.12", "8.12.1", "8.12.4"]);
    });
  });

  describe("compareSections()", () => {
    it("orders by numeric component rather than by string", () => {
      const sections = ["8.12.4", "8.2", "8.12.1", "8", "10", "8.12"];
      expect(sections.toSorted(compareSections)).toEqual([
        "8",
        "8.2",
        "8.12",
        "8.12.1",
        "8.12.4",
        "10",
      ]);
    });
  });

  describe("normalizeBlock()", () => {
    it("strips trailing whitespace per line and joins with `\\n`", () => {
      expect(normalizeBlock(["a  ", "b\t", "", "c"])).toBe("a\nb\n\nc");
    });
  });

  describe("functionsOf()", () => {
    it("returns each declared function under the nearest numbered heading, sharing its block's hash", async () => {
      const found = await functionsOf("08-12.md", chapter);
      const hash = await sha256Hex(
        normalizeBlock([
          "function atomLe(proposed: Atom, current: Atom): boolean {  ",
          "  return proposed === current;",
          "}",
          "",
          "export function isMoreRestrictiveCNF(a: Clause[], b: Clause[]): boolean {",
          "  return true;",
          "}",
        ]),
      );
      expect(found.map(({ section, name }) => [section, name])).toEqual([
        ["8.12.1", "atomLe"],
        ["8.12.1", "isMoreRestrictiveCNF"],
        ["8.12.1", "canUpdateStoreLabel"],
      ]);
      expect(found[0].sha256).toBe(hash);
      expect(found[1].sha256).toBe(hash);
      expect(found[2].sha256).not.toBe(hash);
    });

    it("gives a block the same hash whatever its trailing whitespace", async () => {
      const [a] = await functionsOf(
        "x.md",
        "## 1\n```ts\nfunction f() {}\n```",
      );
      const [b] = await functionsOf(
        "x.md",
        "## 1\n```ts\nfunction f() {}   \n```",
      );
      expect(a.sha256).toBe(b.sha256);
    });
  });

  describe("buildSnapshot()", () => {
    it("reads sections from every numbered chapter and functions from the pseudocode chapters only", async () => {
      const text = "## 5.1 A\n```ts\nfunction g() {}\n```\n";
      const snapshot = await buildSnapshot("abc", [
        { name: "README.md", text: "## 9.9 Ignored\n" },
        { name: "11-developer-guide.md", text },
        { name: "05-policy-architecture.md", text },
      ]);
      expect(snapshot).toEqual({
        specsCommit: "abc",
        sections: ["5.1"],
        functions: [{
          file: "05-policy-architecture.md",
          section: "5.1",
          name: "g",
          sha256: await sha256Hex("function g() {}"),
        }],
      });
    });
  });
});
