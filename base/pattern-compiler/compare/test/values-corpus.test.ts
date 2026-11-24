import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { Artifact } from "../../exec/executor.ts";
import { type ModuleValues, replayed } from "../values-corpus.ts";

const artifactOf = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(`../fixtures/${name}.emit.json`, import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((pattern) => pattern.name === "default") ??
    patterns[patterns.length - 1];
};

/**
 * The line of a run of `fixtures/effects.tsx` in which today's runtime
 * read `status` after its request had completed.
 */
const earlier = (
  stubs?: { stubbed: boolean; now: number },
): ModuleValues & { runtime: NonNullable<ModuleValues["runtime"]> } => ({
  module: "compare/fixtures/effects.tsx",
  pattern: "default",
  runtime: {
    argument: { note: "n" },
    events: [],
    outcomes: [],
    values: {
      events: [],
      settled: { result: { status: "settled" }, state: {} },
    },
    ...(stubs === undefined ? {} : { stubs }),
  },
});

describe("values-corpus", () => {
  describe("replayed()", () => {
    it("answers the requests of a line that was run with stubs from the table of the stubs", async () => {
      const line = await replayed(
        earlier({ stubbed: true, now: 1 }),
        await artifactOf("effects"),
      );

      expect(line.comparison?.requests?.fetchJson).toBeGreaterThan(0);
      expect(line.comparison?.outstanding).toBe(0);
      expect(
        line.comparison?.differences.filter(({ value }) =>
          value === "result/status"
        ),
      ).toEqual([]);
    });

    it("answers no request of a line that was run without stubs", async () => {
      const line = await replayed(earlier(), await artifactOf("effects"));

      expect(line.comparison?.requests).toBeUndefined();
      expect(
        line.comparison?.differences.filter(({ value }) =>
          value === "result/status"
        ),
      ).toEqual([{
        point: "settled",
        value: "result/status",
        path: "",
        runtime: '"settled"',
        executor: '"pending"',
      }]);
    });

    // `started` of `fixtures/wishes.tsx` holds what the clock held when
    // the wish was made, and today's runtime read its own clock a little
    // later.
    for (const stubbed of [true, false]) {
      it(
        `compares a time that the executor read from the clock of the earlier run as a time, for a run ${
          stubbed ? "with" : "without"
        } the table of the stubs`,
        async () => {
          const now = Date.UTC(2020, 0, 1);
          const line = await replayed(
            {
              ...earlier(),
              runtime: {
                ...earlier({ stubbed, now }).runtime,
                values: {
                  events: [],
                  settled: { result: { started: now + 5 }, state: {} },
                },
              },
            },
            await artifactOf("wishes"),
          );

          expect(
            line.comparison?.differences.filter(({ value }) =>
              value === "result/started"
            ),
          ).toEqual([]);
        },
      );
    }
  });
});
