import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { existsSync, walkSync } from "@std/fs";
import { fromFileUrl, relative } from "@std/path";

import {
  currentPatternKey,
  formerPatternKey,
  mainNamesPattern,
  MOVED_PATTERN_KEYS,
} from "../src/pattern-key-moves.ts";
import {
  normalizePatternSource,
  resolveSystemPatternSource,
} from "../src/pattern-source-scheme.ts";
import { classifyPieceOriginString } from "../src/piece-origin-kind.ts";

const repository = fromFileUrl(new URL("../../../", import.meta.url));
const patterns = `${repository}patterns`;
const MOVES = Object.entries(MOVED_PATTERN_KEYS);

describe("pattern-key-moves", () => {
  describe("currentPatternKey()", () => {
    it("returns the new key of a file the table names", () => {
      expect(currentPatternKey("system/home.tsx")).toBe(
        "system/home/home.tsx",
      );
      expect(currentPatternKey("counter.tsx")).toBe("counter.tsx");
      expect(currentPatternKey("dice.tsx")).toBe("showcase/dice/dice.tsx");
    });

    it("returns the new key of a file below a directory the table names", () => {
      expect(currentPatternKey("fabrichat/room.tsx")).toBe(
        "system/fabrichat/room.tsx",
      );
      expect(currentPatternKey("lunch-poll/main.tsx")).toBe(
        "apps/lunch-poll/main.tsx",
      );
    });

    it("returns the key from a file's own entry rather than its directory's", () => {
      expect(currentPatternKey("test/vnode-helpers.ts")).toBe(
        "tools/test-support/vnode-helpers.ts",
      );
      expect(currentPatternKey("test/autosave-test.tsx")).toBe(
        "dev/test/autosave-test.tsx",
      );
    });

    it("returns a key that never moved, or already moved, unchanged", () => {
      for (
        const key of [
          "system/home/home.tsx",
          "apps/lunch-poll/main.tsx",
          "agent-sessions-debug/main.tsx",
          "fabrichatx/room.tsx",
        ]
      ) {
        expect(currentPatternKey(key)).toBe(key);
      }
    });
  });

  describe("formerPatternKey()", () => {
    it("returns the key a moved pattern had", () => {
      expect(formerPatternKey("system/home/home.tsx")).toBe("system/home.tsx");
      expect(formerPatternKey("system/fabrichat/room.tsx")).toBe(
        "fabrichat/room.tsx",
      );
    });

    it("returns the key currentPatternKey() was given, for every key the table moves", () => {
      for (
        const key of [
          "system/profile-home.tsx",
          "examples/clock.tsx",
          "examples/data/phonetic-alphabet.json",
          "topics/topic.tsx",
          "test/vnode-helpers.ts",
          "dev/never-moved.tsx",
        ]
      ) {
        expect(formerPatternKey(currentPatternKey(key))).toBe(key);
      }
    });
  });

  describe("mainNamesPattern()", () => {
    it("returns `true` for a module name ending in the current key, or in the former key below a patterns directory", () => {
      const key = "system/profile-home/profile-home.tsx";
      for (
        const main of [
          "/patterns/system/profile-home/profile-home.tsx",
          "/api/patterns/system/profile-home.tsx",
          "/packages/patterns/system/profile-home.tsx",
          "/system/profile-home.tsx",
        ]
      ) {
        expect({ main, names: mainNamesPattern(main, key) })
          .toEqual({ main, names: true });
      }
    });

    it("returns `false` for a module name that names another pattern", () => {
      expect(
        mainNamesPattern(
          "/api/patterns/system/profile-picker.tsx",
          "system/profile-home/profile-home.tsx",
        ),
      ).toBe(false);
    });

    it("returns `false` for a module name that ends in a former key inside another pattern", () => {
      expect(
        mainNamesPattern(
          "/patterns/apps/foo/chatbot.tsx",
          "system/chatbot/chatbot.tsx",
        ),
      ).toBe(false);
      expect(
        mainNamesPattern(
          "/patterns/examples/topics/main.tsx",
          "apps/topics/main.tsx",
        ),
      ).toBe(false);
    });
  });

  describe("a `system:` ref naming a moved pattern", () => {
    it("returns the route the pattern is served under now", () => {
      expect(resolveSystemPatternSource("system:fabrichat/room.tsx")).toBe(
        "/api/patterns/system/fabrichat/room.tsx",
      );
      expect(resolveSystemPatternSource("system:system/home/home.tsx")).toBe(
        "/api/patterns/system/home/home.tsx",
      );
    });

    it("returns the ref naming the pattern now", () => {
      expect(normalizePatternSource("system:system/home.tsx")).toBe(
        "system:system/home/home.tsx",
      );
      expect(normalizePatternSource("/api/patterns/lunch-poll/main.tsx")).toBe(
        "system:apps/lunch-poll/main.tsx",
      );
      expect(normalizePatternSource("system:system/home/home.tsx")).toBe(
        "system:system/home/home.tsx",
      );
    });

    it("returns `legacy-path` for the old ref and `system` for the new one", () => {
      expect(classifyPieceOriginString("system:topics/main.tsx")).toEqual({
        kind: "legacy-path",
        path: "system:topics/main.tsx",
        ref: "system:apps/topics/main.tsx",
      });
      expect(classifyPieceOriginString("system:apps/topics/main.tsx"))
        .toEqual({
          kind: "system",
          ref: "system:apps/topics/main.tsx",
          route: "/api/patterns/apps/topics/main.tsx",
        });
    });
  });
  describe("the table", () => {
    it("names no key the patterns tree holds, and only targets it holds", () => {
      for (const [from, to] of MOVES) {
        expect({ from, exists: existsSync(`${patterns}/${from}`) })
          .toEqual({ from, exists: false });
        expect({ to, exists: existsSync(`${patterns}/${to}`) })
          .toEqual({ to, exists: true });
      }
    });

    it("returns the key of every file in the patterns tree unchanged", () => {
      for (const entry of walkSync(patterns, { includeDirs: false })) {
        const key = relative(patterns, entry.path).replaceAll("\\", "/");
        if (key.startsWith("baselines/")) continue;
        expect(currentPatternKey(key)).toBe(key);
      }
    });

    it("maps each bare-key line of the test-identity aliases to its target", async () => {
      // A bare-key line renames a key that a gate's item names without the
      // `patterns/` prefix.
      const lines = (await Deno.readTextFile(
        `${repository}tasks/test-identity-aliases/moved-paths.jsonl`,
      )).split("\n").filter((line) => line.length > 0).map((line) =>
        JSON.parse(line)
      ).filter(({ from }) =>
        typeof from.p === "string" &&
        !["packages/", "patterns/", "tools/"].some((prefix) =>
          from.p.startsWith(prefix)
        )
      );
      expect(lines.length).toBeGreaterThan(0);
      for (const { from, to } of lines) {
        expect({ from: from.p, to: currentPatternKey(from.p) })
          .toEqual({ from: from.p, to: to.p });
      }
    });

    it("matches the moved-path lines of the test-identity aliases", async () => {
      const aliases = new Set(
        (await Deno.readTextFile(
          `${repository}tasks/test-identity-aliases/moved-paths.jsonl`,
        )).split("\n").filter((line) => line.length > 0).map((line) => {
          const { from, to } = JSON.parse(line);
          return `${from.p} ${to.p}`;
        }),
      );
      for (const [from, to] of MOVES) {
        const line = `patterns/${from.replace(/\/$/, "")} ` +
          `patterns/${to.replace(/\/$/, "")}`;
        expect({ line, recorded: aliases.has(line) })
          .toEqual({ line, recorded: true });
      }
      // And every prefixed line is one the table makes.
      const tableLines = new Set(
        MOVES.map(([from, to]) =>
          `patterns/${from.replace(/\/$/, "")} ` +
          `patterns/${to.replace(/\/$/, "")}`
        ),
      );
      for (const line of aliases) {
        if (!line.startsWith("patterns/")) continue;
        expect({ line, fromTable: tableLines.has(line) })
          .toEqual({ line, fromTable: true });
      }
    });
  });
});
