import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { ConsolePolicyReport } from "../console/policy.ts";
import {
  checkCellSpec,
  describeCellSpecMismatches,
  parseCellSpec,
} from "../scripts/cell-spec.ts";

/** What a correctly configured measurement console reports about itself. */
const POLICY: ConsolePolicyReport = {
  systemPromptSha256:
    "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  allowedToolIds: ["shell", "run_pattern", "search_patterns"],
  allowedSubagentProfiles: ["default", "pattern-author"],
  fabricSpace: "measurement",
  artifactRoot: "/console/runs",
  sessionDbPath: "/console/sessions.sqlite",
};

describe("cell-spec", () => {
  describe("parseCellSpec()", () => {
    it("returns only the fields the file carries", () => {
      expect(parseCellSpec({ label: "phase 3", fabricSpace: "measurement" }))
        .toEqual({ label: "phase 3", fabricSpace: "measurement" });
    });

    it("returns a spec whose `systemPromptSha256` is `null`, which asserts that no prompt is seeded", () => {
      expect(parseCellSpec({ systemPromptSha256: null })).toEqual({
        systemPromptSha256: null,
      });
    });

    it("throws for a spec that is not a JSON object", () => {
      expect(() => parseCellSpec(["measurement"])).toThrow(
        "a cell spec must be a JSON object",
      );
    });

    it("throws for a spec whose only field is its label, which checks nothing", () => {
      expect(() => parseCellSpec({ label: "phase 3" })).toThrow(
        "a cell spec asserts nothing",
      );
    });

    it("throws for a field name nothing asserts", () => {
      expect(() => parseCellSpec({ allowedTools: ["shell"] })).toThrow(
        "names fields nothing asserts: allowedTools",
      );
    });

    it("throws for a spec stating a tool set both as a whole and in parts", () => {
      expect(() =>
        parseCellSpec({
          allowedToolIds: ["shell"],
          requiredToolIds: ["run_pattern"],
        })
      ).toThrow("it is one or the other");
    });

    it("throws for a profile named as both required and forbidden", () => {
      expect(() =>
        parseCellSpec({
          requiredSubagentProfiles: ["pattern-author"],
          forbiddenSubagentProfiles: ["pattern-author"],
        })
      ).toThrow(
        "as both requiredSubagentProfiles and forbiddenSubagentProfiles",
      );
    });

    it("throws for a tool list holding something other than strings", () => {
      expect(() => parseCellSpec({ requiredToolIds: [7] })).toThrow(
        "requiredToolIds must be a list of strings",
      );
    });

    it("throws for a prompt digest that is neither a string nor `null`", () => {
      expect(() => parseCellSpec({ systemPromptSha256: false })).toThrow(
        "systemPromptSha256 must be a string or null",
      );
    });

    it("throws for a session store path given as a number", () => {
      expect(() => parseCellSpec({ sessionDbPath: 7 })).toThrow(
        "sessionDbPath must be a string or null",
      );
    });

    it("throws for an empty must-include list, which every console satisfies", () => {
      expect(() => parseCellSpec({ requiredToolIds: [] })).toThrow(
        "requiredToolIds is empty, which every console satisfies",
      );
    });

    it("throws for an empty must-exclude profile list", () => {
      expect(() => parseCellSpec({ forbiddenSubagentProfiles: [] })).toThrow(
        "forbiddenSubagentProfiles is empty",
      );
    });

    it("returns an empty whole set, which asserts that the policy offers nothing", () => {
      expect(parseCellSpec({ allowedToolIds: [] })).toEqual({
        allowedToolIds: [],
      });
    });

    it("throws for an empty space name, which asserts nothing while looking as though it does", () => {
      expect(() => parseCellSpec({ fabricSpace: "  " })).toThrow(
        "fabricSpace must be a non-empty string",
      );
    });
  });

  describe("checkCellSpec()", () => {
    it("returns no mismatch for a spec every field of which the console satisfies", () => {
      expect(
        checkCellSpec({
          fabricSpace: "measurement",
          artifactRoot: "/console/runs",
          sessionDbPath: "/console/sessions.sqlite",
          systemPromptSha256: POLICY.systemPromptSha256,
          requiredToolIds: ["run_pattern", "search_patterns"],
          forbiddenToolIds: ["web_search"],
          allowedSubagentProfiles: ["pattern-author", "default"],
        }, POLICY),
      ).toEqual([]);
    });

    it("returns no mismatch for an exact set given in another order", () => {
      expect(
        checkCellSpec({
          allowedToolIds: ["search_patterns", "shell", "run_pattern"],
        }, POLICY),
      ).toEqual([]);
    });

    it("returns a mismatch naming the whole set on either side for an exact set the console does not hold", () => {
      expect(checkCellSpec({ allowedToolIds: ["run_pattern"] }, POLICY))
        .toEqual([{
          field: "allowedToolIds",
          expected: "run_pattern",
          actual: "run_pattern, search_patterns, shell",
        }]);
    });

    it("returns a mismatch naming only the missing ids for a must-include list", () => {
      expect(checkCellSpec({ requiredToolIds: ["record_feedback"] }, POLICY))
        .toEqual([{
          field: "allowedToolIds (must include)",
          expected: "at least record_feedback",
          actual: "run_pattern, search_patterns, shell",
        }]);
    });

    it("returns a mismatch naming only the offered ids for a must-exclude list", () => {
      expect(
        checkCellSpec({ forbiddenToolIds: ["shell", "web_search"] }, POLICY),
      ).toEqual([{
        field: "allowedToolIds (must exclude)",
        expected: "none of shell",
        actual: "run_pattern, search_patterns, shell",
      }]);
    });

    it("returns a mismatch for a policy offering tools where the spec names an empty whole set", () => {
      expect(checkCellSpec({ allowedToolIds: [] }, POLICY)).toEqual([{
        field: "allowedToolIds",
        expected: "(none)",
        actual: "run_pattern, search_patterns, shell",
      }]);
    });

    it("returns a mismatch for a console seeding a prompt where the spec expects none", () => {
      expect(checkCellSpec({ systemPromptSha256: null }, POLICY)).toEqual([{
        field: "systemPromptSha256",
        expected: "(none)",
        actual: POLICY.systemPromptSha256,
      }]);
    });

    it("returns a mismatch for a console holding no session store where the spec names one", () => {
      expect(
        checkCellSpec({ sessionDbPath: "/console/sessions.sqlite" }, {
          ...POLICY,
          sessionDbPath: null,
        }),
      ).toEqual([{
        field: "sessionDbPath",
        expected: "/console/sessions.sqlite",
        actual: "(none)",
      }]);
    });

    it("returns one mismatch per disagreeing field", () => {
      expect(
        checkCellSpec({
          fabricSpace: "somewhere-else",
          artifactRoot: "/elsewhere/runs",
        }, POLICY).map((mismatch) => mismatch.field),
      ).toEqual(["fabricSpace", "artifactRoot"]);
    });
  });

  describe("describeCellSpecMismatches()", () => {
    it("returns one clause per mismatch, each naming expected against actual", () => {
      expect(
        describeCellSpecMismatches(
          checkCellSpec({ fabricSpace: "somewhere-else" }, POLICY),
        ),
      ).toBe(
        "fabricSpace: expected somewhere-else; this console reports measurement",
      );
    });
  });
});
