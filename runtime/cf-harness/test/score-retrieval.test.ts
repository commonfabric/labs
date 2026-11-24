/**
 * Exercises the retrieval scoring command against file and HTTP boundaries.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import { Identity } from "@commonfabric/identity";
import { main } from "../scripts/score-retrieval.ts";

const readEnv = (
  values: Readonly<Record<string, string | undefined>>,
): (name: string) => string | undefined => {
  return (name) => values[name];
};

const searchResult = (patternId: string) => ({
  patternId,
  description: `${patternId} description`,
  hashtags: [patternId],
  ownerDid: "did:key:zOwner",
  createdAt: "2026-08-01T00:00:00.000Z",
  dependencies: [],
  matchedTerms: 1,
  queryTerms: 1,
  signals: { uses: 1, score: 1 },
});

const startFakeIndex = (
  resultsByText: Readonly<Record<string, readonly string[]>>,
) => {
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    async (request) => {
      const functionName = new URL(request.url).pathname.split("/").at(-1);
      if (functionName === "listPatterns") {
        return Response.json({
          patterns: [
            {
              patternId: "good",
              description: "Sortable table columns",
              hashtags: ["table"],
              keywords: ["sort"],
              ownerDid: "did:key:zOwner",
              createdAt: "2026-08-01T00:00:00.000Z",
              events: { run_succeeded: 1 },
              score: 1,
            },
            {
              patternId: "noise",
              description: "Unrelated result",
              hashtags: ["noise"],
              keywords: ["other"],
              ownerDid: "did:key:zOwner",
              createdAt: "2026-08-01T00:00:00.000Z",
              events: {},
              score: 0,
            },
          ],
          eventTypes: { run_succeeded: 1 },
        });
      }
      if (functionName === "searchPatterns") {
        const body = await request.json() as { text?: string };
        return Response.json({
          results: (resultsByText[body.text ?? ""] ?? []).map(searchResult),
        });
      }
      if (functionName === "getPattern") {
        const body = await request.json() as { patternId: string };
        if (body.patternId === "good" || body.patternId === "noise") {
          return Response.json(searchResult(body.patternId));
        }
      }
      return new Response("not found", { status: 404 });
    },
  );
  return {
    url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    close: () => server.shutdown(),
  };
};

const createFixture = async (set: unknown) => {
  const dir = await Deno.makeTempDir({ prefix: "score-retrieval-test-" });
  const queryPath = join(dir, "queries.json");
  const identityPath = join(dir, "identity.pkcs8");
  await Deno.writeTextFile(queryPath, JSON.stringify(set));
  await Deno.writeFile(identityPath, await Identity.generatePkcs8());
  return {
    dir,
    identityPath,
    queryPath,
    close: () => Deno.remove(dir, { recursive: true }),
  };
};

const QUERY_SET = {
  capabilities: [{
    id: "table",
    need: "a sortable table",
    answers: ["good"],
    partial: [],
    evidence: "read from source",
  }],
  queries: [{
    id: "table.task",
    capability: "table",
    register: "task",
    text: "sortable table columns",
  }],
  negativeQueries: [{
    id: "negative.noise",
    kind: "absent",
    text: "nothing should answer",
    why: "the corpus has no answer",
  }],
  unlabelledObservedQueries: [{
    id: "observed.other",
    text: "observed wording",
    why: "kept outside the score",
  }],
};

describe("score-retrieval", () => {
  describe("main()", () => {
    it("writes the measured report and returns 1 when both thresholds are breached", async () => {
      const index = startFakeIndex({
        "sortable table columns": ["good"],
        "nothing should answer": ["noise"],
        "observed wording": [],
      });
      const fixture = await createFixture(QUERY_SET);
      try {
        const logs: string[] = [];
        const errors: string[] = [];
        const outPath = join(fixture.dir, "report.json");
        const code = await main(
          [
            `--queries=${fixture.queryPath}`,
            `--out=${outPath}`,
            "--min-hit-at-5=1.1",
            "--max-dirty-negatives=0",
          ],
          readEnv({
            CF_IDENTITY: fixture.identityPath,
            PATTERN_INDEX_BASE_URL: index.url,
          }),
          (line) => logs.push(line),
          (line) => errors.push(line),
          () => new Date("2026-08-31T00:00:00.000Z"),
        );

        expect(code).toBe(1);
        expect(errors).toEqual([
          "FAIL: hit@5 1.000 below --min-hit-at-5=1.1",
          "FAIL: 1 negative queries returned results, above --max-dirty-negatives=0",
        ]);
        const report = JSON.parse(await Deno.readTextFile(outPath));
        expect(report.corpus).toEqual({
          readAt: "2026-08-31T00:00:00.000Z",
          discoverableEntries: 2,
          eventTypes: { run_succeeded: 1 },
          note:
            "listPatterns returns discoverable entries only; hidden entries are not counted here.",
        });
        expect(report.overall).toMatchObject({ queries: 1, hitAt5: 1 });
        expect(report.negativeScores[0].returned).toBe(1);
        expect(report.diagnostics).toHaveLength(3);
        expect(JSON.parse(logs.join("\n"))).toMatchObject({
          hitRateAt5: 1,
          dirtyNegatives: 1,
          failures: 1,
        });
      } finally {
        try {
          await index.close();
        } finally {
          await fixture.close();
        }
      }
    });

    it("returns 0 and reports a zero hit rate for an empty scored query set", async () => {
      const index = startFakeIndex({});
      const fixture = await createFixture({
        capabilities: [],
        queries: [],
        negativeQueries: [],
        unlabelledObservedQueries: [],
      });
      try {
        const logs: string[] = [];
        const code = await main(
          [`--queries=${fixture.queryPath}`],
          readEnv({
            CF_IDENTITY: fixture.identityPath,
            PATTERN_INDEX_BASE_URL: index.url,
          }),
          (line) => logs.push(line),
        );

        expect(code).toBe(0);
        expect(JSON.parse(logs.join("\n"))).toMatchObject({
          hitRateAt5: 0,
          dirtyNegatives: 0,
          failures: 0,
        });
      } finally {
        try {
          await index.close();
        } finally {
          await fixture.close();
        }
      }
    });

    it("returns a usage error naming each nonnumeric quality threshold", async () => {
      for (
        const name of ["min-hit-at-5", "max-dirty-negatives"] as const
      ) {
        const errors: string[] = [];
        const code = await main(
          [`--${name}=not-a-number`],
          readEnv({}),
          () => {},
          (line) => errors.push(line),
        );

        expect(code).toBe(2);
        expect(errors).toEqual([
          `--${name} must be a finite number: not-a-number`,
        ]);
      }
    });

    it("throws before contacting the index when `CF_IDENTITY` is absent", async () => {
      const fixture = await createFixture(QUERY_SET);
      try {
        await expect(
          main(
            [`--queries=${fixture.queryPath}`],
            readEnv({ PATTERN_INDEX_BASE_URL: "https://index.test" }),
          ),
        ).rejects.toThrow("CF_IDENTITY must be set");
      } finally {
        await fixture.close();
      }
    });
  });
});
