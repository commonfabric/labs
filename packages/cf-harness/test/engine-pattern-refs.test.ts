/**
 * The engine's task pattern references: what `establishPatternRefs()` writes
 * into run state, what a second call answers from that record, and the
 * configurations it refuses before anything is recorded.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { PatternIndexClient } from "@commonfabric/pattern-index/client";
import { Identity } from "@commonfabric/identity";

import { CfHarnessEngine } from "../src/engine.ts";
import type { HarnessFetch } from "../src/contracts/http-fetch.ts";

const signer = await Identity.fromPassphrase(
  "cf-harness engine pattern refs",
);

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

/** An index answering `getPattern` for one id, counting every read it took. */
const stubIndex = (): { client: PatternIndexClient; calls: string[] } => {
  const calls: string[] = [];
  const fetchFn: HarnessFetch = (input, init) => {
    calls.push(String(input).split("/").pop() ?? "");
    const body = JSON.parse(String(init?.body)) as { patternId?: string };
    return Promise.resolve(
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

describe("engine-pattern-refs", () => {
  describe("establishPatternRefs()", () => {
    it("records the index's record for each attached id in run state", async () => {
      const index = stubIndex();
      const engine = new CfHarnessEngine({
        workspaceHostPath: "/host/project",
        patternRefs: [{ patternId: "pat-expenses" }],
        patternIndexClientFactory: () => Promise.resolve(index.client),
      });

      const refs = await engine.establishPatternRefs();

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
      expect(engine.getRunState().patternRefs).toEqual(refs);
    });

    it("returns the recorded references on a second call without reading the index again", async () => {
      const index = stubIndex();
      const engine = new CfHarnessEngine({
        workspaceHostPath: "/host/project",
        patternRefs: [{ patternId: "pat-expenses" }],
        patternIndexClientFactory: () => Promise.resolve(index.client),
      });

      const established = await engine.establishPatternRefs();
      const again = await engine.establishPatternRefs();

      expect(again).toEqual(established);
      expect(index.calls).toEqual(["getPattern"]);
    });

    it("returns no references for a run that attached none, leaving run state without a record", async () => {
      const index = stubIndex();
      const engine = new CfHarnessEngine({
        workspaceHostPath: "/host/project",
        patternIndexClientFactory: () => Promise.resolve(index.client),
      });

      expect(await engine.establishPatternRefs()).toEqual([]);
      expect(engine.getRunState().patternRefs).toBeUndefined();
      expect(index.calls).toEqual([]);
    });

    it("throws naming the index a run configured with references and none has to have, recording nothing", async () => {
      const engine = new CfHarnessEngine({
        workspaceHostPath: "/host/project",
        patternRefs: [{ patternId: "pat-expenses" }],
      });

      await expect(engine.establishPatternRefs()).rejects.toThrow(
        "patternRefs requires a pattern index",
      );
      expect(engine.getRunState().patternRefs).toBeUndefined();
    });

    it("throws naming an attached id the index does not hold, recording nothing", async () => {
      const index = stubIndex();
      const engine = new CfHarnessEngine({
        workspaceHostPath: "/host/project",
        patternRefs: [{ patternId: "pat-nothing" }],
        patternIndexClientFactory: () => Promise.resolve(index.client),
      });

      await expect(engine.establishPatternRefs()).rejects.toThrow(
        "`pat-nothing` is not in the pattern index",
      );
      expect(engine.getRunState().patternRefs).toBeUndefined();
    });
  });
});
