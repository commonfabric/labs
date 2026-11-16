import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  allowedSkillScriptKey,
  isSkillScriptAllowlisted,
  normalizeAllowedSkillScript,
  normalizeSkillScriptPath,
  parseAllowedSkillScriptSpec,
  uniqueAllowedSkillScripts,
} from "../../src/skills/scripts.ts";

const SHA = "dd93980e2f9a1d4c4d50a6e1a3cbb6e2b7a91f3c";
const PIN = `zubair-trabzada/ai-finance-claude/finance-budget@${SHA}`;

describe("scripts.ts", () => {
  //
  // What an allowlist entry may name
  //
  // A registry skill is named; an acquired skill has no registry name and is
  // named by the pin its bytes were read at, which identifies the exact bytes
  // rather than a directory. Both go through one key, so the operator decides
  // one kind of thing.
  //

  describe("normalizeSkillScriptPath()", () => {
    it("returns the path with separators made forward slashes", () => {
      expect(normalizeSkillScriptPath(" scripts\\tools\\run.sh "))
        .toBe("scripts/tools/run.sh");
    });

    it("returns the path with dot segments resolved inside scripts/", () => {
      expect(normalizeSkillScriptPath("./scripts/a/../run.sh"))
        .toBe("scripts/run.sh");
    });

    it("throws for an empty path", () => {
      expect(() => normalizeSkillScriptPath("   ")).toThrow("non-empty");
    });

    it("throws for a path holding a null byte", () => {
      expect(() => normalizeSkillScriptPath("scripts/a\0.sh"))
        .toThrow("null bytes");
    });

    it("throws for an absolute path, in either separator", () => {
      expect(() => normalizeSkillScriptPath("/scripts/a.sh"))
        .toThrow("relative to the skill directory");
      expect(() => normalizeSkillScriptPath("\\scripts\\a.sh"))
        .toThrow("relative to the skill directory");
    });

    it("throws for a path that climbs out of the skill directory", () => {
      expect(() => normalizeSkillScriptPath("scripts/../../a.sh"))
        .toThrow("stay within the skill directory");
      expect(() => normalizeSkillScriptPath("."))
        .toThrow("stay within the skill directory");
    });

    it("throws for a path that names a directory rather than a file", () => {
      // A trailing slash survives normalization, so the scripts directory
      // written as `scripts/` is caught by that rather than by its name.

      expect(() => normalizeSkillScriptPath("scripts")).toThrow(
        "name a file under scripts/",
      );
      expect(() => normalizeSkillScriptPath("scripts/")).toThrow(
        "name a file under scripts/",
      );
      expect(() => normalizeSkillScriptPath("scripts/tools/")).toThrow(
        "name a file under scripts/",
      );
    });
  });

  describe("normalizeAllowedSkillScript()", () => {
    it("accepts a registry skill's name", () => {
      expect(
        normalizeAllowedSkillScript({
          skill: "agent-browser",
          path: "scripts/run.ts",
        }),
      ).toEqual({ skill: "agent-browser", path: "scripts/run.ts" });
    });

    it("accepts an acquired skill's pin", () => {
      expect(
        normalizeAllowedSkillScript({ skill: PIN, path: "scripts/report.sh" }),
      ).toEqual({ skill: PIN, path: "scripts/report.sh" });
    });

    it("throws for a pin whose commit is not a full lowercase SHA", () => {
      expect(() =>
        normalizeAllowedSkillScript({
          skill: "owner/repo/slug@DD93980",
          path: "scripts/a.sh",
        })
      ).toThrow("acquired pin");
    });

    it("throws for a pin whose discovery id has no skill segment", () => {
      expect(() =>
        normalizeAllowedSkillScript({
          skill: `owner/repo@${SHA}`,
          path: "scripts/a.sh",
        })
      ).toThrow("acquired pin");
    });

    it("throws for a name that is neither a registry name nor a pin", () => {
      expect(() =>
        normalizeAllowedSkillScript({ skill: "Not A Name", path: "scripts/a" })
      ).toThrow("acquired pin");
    });

    it("throws for a skill name that is only whitespace", () => {
      expect(() =>
        normalizeAllowedSkillScript({ skill: "  ", path: "scripts/a.sh" })
      ).toThrow("skill name must be non-empty");
    });

    it("throws for a path outside the skill's scripts directory", () => {
      expect(() =>
        normalizeAllowedSkillScript({ skill: PIN, path: "SKILL.md" })
      )
        .toThrow("under scripts/");
    });
  });

  describe("parseAllowedSkillScriptSpec()", () => {
    it("splits an acquired pin's spec at the colon the path opens with", () => {
      // Neither a discovery id nor a commit SHA carries a colon, so widening
      // the skill field did not move where the separator is.
      expect(parseAllowedSkillScriptSpec(`${PIN}:scripts/report.sh`)).toEqual({
        skill: PIN,
        path: "scripts/report.sh",
      });
    });

    it("splits a registry skill's spec the same way", () => {
      expect(parseAllowedSkillScriptSpec("agent-browser:scripts/run.ts"))
        .toEqual({ skill: "agent-browser", path: "scripts/run.ts" });
    });

    it("splits after the pin for a discovery slug that holds a colon", () => {
      // A slug admits a colon, so the FIRST colon can fall inside the skill
      // field. What bounds the pin is the commit SHA, whose alphabet holds
      // none; splitting at the first would leave such a script unnameable.
      const colonPin = `owner/repo/ns:budget@${SHA}`;
      expect(parseAllowedSkillScriptSpec(`${colonPin}:scripts/report.sh`))
        .toEqual({ skill: colonPin, path: "scripts/report.sh" });
    });

    it("splits at the first colon when what precedes it is no pin", () => {
      // `a:b@<not a sha>` is a registry-shaped spec whose path happens to
      // carry an `@`, and it must not be read as an acquired one.
      expect(parseAllowedSkillScriptSpec("agent-browser:scripts/run@v2.ts"))
        .toEqual({ skill: "agent-browser", path: "scripts/run@v2.ts" });
    });

    it("throws for a spec with no separator", () => {
      expect(() => parseAllowedSkillScriptSpec("agent-browser"))
        .toThrow("skill:scripts/path form");
    });

    it("throws for a spec with nothing before the separator", () => {
      expect(() => parseAllowedSkillScriptSpec(":scripts/run.ts"))
        .toThrow("skill:scripts/path form");
    });

    it("throws for a spec with nothing after the separator", () => {
      expect(() => parseAllowedSkillScriptSpec("agent-browser:"))
        .toThrow("skill:scripts/path form");
    });
  });

  describe("isSkillScriptAllowlisted()", () => {
    it("returns true for an acquired script the operator named exactly", () => {
      expect(
        isSkillScriptAllowlisted([{ skill: PIN, path: "scripts/report.sh" }], {
          skill: PIN,
          path: "scripts/report.sh",
        }),
      ).toBe(true);
    });

    it("returns false for the same script acquired at another commit", () => {
      // The pin is the key, so a second acquisition of the same skill at a
      // different commit is a different script to decide about.
      const other = `zubair-trabzada/ai-finance-claude/finance-budget@${
        "0".repeat(40)
      }`;
      expect(
        isSkillScriptAllowlisted([{ skill: PIN, path: "scripts/report.sh" }], {
          skill: other,
          path: "scripts/report.sh",
        }),
      ).toBe(false);
    });

    it("returns false for an empty allowlist", () => {
      expect(isSkillScriptAllowlisted([], { skill: PIN, path: "scripts/a.sh" }))
        .toBe(false);
    });
  });

  describe("allowedSkillScriptKey()", () => {
    it("returns the pin and the path joined, so one entry names one script", () => {
      expect(allowedSkillScriptKey({ skill: PIN, path: "scripts/report.sh" }))
        .toBe(`${PIN}:scripts/report.sh`);
    });
  });

  describe("uniqueAllowedSkillScripts()", () => {
    it("keeps one entry for a script named twice across the two forms", () => {
      expect(
        uniqueAllowedSkillScripts([
          { skill: PIN, path: "scripts/report.sh" },
          { skill: PIN, path: "./scripts/report.sh" },
          { skill: "agent-browser", path: "scripts/run.ts" },
        ]),
      ).toEqual([
        { skill: PIN, path: "scripts/report.sh" },
        { skill: "agent-browser", path: "scripts/run.ts" },
      ]);
    });
  });
});
