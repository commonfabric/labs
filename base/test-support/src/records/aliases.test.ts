import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  aliasGraphProblems,
  type AliasLine,
  AliasResolver,
  loadAliasResolver,
  parseAliasLine,
  readAliasDirectory,
} from "./aliases.ts";

const FULL: AliasLine = {
  date: "2026-08-17",
  from: { k: "unit", s: "bakery", n: "glaze > sets" },
  to: { k: "unit", s: "bakery", n: "glaze > cures" },
};

const SCOPE: AliasLine = {
  date: "2026-08-17",
  from: { k: "unit", s: "bakery" },
  to: { k: "unit", s: "patisserie" },
};

const MOVED: AliasLine = {
  date: "2026-08-17",
  from: { p: "kitchen/oven" },
  to: { p: "bakery/oven" },
};

describe("aliases", () => {
  describe("parseAliasLine()", () => {
    it("returns a full-identity alias", () => {
      expect(parseAliasLine(JSON.stringify(FULL))).toEqual(FULL);
    });

    it("returns a whole-scope alias", () => {
      expect(parseAliasLine(JSON.stringify(SCOPE))).toEqual(SCOPE);
    });

    it("returns a moved-path alias", () => {
      expect(parseAliasLine(JSON.stringify(MOVED))).toEqual(MOVED);
    });

    it("returns an error for a moved path that is not relative", () => {
      for (const p of ["/kitchen/oven", "kitchen/oven/", "kitchen/../oven"]) {
        const line = JSON.stringify({ ...MOVED, from: { p } });
        expect(parseAliasLine(line)).toBe("has a malformed `from`");
      }
    });

    it("returns an error when a path maps to an identity", () => {
      const line = JSON.stringify({ ...MOVED, to: FULL.to });
      expect(parseAliasLine(line)).toBe(
        "maps a path to something other than one",
      );
    });

    it("returns an error when a path maps to a bare string", () => {
      const line = JSON.stringify({ ...MOVED, to: "bakery/oven" });
      expect(parseAliasLine(line)).toBe(
        "maps a path to something other than one",
      );
    });

    it("returns an error for malformed JSON", () => {
      expect(parseAliasLine("{oops")).toBe("is not JSON");
    });

    it("returns an error for a missing date", () => {
      const line = JSON.stringify({ from: FULL.from, to: FULL.to });
      expect(parseAliasLine(line)).toBe("has no ISO date");
    });

    it("returns an error for an impossible calendar date", () => {
      const line = JSON.stringify({ ...FULL, date: "2026-02-31" });
      expect(parseAliasLine(line)).toBe("has an impossible calendar date");
    });

    it("returns an error when a scope maps to a single identity", () => {
      const line = JSON.stringify({
        date: "2026-08-17",
        from: { k: "unit", s: "bakery" },
        to: { k: "unit", s: "patisserie", n: "one test" },
      });
      expect(typeof parseAliasLine(line)).toBe("string");
    });

    it("returns an error for a variant-scoped alias", () => {
      const line = JSON.stringify({
        ...FULL,
        from: { ...FULL.from, v: "wood-fired" },
      });
      expect(parseAliasLine(line)).toBe("has a malformed `from`");
    });
  });

  describe("aliasGraphProblems()", () => {
    it("returns nothing for a chain", () => {
      const chain: AliasLine[] = [
        FULL,
        {
          date: "2026-08-18",
          from: { k: "unit", s: "bakery", n: "glaze > cures" },
          to: { k: "unit", s: "bakery", n: "glaze > hardens" },
        },
      ];
      expect(aliasGraphProblems(chain)).toEqual([]);
    });

    it("returns a problem for a second mapping from one identity", () => {
      const doubled: AliasLine[] = [FULL, {
        ...FULL,
        to: { k: "unit", s: "bakery", n: "elsewhere" },
      }];
      expect(aliasGraphProblems(doubled).length).toBe(1);
      expect(aliasGraphProblems(doubled)[0]).toContain("two mappings");
    });

    it("returns a problem for a two-step cycle", () => {
      const cycle: AliasLine[] = [
        FULL,
        {
          date: "2026-08-18",
          from: { k: "unit", s: "bakery", n: "glaze > cures" },
          to: { k: "unit", s: "bakery", n: "glaze > sets" },
        },
      ];
      const problems = aliasGraphProblems(cycle);
      expect(problems.length).toBeGreaterThan(0);
      expect(problems[0]).toContain("cycle");
    });

    it("returns a problem for a second mapping from one path", () => {
      const doubled: AliasLine[] = [MOVED, { ...MOVED, to: { p: "cafe" } }];
      expect(aliasGraphProblems(doubled)[0]).toContain("two mappings");
    });

    it("returns a problem for a path moved back", () => {
      const back: AliasLine[] = [MOVED, {
        date: "2026-08-18",
        from: MOVED.to,
        to: MOVED.from,
      }];
      expect(aliasGraphProblems(back)[0]).toContain("cycle");
    });

    it("returns a problem for a path moved into a path that holds it", () => {
      const inward: AliasLine[] = [{
        date: "2026-08-17",
        from: { p: "kitchen" },
        to: { p: "kitchen/old" },
      }];
      expect(aliasGraphProblems(inward)[0]).toContain("holds it");
    });

    it("returns a problem for a self-mapping", () => {
      const selfLoop: AliasLine[] = [{ ...FULL, to: FULL.from }];
      expect(aliasGraphProblems(selfLoop).length).toBe(1);
    });

    it("keeps a tail into a cycle from doubling the report", () => {
      const tailAndCycle: AliasLine[] = [
        {
          date: "2026-08-17",
          from: { k: "unit", s: "bakery", n: "tail" },
          to: { k: "unit", s: "bakery", n: "a" },
        },
        {
          date: "2026-08-17",
          from: { k: "unit", s: "bakery", n: "a" },
          to: { k: "unit", s: "bakery", n: "b" },
        },
        {
          date: "2026-08-17",
          from: { k: "unit", s: "bakery", n: "b" },
          to: { k: "unit", s: "bakery", n: "a" },
        },
      ];
      expect(aliasGraphProblems(tailAndCycle).length).toBe(2);
    });
  });

  describe("AliasResolver", () => {
    it("maps an old identity recorded before the rename", () => {
      const resolver = new AliasResolver([FULL]);
      expect(resolver.resolve(
        { k: "unit", s: "bakery", n: "glaze > sets" },
        "2026/08/10",
      )).toEqual({ k: "unit", s: "bakery", n: "glaze > cures" });
    });

    it("leaves a record from the rename day onward alone", () => {
      const resolver = new AliasResolver([FULL]);
      const identity = { k: "unit", s: "bakery", n: "glaze > sets" };
      expect(resolver.resolve(identity, "2026/08/17")).toEqual(identity);
      expect(resolver.resolve(identity, "2026/08/20")).toEqual(identity);
    });

    it("follows a chain of renames transitively", () => {
      const resolver = new AliasResolver([
        FULL,
        {
          date: "2026-08-19",
          from: { k: "unit", s: "bakery", n: "glaze > cures" },
          to: { k: "unit", s: "bakery", n: "glaze > hardens" },
        },
      ]);
      expect(resolver.resolve(
        { k: "unit", s: "bakery", n: "glaze > sets" },
        "2026/08/10",
      )).toEqual({ k: "unit", s: "bakery", n: "glaze > hardens" });
    });

    it("renames a whole scope keeping each test's name", () => {
      const resolver = new AliasResolver([SCOPE]);
      expect(resolver.resolve(
        { k: "unit", s: "bakery", n: "anything" },
        "2026/08/10",
      )).toEqual({ k: "unit", s: "patisserie", n: "anything" });
    });

    it("keeps the variant while resolving aliases", () => {
      const resolver = new AliasResolver([FULL, SCOPE]);
      expect(resolver.resolve(
        {
          k: "unit",
          s: "bakery",
          n: "glaze > sets",
          v: "wood-fired",
        },
        "2026/08/10",
      )).toEqual({
        k: "unit",
        s: "patisserie",
        n: "glaze > cures",
        v: "wood-fired",
      });
    });

    it("prefers a full-identity mapping over the scope's", () => {
      const resolver = new AliasResolver([SCOPE, {
        date: "2026-08-17",
        from: { k: "unit", s: "bakery", n: "special" },
        to: { k: "unit", s: "confiserie", n: "special" },
      }]);
      expect(resolver.resolve(
        { k: "unit", s: "bakery", n: "special" },
        "2026/08/10",
      )).toEqual({ k: "unit", s: "confiserie", n: "special" });
    });

    it("renames a moved path wherever a name holds it", () => {
      const resolver = new AliasResolver([MOVED]);
      expect(resolver.resolve(
        { k: "gate", s: "ci", n: "hooks kitchen/oven/a.test.ts" },
        "2026/08/10",
      )).toEqual({ k: "gate", s: "ci", n: "hooks bakery/oven/a.test.ts" });
      expect(resolver.resolve(
        { k: "pattern", s: "bakery", n: "kitchen/oven" },
        "2026/08/10",
      )).toEqual({ k: "pattern", s: "bakery", n: "bakery/oven" });
    });

    it("leaves a longer path that only begins with a moved one alone", () => {
      const resolver = new AliasResolver([MOVED]);
      for (
        const n of [
          "kitchen/ovens/a.ts",
          "kitchen/oven-door",
          "kitchen/oven.md",
          "x/kitchen/oven",
        ]
      ) {
        const identity = { k: "gate", s: "ci", n };
        expect(resolver.resolve(identity, "2026/08/10")).toEqual(identity);
      }
    });

    it("leaves a name holding a moved path alone from the move onward", () => {
      const resolver = new AliasResolver([MOVED]);
      const identity = { k: "gate", s: "ci", n: "kitchen/oven/a.ts" };
      expect(resolver.resolve(identity, "2026/08/17")).toEqual(identity);
    });

    it("takes the longest of two moved paths that both hold a name's path", () => {
      const nested: AliasLine = {
        date: "2026-08-17",
        from: { p: "kitchen" },
        to: { p: "galley" },
      };
      for (const aliases of [[nested, MOVED], [MOVED, nested]]) {
        expect(
          new AliasResolver(aliases).resolve(
            { k: "gate", s: "ci", n: "kitchen/oven/a.ts kitchen/sink" },
            "2026/08/10",
          ).n,
        ).toBe("bakery/oven/a.ts galley/sink");
      }
    });

    it("returns a name whose path moved into a path holding it, moved once", () => {
      const resolver = new AliasResolver([{
        date: "2026-08-17",
        from: { p: "kitchen" },
        to: { p: "kitchen/old" },
      }]);
      expect(
        resolver.resolve(
          { k: "gate", s: "ci", n: "kitchen/a.ts" },
          "2026/08/10",
        ).n,
      ).toBe("kitchen/old/a.ts");
    });

    it("prefers a full-identity mapping over a moved path", () => {
      const resolver = new AliasResolver([MOVED, {
        date: "2026-08-17",
        from: { k: "gate", s: "ci", n: "kitchen/oven/a.ts" },
        to: { k: "gate", s: "ci", n: "renamed" },
      }]);
      expect(resolver.resolve(
        { k: "gate", s: "ci", n: "kitchen/oven/a.ts" },
        "2026/08/10",
      )).toEqual({ k: "gate", s: "ci", n: "renamed" });
    });

    it("stops on a malformed cycle instead of hanging", () => {
      const resolver = new AliasResolver([
        FULL,
        {
          date: "2026-08-17",
          from: { k: "unit", s: "bakery", n: "glaze > cures" },
          to: { k: "unit", s: "bakery", n: "glaze > sets" },
        },
      ]);
      const resolved = resolver.resolve(
        { k: "unit", s: "bakery", n: "glaze > sets" },
        "2026/08/10",
      );
      expect(resolved.s).toBe("bakery");
    });
  });

  describe("AliasResolver.resolvePath()", () => {
    it("returns a path with a moved directory renamed, for a day before the move", () => {
      const resolver = new AliasResolver([MOVED, FULL, SCOPE]);
      expect(resolver.resolvePath("kitchen/oven/a.test.ts", "2026-08-10"))
        .toBe("bakery/oven/a.test.ts");
      expect(resolver.resolvePath("kitchen/oven", "2026/08/10"))
        .toBe("bakery/oven");
    });

    it("returns a path unchanged for a day from the move onward, or one no move names", () => {
      const resolver = new AliasResolver([MOVED]);
      expect(resolver.resolvePath("kitchen/oven/a.test.ts", "2026-08-17"))
        .toBe("kitchen/oven/a.test.ts");
      expect(resolver.resolvePath("kitchen/ovens/a.test.ts", "2026-08-10"))
        .toBe("kitchen/ovens/a.test.ts");
    });
  });

  describe("readAliasDirectory()", () => {
    let directory: string;

    beforeEach(async () => {
      directory = await Deno.makeTempDir({ prefix: "test-records-aliases-" });
    });

    afterEach(async () => {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
    });

    it("returns the `.jsonl` files and the other entries, each in order of name", async () => {
      await Deno.writeTextFile(join(directory, "b.test.ts.jsonl"), "second\n");
      await Deno.writeTextFile(join(directory, "a.test.ts.jsonl"), "first\n");
      await Deno.writeTextFile(join(directory, "README.md"), "prose\n");
      await Deno.mkdir(join(directory, "nested.jsonl"));
      expect(await readAliasDirectory(directory)).toEqual({
        files: [
          { name: "a.test.ts.jsonl", text: "first\n" },
          { name: "b.test.ts.jsonl", text: "second\n" },
        ],
        unread: ["README.md", "nested.jsonl"],
      });
    });

    it("returns nothing for a missing directory", async () => {
      expect(await readAliasDirectory(join(directory, "absent"))).toEqual({
        files: [],
        unread: [],
      });
    });

    it("throws given a path that is not a directory", async () => {
      const file = join(directory, "a.test.ts.jsonl");
      await Deno.writeTextFile(file, "first\n");
      await expect(readAliasDirectory(file)).rejects.toThrow();
    });
  });

  describe("loadAliasResolver()", () => {
    let directory: string;

    beforeEach(async () => {
      directory = await Deno.makeTempDir({ prefix: "test-records-aliases-" });
    });

    afterEach(async () => {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
    });

    it("loads parsable lines from every file and skips the rest", async () => {
      await Deno.writeTextFile(
        join(directory, "glaze.test.ts.jsonl"),
        `${JSON.stringify(FULL)}\nnot json\n`,
      );
      await Deno.writeTextFile(
        join(directory, "whole-scope.jsonl"),
        `${JSON.stringify(SCOPE)}\n`,
      );
      const resolver = await loadAliasResolver(directory);
      expect(
        resolver.resolve(
          { k: "unit", s: "bakery", n: "glaze > sets" },
          "2026/08/10",
        ),
      ).toEqual({ k: "unit", s: "patisserie", n: "glaze > cures" });
    });

    it("returns an empty resolver for a missing directory", async () => {
      const resolver = await loadAliasResolver(join(directory, "absent"));
      expect(resolver.empty).toBe(true);
    });

    it("finds the repository's own alias directory with no path given", async () => {
      const resolver = await loadAliasResolver();
      expect(resolver.empty).toBe(false);
      const identity = { k: "unit", s: "bakery", n: "unmapped" };
      expect(resolver.resolve(identity, "2026/08/10")).toEqual(identity);
    });
  });
});
