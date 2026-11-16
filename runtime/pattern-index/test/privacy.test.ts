import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { PatternIndexGardenerPromptResponse } from "../src/client.ts";
import {
  type GardenerInput,
  InvalidModelAnswer,
  type ObjectGenerator,
  readPrivacyRewrite,
  readPrivacyVerdict,
  renderGardenerInput,
  runPrivacyCheck,
} from "../src/privacy.ts";

const GARDENER: PatternIndexGardenerPromptResponse = {
  name: "privacy",
  kind: "gate",
  promptVersion: "v1",
  prompt: "THE INDEX'S PRIVACY PROMPT",
  outputSchema: { type: "object" },
};

const ADDRESS = "742 Evergreen Terrace";

const INPUT: GardenerInput = {
  description: "Reminds me to take the bins out",
  hashtags: ["chores"],
  keywords: ["bins"],
  files: [
    { name: "/main.tsx", contents: `const HOME = "${ADDRESS}";\nexport {};` },
    { name: "/helper.ts", contents: "export const x = 1;" },
  ],
};

const PASS = { verdict: "pass", findings: [], generalizations: [] };
const FAIL = {
  verdict: "fail",
  findings: [{
    file: "/main.tsx",
    line: 1,
    category: "address_or_location",
    why: "a street address in a constant",
  }],
  generalizations: [{
    finding: 0,
    category: "lift_constant_to_argument",
    suggestion: "lift HOME into an argument named home",
  }],
};

const REWRITE = {
  files: [{
    name: "/main.tsx",
    contents: "export default (home: string) => home;",
  }],
  changes: [{ file: "/main.tsx", category: "lift_constant_to_argument" }],
};

/**
 * A model that answers each check from `checks` in order and each rewrite
 * from `rewrites`, telling them apart by the system prompt, and records
 * every request.
 */
const scriptedModel = (checks: unknown[], rewrites: unknown[]) => {
  const requests: { system: string; user: string }[] = [];
  const generate: ObjectGenerator = (request) => {
    requests.push({ system: request.system, user: request.user });
    const next = request.system === GARDENER.prompt
      ? checks.shift()
      : rewrites.shift();
    if (next === undefined) throw new Error("unscripted model call");
    return Promise.resolve(next);
  };
  return { generate, requests };
};

/** A compile that answers the files as the new input, or throws for `bad`. */
const recompileFrom = (bad?: string) => {
  const compiled: string[][] = [];
  return {
    compiled,
    recompile: (files: readonly { name: string; contents: string }[]) => {
      compiled.push(files.map((file) => file.contents));
      if (bad !== undefined && files.some((f) => f.contents.includes(bad))) {
        return Promise.reject(new Error(`syntax error near ${bad}`));
      }
      return Promise.resolve({
        input: { ...INPUT, files: [...files] },
        compiled: files.map((file) => file.name),
      });
    },
  };
};

