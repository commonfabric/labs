import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { afterEach, describe, it } from "@std/testing/bdd";

import {
  type CfcRefusalDetail,
  reportCfcDenial,
  resetCfcDenialAnnouncements,
} from "@commonfabric/runner/cfc";

import {
  formatCfcDenial,
  printCfcDenials,
  warningsCountCfcDenial,
} from "../lib/cfc-denials.ts";
import { cf } from "./utils.ts";

const SPACE = "did:key:z6Mkdenials";

const SUMMARY = "a policy check refused the commit";

const DETAIL: CfcRefusalDetail = {
  gate: "writer-fit",
  target: { space: SPACE, id: "of:note", scope: "space", path: ["text"] },
  offendingAtoms: ['{"type":"secret"}'],
  inputs: [{
    read: { space: SPACE, id: "of:source", scope: "space", path: [] },
    labelPath: ["body"],
    atoms: ['{"type":"secret"}'],
  }],
  attribution: "complete",
  reason: "secret flows into /text",
};

describe("cfc-denials", () => {
  afterEach(() => resetCfcDenialAnnouncements());

  describe("formatCfcDenial()", () => {
    it("returns a heading, one line per reason, then the other inputs", () => {
      expect(formatCfcDenial({
        code: "write-policy-gate",
        summary: SUMMARY,
        inputs: {
          reasons: ["first reason", "second reason"],
          refusals: [],
          crash: undefined,
          dials: { enforcement: "enforce-strict" },
        },
      })).toEqual([
        `CFC denied (write-policy-gate): ${SUMMARY}`,
        "  - first reason",
        "  - second reason",
        '  dials: {enforcement:"enforce-strict"}',
      ]);
    });

    it("returns each refusal detail beneath the reason it describes", () => {
      expect(formatCfcDenial({
        code: "write-policy-gate",
        summary: SUMMARY,
        inputs: {
          reasons: ["unrelated reason", DETAIL.reason],
          refusals: [DETAIL],
        },
      })).toEqual([
        `CFC denied (write-policy-gate): ${SUMMARY}`,
        "  - unrelated reason",
        "  - secret flows into /text",
        '    writer-fit refused a write to `of:note` at `/text`; offending: {"type":"secret"} (attribution: complete)',
        '      read `of:source` at `/`, label at `/body`: {"type":"secret"}',
      ]);
    });

    it("returns the sink a `sink-ceiling` detail names", () => {
      const detail: CfcRefusalDetail = {
        gate: "sink-ceiling",
        sink: "fetchData",
        offendingAtoms: [],
        inputs: [],
        attribution: "none",
        reason: "over the ceiling",
      };
      expect(
        formatCfcDenial({
          code: "write-policy-gate",
          summary: SUMMARY,
          inputs: { reasons: [detail.reason], refusals: [detail] },
        })[2],
      ).toBe(
        "    sink-ceiling refused a release to sink `fetchData`; offending:  (attribution: none)",
      );
    });

    it("returns every input of a denial that carries no reasons", () => {
      expect(formatCfcDenial({
        code: "render-literal-text-integrity",
        summary: "literal text cannot be endorsed",
        inputs: { prop: "title", textIntegrity: ["reviewed"] },
      })).toEqual([
        "CFC denied (render-literal-text-integrity): literal text cannot be endorsed",
        '  prop: "title"',
        '  textIntegrity: ["reviewed"]',
      ]);
    });
  });

  describe("printCfcDenials()", () => {
    it("prints every denial, repeats included, until stopped", () => {
      const printed: string[] = [];
      const stop = printCfcDenials((line) => printed.push(line));
      const inputs = { reasons: ["a reason"] };
      try {
        reportCfcDenial("write-policy-gate", SUMMARY, () => inputs);
        reportCfcDenial("write-policy-gate", SUMMARY, () => inputs);
      } finally {
        stop();
      }
      reportCfcDenial("write-policy-gate", SUMMARY, () => inputs);
      const once = formatCfcDenial({
        code: "write-policy-gate",
        summary: SUMMARY,
        inputs,
      });
      expect(printed).toEqual([...once, ...once]);
    });
  });

  describe("warningsCountCfcDenial()", () => {
    it("returns `true` for a `cfc` warning counted under a denial's key", () => {
      expect(warningsCountCfcDenial([
        "[console.warn] unrelated",
        "[logger:cfc] 2 warning(s) (key: write-policy-gate)",
      ])).toBe(true);
    });

    it("returns `true` for one behind a participant's prefix", () => {
      expect(warningsCountCfcDenial([
        "[alice] [logger:cfc] 1 warning(s) (key: render-text-integrity)",
      ])).toBe(true);
    });

    it("returns `false` for a `cfc` warning under another key", () => {
      expect(warningsCountCfcDenial([
        "[logger:cfc] 1 warning(s) (key: cfc)",
      ])).toBe(false);
    });

    it("returns `false` for a denial's key on another logger", () => {
      expect(warningsCountCfcDenial([
        "[logger:scheduler] 1 warning(s) (key: write-policy-gate)",
      ])).toBe(false);
    });
  });

  describe("`cf test --cfc-denials`", () => {
    const fixture = resolve(
      import.meta.dirname!,
      "fixtures/cfc-denials/wrong-writer.test.tsx",
    );
    const reason =
      "      - writeAuthorizedBy requires a trusted verified binding identity at /text";

    it("prints a denied commit with its reason", async () => {
      const { code, stdout } = await cf(`test "${fixture}" --cfc-denials`);
      expect(code).toBe(0);
      expect(stdout).toContain(
        `    CFC denied (write-policy-gate): ${SUMMARY}`,
      );
      expect(stdout).toContain(reason);
    });

    it("prints no denial without the flag", async () => {
      const { code, stdout } = await cf(`test "${fixture}"`);
      expect(code).toBe(0);
      expect(stdout.join("\n")).not.toContain("CFC denied (");
    });

    describe("a denial the test does not allow for", () => {
      const setupFixture = resolve(
        import.meta.dirname!,
        "fixtures/cfc-denials/setup-denial.test.tsx",
      );
      const hint =
        "    Run again with `--cfc-denials` to see what CFC denied, and why.";

      it("prints the setup denial's reason with the flag", async () => {
        const { code, stdout } = await cf(
          `test "${setupFixture}" --cfc-denials`,
        );
        expect(code).toBe(1);
        expect(stdout).toContain(
          "      - writeAuthorizedBy requires a trusted verified binding identity at /note",
        );
        expect(stdout).not.toContain(hint);
      });

      it("prints a hint naming the flag without it", async () => {
        const { code, stdout } = await cf(`test "${setupFixture}"`);
        expect(code).toBe(1);
        expect(stdout).toContain(hint);
        expect(stdout.join("\n")).not.toContain("CFC denied (");
      });
    });

    it("fails each of two files denied the same way", async () => {
      const repeated = resolve(
        import.meta.dirname!,
        "fixtures/cfc-denials/repeated",
      );
      const { code, stdout } = await cf(`test "${repeated}"`);
      expect(code).toBe(1);
      expect(
        stdout.filter((line) =>
          line === "  ✗ 1 console warning(s) during test:"
        ),
      ).toHaveLength(2);
    });

    describe("a multi-user participant's denial", () => {
      const multiUserFixture = resolve(
        import.meta.dirname!,
        "fixtures/cfc-denials/multi-user-setup-denial.test.tsx",
      );

      it("prints the denial behind the participant's name with the flag", async () => {
        const { code, stdout } = await cf(
          `test "${multiUserFixture}" --cfc-denials`,
        );
        expect(code).toBe(1);
        expect(stdout).toContain(
          `    [alice] CFC denied (write-policy-gate): ${SUMMARY}`,
        );
        expect(stdout).toContain(
          "    [alice]   - writeAuthorizedBy requires a trusted verified binding identity at /note",
        );
      });

      it("prints a hint naming the flag without it", async () => {
        const { code, stdout } = await cf(`test "${multiUserFixture}"`);
        expect(code).toBe(1);
        expect(stdout).toContain(
          "    Run again with `--cfc-denials` to see what CFC denied, and why.",
        );
      });
    });
  });
});
