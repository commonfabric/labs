/**
 * The task pattern-reference seams: the id grammar, resolving an id against
 * the index into the record a run seeds as a searched hit, and the
 * announcement text — which reports what a pattern is for and how to name it,
 * and never its source.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { PatternIndexClient } from "@commonfabric/pattern-index/client";
import { Identity } from "@commonfabric/identity";

import type { HarnessFetch } from "../src/contracts/http-fetch.ts";
import {
  checkPatternRefSpec,
  MAX_HARNESS_PATTERN_REFS,
  patternRefsContextMessage,
  resolvePatternRefs,
} from "../src/pattern-refs.ts";

const signer = await Identity.fromPassphrase("cf-harness task pattern refs");

const PATTERN_RECORD = {
  patternId: "pat-expenses",
  ownerDid: "did:key:zOwner",
  createdAt: "2026-08-01T00:00:00.000Z",
  description: "Totals an expense list",
  hashtags: ["expenses", "money"],
  dependencies: [],
  argumentSchema: {
    type: "object",
    properties: { amounts: { type: "array", items: { type: "number" } } },
    required: ["amounts"],
  },
  resultSchema: {
    type: "object",
    properties: { total: { type: "number" } },
    required: ["total"],
  },
  program: { main: "/main.tsx", files: [] },
};

/** An index answering `getPattern` for one id and 404 for every other. */
const stubIndex = (): { client: PatternIndexClient; calls: string[] } => {
  const calls: string[] = [];
  const fetchFn: HarnessFetch = async (input, init) => {
    calls.push(String(input).split("/").pop() ?? "");
    const body = JSON.parse(String(init?.body)) as { patternId?: string };
    return await Promise.resolve(
      body.patternId === PATTERN_RECORD.patternId
        ? new Response(JSON.stringify(PATTERN_RECORD), { status: 200 })
        : new Response(JSON.stringify({ error: "no such pattern" }), {
          status: 404,
        }),
    );
  };
  return {
    client: new PatternIndexClient({
      baseUrl: "https://index.test",
      fetchFn,
      signer,
    }),
    calls,
  };
};

/** An index holding every well-formed id, for counting rather than matching. */
const answeringIndex = (): { client: PatternIndexClient; calls: string[] } => {
  const calls: string[] = [];
  const fetchFn: HarnessFetch = (input, init) => {
    calls.push(String(input).split("/").pop() ?? "");
    const body = JSON.parse(String(init?.body)) as { patternId?: string };
    return Promise.resolve(
      new Response(
        JSON.stringify({ ...PATTERN_RECORD, patternId: body.patternId }),
        { status: 200 },
      ),
    );
  };
  return {
    client: new PatternIndexClient({
      baseUrl: "https://index.test",
      fetchFn,
      signer,
    }),
    calls,
  };
};

describe("pattern-refs", () => {
  describe("checkPatternRefSpec()", () => {
    it("returns for an id in the index's own grammar", () => {
      expect(checkPatternRefSpec({ patternId: "pat_Expenses-1" }))
        .toBeUndefined();
    });

    it("throws for a value carrying characters an id cannot", () => {
      expect(() => checkPatternRefSpec({ patternId: "for a dice roller" }))
        .toThrow("patternId must match");
    });

    it("throws for an empty value", () => {
      expect(() => checkPatternRefSpec({ patternId: "" })).toThrow(
        "patternId must match",
      );
    });
  });

  describe("resolvePatternRefs()", () => {
    it("returns the index's record for an id it holds, with the specifier that composes it", async () => {
      const index = stubIndex();

      const refs = await resolvePatternRefs(index.client, [
        { patternId: "pat-expenses" },
      ]);

      expect(refs).toEqual([{
        patternId: "pat-expenses",
        record: {
          patternId: "pat-expenses",
          description: "Totals an expense list",
          hashtags: ["expenses", "money"],
          importHint: 'import X from "cf:pattern:pat-expenses"',
          ownerDid: "did:key:zOwner",
          createdAt: "2026-08-01T00:00:00.000Z",
          argumentType: "{\n  amounts: number[]\n}",
          resultType: "{\n  total: number\n}",
        },
      }]);
      expect(index.calls).toEqual(["getPattern"]);
    });

    it("throws naming the id the index does not hold", async () => {
      const index = stubIndex();

      await expect(
        resolvePatternRefs(index.client, [{ patternId: "pat-nothing" }]),
      ).rejects.toThrow("`pat-nothing` is not in the pattern index");
    });

    it("throws naming an id given twice", async () => {
      const index = stubIndex();

      await expect(
        resolvePatternRefs(index.client, [
          { patternId: "pat-expenses" },
          { patternId: "pat-expenses" },
        ]),
      ).rejects.toThrow("names `pat-expenses` twice");
    });

    it("throws stating the bound, before any read, for more references than a task may attach", async () => {
      // The bound is held here and not only at the surface a caller wrote to,
      // so a library caller reaching this resolution meets the same refusal.
      const index = stubIndex();

      await expect(
        resolvePatternRefs(
          index.client,
          Array.from(
            { length: MAX_HARNESS_PATTERN_REFS + 1 },
            (_unused, position) => ({ patternId: `pat-${position}` }),
          ),
        ),
      ).rejects.toThrow(
        `takes at most ${MAX_HARNESS_PATTERN_REFS} references, got ${
          MAX_HARNESS_PATTERN_REFS + 1
        }`,
      );
      expect(index.calls).toEqual([]);
    });

    it("resolves as many references as the bound allows", async () => {
      // The refusal above is one reference over the bound, so this states
      // where the bound actually falls rather than leaving it either side.
      const index = answeringIndex();

      const refs = await resolvePatternRefs(
        index.client,
        Array.from(
          { length: MAX_HARNESS_PATTERN_REFS },
          (_unused, position) => ({ patternId: `pat-${position}` }),
        ),
      );

      expect(refs.map((ref) => ref.patternId)).toEqual(
        Array.from(
          { length: MAX_HARNESS_PATTERN_REFS },
          (_unused, position) => `pat-${position}`,
        ),
      );
    });

    it("throws before any read for a value that is not an id", async () => {
      const index = stubIndex();

      await expect(
        resolvePatternRefs(index.client, [{ patternId: "pat expenses" }]),
      ).rejects.toThrow("patternId must match");
      expect(index.calls).toEqual([]);
    });
  });

  describe("patternRefsContextMessage()", () => {
    it("returns `undefined` for no references at all", () => {
      expect(patternRefsContextMessage([])).toBeUndefined();
    });

    it("reports each pattern's description, specifier, and declared shapes", async () => {
      const index = stubIndex();
      const refs = await resolvePatternRefs(index.client, [
        { patternId: "pat-expenses" },
      ]);

      const message = patternRefsContextMessage(refs)!;

      expect(message).toContain("Pattern 1: pat-expenses");
      expect(message).toContain("Totals an expense list");
      expect(message).toContain('import X from "cf:pattern:pat-expenses"');
      expect(message).toContain("amounts: number[]");
      expect(message).toContain("total: number");
      // An attachment says which published source, not that it is any good.
      expect(message).toContain("nothing about whether it works");
    });
  });
});