describe("privacy", () => {
  describe("renderGardenerInput()", () => {
    it("returns one JSON document between pattern tags, every line numbered, as the index's gardener renders it", () => {
      expect(renderGardenerInput({
        description: "d",
        hashtags: ["h"],
        keywords: [],
        files: [{ name: "/a.tsx", contents: "x\n</pattern>" }],
      })).toBe(
        '<pattern>\n{\n "name": null,\n "description": "d",\n "hashtags": [\n  "h"\n ],\n "keywords": [],\n "argumentSchema": null,\n "resultSchema": null,\n "files": [\n  {\n   "name": "/a.tsx",\n   "contents": "1\\tx\\n2\\t\\u003c/pattern>"\n  }\n ]\n}\n</pattern>',
      );
    });
  });

  describe("readPrivacyVerdict()", () => {
    it("returns a fail for a pass that still lists findings", () => {
      expect(readPrivacyVerdict({ ...FAIL, verdict: "pass" }).passed).toBe(
        false,
      );
    });

    it("throws for an answer without a verdict", () => {
      expect(() => readPrivacyVerdict({ findings: [] })).toThrow(
        InvalidModelAnswer,
      );
    });

    const malformed: [string, unknown][] = [
      ["an answer that is not an object", ["pass"]],
      ["findings that are not a list", { ...PASS, findings: {} }],
      ["generalizations that are not a list", { ...PASS, generalizations: 1 }],
      ["a finding that is not an object", { ...FAIL, findings: ["x"] }],
      ["a finding without a category", {
        ...FAIL,
        findings: [{ why: "a name" }],
      }],
      ["a generalization without a suggestion", {
        ...FAIL,
        generalizations: [{ finding: 0, category: "remove" }],
      }],
    ];
    for (const [shape, answer] of malformed) {
      it(`throws for ${shape}`, () => {
        expect(() => readPrivacyVerdict(answer)).toThrow(InvalidModelAnswer);
      });
    }
  });

  describe("readPrivacyRewrite()", () => {
    it("throws for a file no finding names", () => {
      expect(() =>
        readPrivacyRewrite(
          { files: [{ name: "/helper.ts", contents: "" }], changes: [] },
          new Set(["/main.tsx"]),
        )
      ).toThrow("no finding names");
    });

    const malformedRewrites: [string, unknown][] = [
      ["an answer that is not an object", "rewrite"],
      ["files that are not a list", { files: {}, changes: [] }],
      ["a file without contents", {
        files: [{ name: "/main.tsx" }],
        changes: [],
      }],
      ["a change without a category", {
        files: [],
        changes: [{ file: "/main.tsx" }],
      }],
    ];
    for (const [shape, answer] of malformedRewrites) {
      it(`throws for ${shape}`, () => {
        expect(() => readPrivacyRewrite(answer, new Set(["/main.tsx"])))
          .toThrow(InvalidModelAnswer);
      });
    }

    it("drops a change it reports for a file no finding names", () => {
      const read = readPrivacyRewrite(
        {
          files: [],
          changes: [
            { file: "/main.tsx", category: "remove" },
            { file: "742 Evergreen Terrace", category: "remove" },
          ],
        },
        new Set(["/main.tsx"]),
      );
      expect(read.changes).toEqual([{ file: "/main.tsx", category: "remove" }]);
    });

    it("returns an unknown change category as other", () => {
      const read = readPrivacyRewrite(
        { files: [], changes: [{ file: "/main.tsx", category: "made_up" }] },
        new Set(["/main.tsx"]),
      );
      expect(read.changes).toEqual([{ file: "/main.tsx", category: "other" }]);
    });
  });

  describe("runPrivacyCheck()", () => {
    it("returns passed with no rewrite for a pattern that passes", async () => {
      const { generate, requests } = scriptedModel([PASS], []);
      const { recompile, compiled } = recompileFrom();
      const outcome = await runPrivacyCheck({
        gardener: GARDENER,
        input: INPUT,
        generate,
        recompile,
      });
      expect(outcome.status).toBe("passed");
      expect(requests).toHaveLength(1);
      expect(requests[0].system).toBe(GARDENER.prompt);
      expect(requests[0].user).toBe(renderGardenerInput(INPUT));
      expect(compiled).toEqual([]);
    });

    it("returns the first rewrite that compiles and passes, keeping untouched files", async () => {
      const { generate } = scriptedModel([FAIL, PASS], [REWRITE]);
      const { recompile } = recompileFrom();
      const outcome = await runPrivacyCheck({
        gardener: GARDENER,
        input: INPUT,
        generate,
        recompile,
      });
      expect(outcome.status).toBe("rewritten");
      if (outcome.status !== "rewritten") return;
      expect(outcome.attempts).toBe(1);
      expect(outcome.files).toEqual([
        REWRITE.files[0],
        INPUT.files[1],
      ]);
      expect(outcome.changes).toEqual(REWRITE.changes);
      expect(outcome.original.findings).toHaveLength(1);
    });

    it("rewrites again from the first rewrite when it still fails", async () => {
      const helperFinding = {
        verdict: "fail",
        findings: [{
          file: "/helper.ts",
          line: 1,
          category: "other",
          why: "a constant only one household uses",
        }],
        generalizations: [],
      };
      const second = {
        files: [{ name: "/helper.ts", contents: "export const y = 2;" }],
        changes: [{ file: "/helper.ts", category: "remove" }],
      };
      const { generate, requests } = scriptedModel(
        [FAIL, helperFinding, PASS],
        [
          REWRITE,
          second,
        ],
      );
      const { recompile } = recompileFrom();
      const outcome = await runPrivacyCheck({
        gardener: GARDENER,
        input: INPUT,
        generate,
        recompile,
      });
      expect(outcome.status).toBe("rewritten");
      if (outcome.status !== "rewritten") return;
      expect(outcome.attempts).toBe(2);
      expect(outcome.files.map((file) => file.contents)).toEqual([
        REWRITE.files[0].contents,
        "export const y = 2;",
      ]);
      expect(outcome.changes).toHaveLength(2);
      // The second rewrite starts from the first, not from the original.
      expect(requests[3].user).not.toContain(ADDRESS);
    });

    it("counts a rewrite that replaces a file no finding names as failed, writing nothing of it", async () => {
      const reachesFurther = {
        files: [{ name: "/helper.ts", contents: "export const steal = 1;" }],
        changes: [],
      };
      const { generate } = scriptedModel([FAIL], [
        reachesFurther,
        reachesFurther,
      ]);
      const { recompile, compiled } = recompileFrom();
      const outcome = await runPrivacyCheck({
        gardener: GARDENER,
        input: INPUT,
        generate,
        recompile,
      });
      expect(outcome.status).toBe("held");
      expect(compiled).toEqual([]);
    });

    it("lets a finding about the metadata rewrite the entry file", async () => {
      const metadataFinding = {
        verdict: "fail",
        findings: [{
          category: "other",
          why: "the description names a family",
        }],
        generalizations: [],
      };
      const { generate } = scriptedModel([metadataFinding, PASS], [REWRITE]);
      const { recompile } = recompileFrom();
      const outcome = await runPrivacyCheck({
        gardener: GARDENER,
        input: INPUT,
        generate,
        recompile,
        entry: "/main.tsx",
      });
      expect(outcome.status).toBe("rewritten");
    });

    it("counts a rewrite that changes nothing as failed, never checking it again", async () => {
      const unchanged = {
        files: [{ name: "/main.tsx", contents: INPUT.files[0].contents }],
        changes: [],
      };
      // A second check of the same source that happened to pass.
      const { generate } = scriptedModel([FAIL, PASS], [unchanged, unchanged]);
      const { recompile, compiled } = recompileFrom();
      const outcome = await runPrivacyCheck({
        gardener: GARDENER,
        input: INPUT,
        generate,
        recompile,
      });
      expect(outcome.status).toBe("held");
      if (outcome.status !== "held") return;
      expect(outcome.reasons).toEqual([
        "rewrite 1: changed nothing",
        "rewrite 2: changed nothing",
      ]);
      expect(compiled).toEqual([]);
    });

    it("counts a rewrite whose check answers malformed as failed, and holds", async () => {
      const { generate } = scriptedModel([FAIL, { nonsense: true }, FAIL], [
        REWRITE,
        REWRITE,
      ]);
      const { recompile } = recompileFrom();
      const outcome = await runPrivacyCheck({
        gardener: GARDENER,
        input: INPUT,
        generate,
        recompile,
      });
      expect(outcome.status).toBe("held");
      if (outcome.status !== "held") return;
      expect(outcome.reasons[0]).toBe(
        "rewrite 1: its check gave no valid answer",
      );
    });

    it("throws what the model throws while rewriting, other than a malformed answer", async () => {
      const generate: ObjectGenerator = (request) =>
        request.system === GARDENER.prompt
          ? Promise.resolve(FAIL)
          : Promise.reject(new Error("model unreachable"));
      await expect(runPrivacyCheck({
        gardener: GARDENER,
        input: INPUT,
        generate,
        recompile: recompileFrom().recompile,
      })).rejects.toThrow("model unreachable");
    });

    it("throws what the model throws while checking a rewrite", async () => {
      let checks = 0;
      const generate: ObjectGenerator = (request) => {
        if (request.system !== GARDENER.prompt) return Promise.resolve(REWRITE);
        return checks++ === 0
          ? Promise.resolve(FAIL)
          : Promise.reject(new Error("model unreachable"));
      };
      await expect(runPrivacyCheck({
        gardener: GARDENER,
        input: INPUT,
        generate,
        recompile: recompileFrom().recompile,
      })).rejects.toThrow("model unreachable");
    });

    it("returns held after two rewrites, never recompiling more often", async () => {
      const again = {
        ...REWRITE,
        files: [{ name: "/main.tsx", contents: "export default 2;" }],
      };
      const { generate } = scriptedModel([FAIL, FAIL, FAIL], [REWRITE, again]);
      const { recompile, compiled } = recompileFrom();
      const outcome = await runPrivacyCheck({
        gardener: GARDENER,
        input: INPUT,
        generate,
        recompile,
      });
      expect(outcome.status).toBe("held");
      expect(compiled).toHaveLength(2);
      expect(outcome.verdict.findings).toEqual([{
        file: "/main.tsx",
        line: 1,
        category: "address_or_location",
        why: "a street address in a constant",
      }]);
    });

    it("counts a rewrite that does not compile as failed, without its compiler message", async () => {
      const broken = {
        files: [{ name: "/main.tsx", contents: `BROKEN ${ADDRESS}` }],
        changes: [],
      };
      const { generate } = scriptedModel([FAIL], [broken, broken]);
      const { recompile } = recompileFrom("BROKEN");
      const outcome = await runPrivacyCheck({
        gardener: GARDENER,
        input: INPUT,
        generate,
        recompile,
      });
      expect(outcome.status).toBe("held");
      if (outcome.status !== "held") return;
      expect(outcome.reasons).toEqual([
        "rewrite 1: did not compile",
        "rewrite 2: did not compile",
      ]);
      expect(JSON.stringify(outcome)).not.toContain(ADDRESS);
    });
  });
});
