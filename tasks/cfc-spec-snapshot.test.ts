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

    it("strips the indentation every non-blank line shares and keeps the rest", () => {
      expect(normalizeBlock(["  a", "", "    b", "  c  "])).toBe(
        "a\n\n  b\nc",
      );
    });
  });

  describe("functionsOf()", () => {
    it("returns each declared function under the nearest numbered heading, sharing its block's hash", () => {
      const found = functionsOf("08-12.md", chapter);
      const hash = sha256Hex(
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

    it("gives a block the same hash at any indentation, as inside a list", () => {
      const [flat] = functionsOf(
        "x.md",
        "## 1\n```ts\nfunction f() {\n  return 1;\n}\n```",
      );
      const [listed] = functionsOf(
        "x.md",
        "## 1\n- item\n\n  ```ts\n  function f() {\n    return 1;\n  }\n  ```",
      );
      expect(listed.sha256).toBe(flat.sha256);
    });

    it("reads a heading inside a non-pseudocode fence as text, and a fence inside a longer fence as text", () => {
      const text = [
        "## 1 Real",
        "```text",
        "### 1.9 Not a heading",
        "```",
        "````md",
        "```ts",
        "function nested() {}",
        "```",
        "````",
        "~~~typescript",
        "function tilde() {}",
        "~~~",
        "```ts title=example",
        "function titled() {}",
        "```",
      ].join("\n");
      expect(sectionsOf(text)).toEqual(["1"]);
      expect(
        (functionsOf("x.md", text)).map(({ section, name }) => [
          section,
          name,
        ]),
      ).toEqual([["1", "tilde"], ["1", "titled"]]);
    });

    it("reads a function whose type parameters nest angle brackets", () => {
      const text =
        "## 1\n```ts\nfunction f<T extends Map<string, Set<number>>>(\n  a: T,\n): T {\n  return a;\n}\nfunction g<K, V>(m: Map<K, V>): void {}\n```";
      expect(functionsOf("x.md", text).map(({ name }) => name)).toEqual([
        "f",
        "g",
      ]);
    });

    it("throws on a fence the chapter never closes, naming the chapter and the line", () => {
      const text = "## 1\n\n```ts\nfunction f() {}\n## 2 swallowed\n";
      expect(() => functionsOf("08-12.md", text)).toThrow(
        "08-12.md: the fence opened at line 3 is never closed",
      );
      expect(() => sectionsOf(text, "08-12.md")).toThrow(
        "08-12.md: the fence opened at line 3 is never closed",
      );
    });

    it("gives a block the same hash whatever its trailing whitespace", () => {
      const [a] = functionsOf(
        "x.md",
        "## 1\n```ts\nfunction f() {}\n```",
      );
      const [b] = functionsOf(
        "x.md",
        "## 1\n```ts\nfunction f() {}   \n```",
      );
      expect(a.sha256).toBe(b.sha256);
    });
  });

  describe("buildSnapshot()", () => {
    it("reads sections from every numbered chapter and functions from the pseudocode chapters only", () => {
      const text = "## 5.1 A\n```ts\nfunction g() {}\n```\n";
      const snapshot = buildSnapshot("abc", [
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
          sha256: sha256Hex("function g() {}"),
        }],
      });
    });
  });
});
