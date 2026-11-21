import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../exec/executor.ts";
import { type Plan, runScenario } from "../harness.ts";
import { instanceOptions, inStorage } from "../integrated.ts";
import {
  checkWrites,
  type LabelPlan,
  type OracleCheck,
  storedLabelAt,
} from "../stored-labels.ts";
import { ExecutorRun, readingValues } from "../values.ts";
import {
  type Home,
  homeStubs,
  memoryHome,
  PROFILE,
  simulatedOutcome,
  withHome,
} from "../wish-home.ts";

// The home that a `wish` of a compared pattern resolves in, on
// `fixtures/wish-home.tsx`, which has no per-element construct: today's
// runtime resolves its own `wish` against the seeded documents, and the
// executor is answered from a table with the same outcomes.

/** The outputs of the fixture whose stored labels the tests read. */
const OUTPUTS = [
  "greeting",
  "about",
  "note",
  "profile",
  "count",
  "matches",
  "mentionable",
  "registry",
  "missing",
  "quiet",
  "problem",
];

const fixture = (name: string) =>
  new URL(`../fixtures/${name}`, import.meta.url);

const artifactOf = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(fixture(`${name}.emit.json`)),
  ) as { patterns: Artifact[] }[];
  return patterns.find((pattern) => pattern.name === "default") ??
    patterns[patterns.length - 1];
};

/** Runs the fixture on both sides, and returns the values and their comparison. */
const compared = async () => {
  const artifact = await artifactOf("wish-home");
  const plan = artifact.plan as unknown as Plan;
  const argument = { note: "n" };
  const { probe, values } = readingValues(plan);
  const stubs = homeStubs(await memoryHome());
  const executor = new ExecutorRun(artifact, argument, undefined, {
    completion: () => undefined,
    now: 0,
    home: stubs,
  });
  const run = await runScenario({
    program: {
      main: fixture("wish-home.tsx").pathname,
      root: fixture("").pathname,
    },
    plan,
    argument,
    probe: withHome(probe),
    streams: executor,
  });
  return {
    today: values.settled?.result as Record<string, unknown>,
    comparison: executor.compare([], run.events, values),
    unsimulated: executor.unsimulated,
  };
};

describe("wish-home", () => {
  describe("the fixture on today's runtime and on the executor", () => {
    it("resolves each simulated `wish` of today's runtime in the seeded home", async () => {
      const { today } = await compared();

      expect(today).toMatchObject({
        greeting: `hello ${PROFILE.name}`,
        about: `${PROFILE.initialNameApplied}: ${PROFILE.bio}`,
        count: 0,
        matches: 0,
        mentionable: [],
        registry: [],
        missing: 'No favorites or mentionables found matching "#nothingtagged"',
        quiet: 'No favorites found matching "#nothingtagged"',
      });
      expect(today.profile).toMatchObject({
        name: PROFILE.name,
        bio: PROFILE.bio,
      });
      expect(today.problem).toBe(undefined);
    });

    it("computes on the executor every value today's runtime computes", async () => {
      const { comparison, unsimulated } = await compared();

      expect(comparison.notExecuted).toBe(undefined);
      expect(comparison.differences).toEqual([]);
      expect(comparison.compared).toBe(10);
      expect(unsimulated).toEqual([]);
    });
  });

  // The labeled arm of `integrated.ts`: the executor's documents in the
  // runtime's storage, with the option `compiledPatterns` on.
  describe("the fixture on the executor with its documents in storage", () => {
    const stored = async () => {
      const artifact = await artifactOf("wish-home");
      const space = (await Identity.fromPassphrase("pattern-compiler-compare"))
        .did();
      const labels: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      const refused: string[] = [];
      const checks: OracleCheck[] = [];
      const { differs } = await inStorage(
        artifact,
        { note: "n" },
        [],
        instanceOptions("wish-home", space, () => undefined),
        undefined,
        true,
        true,
        {
          refused: (reasons) => {
            for (const reason of reasons) refused.push(reason);
          },
          committed: (runtime, _hooks, writes) => {
            for (
              const check of checkWrites(
                runtime,
                artifact.plan as unknown as LabelPlan,
                writes,
              )
            ) checks.push(check);
          },
          end: (runtime, hooks, instance) => {
            Object.assign(values, instance.result());
            const tx = runtime.edit();
            try {
              for (const name of OUTPUTS) {
                labels[name] = JSON.stringify(
                  storedLabelAt(tx, {
                    space,
                    id: hooks.entityOf(instance.id),
                    scope: "space",
                    path: [name],
                  }).confidentiality,
                );
              }
            } finally {
              tx.abort();
            }
          },
        },
      );
      return { labels, values, refused, differs, checks };
    };

    it("computes the values from the profile the storage holds, and no commit is refused", async () => {
      const { values, refused, differs } = await stored();

      expect(refused).toEqual([]);
      expect(differs).toEqual([]);
      expect(values).toMatchObject({
        greeting: `hello ${PROFILE.name}`,
        about: `${PROFILE.initialNameApplied}: ${PROFILE.bio}`,
        count: 0,
      });
    });

    it("stores the user atom of the profile in the label of an output derived from it, and not in the label of an output of the argument", async () => {
      const { labels } = await stored();

      expect(labels.greeting).toContain("/User");
      expect(labels.about).toContain("/User");
      expect(labels.profile).toContain("/User");
      expect(labels.note).not.toContain("/User");
    });

    // The outcome of each `wish` has the label of its own resolution (PL
    // §3.19), and not the join of the transaction that resolved every
    // `wish` of the instance, which read the profile.
    it("stores no user atom of the profile in the label of an output that reads the outcome of a `wish` and nothing of the profile", async () => {
      const { labels } = await stored();

      expect(
        ["count", "matches", "mentionable", "registry", "missing", "quiet"]
          .filter((name) => labels[name].includes("/User")),
      ).toEqual([]);
      // The error of the `wish` for the profile is no part of the profile.
      expect(labels.problem).not.toContain("/User");
    });

    it("stores for each write record the label the evaluator gives it, an atom of the other space in its committed form", async () => {
      const { checks } = await stored();

      expect(checks.length).toBeGreaterThan(0);
      expect(
        checks.filter((check) =>
          check.error !== undefined || check.confidentiality !== "equal" ||
          check.integrity !== "equal"
        ).map(({ path }) => path.join("/")),
      ).toEqual([]);
    });
  });

  describe("simulatedOutcome()", () => {
    const home = (): Promise<Home> => memoryHome();
    const link = (doc: string, path: string[]) => ({ $link: { doc, path } });

    it("answers `#profile` with a reference to the profile as the result and the one candidate", async () => {
      const { profile } = await home();

      const outcome = simulatedOutcome({ query: "#profile" }, await home());

      expect(outcome).toMatchObject({
        result: link(profile.id, []),
        candidates: [link(profile.id, [])],
      });
      expect(outcome).not.toHaveProperty("error");
    });

    it("answers a field of the profile with a reference to its path", async () => {
      const { profile } = await home();

      expect(simulatedOutcome({ query: "#profileName" }, await home()))
        .toMatchObject({ result: link(profile.id, ["initialNameApplied"]) });
      expect(simulatedOutcome({ query: "#profile/bio" }, await home()))
        .toMatchObject({ result: link(profile.id, ["bio"]) });
    });

    it("answers `#mentionable` with a reference to the list of the root of the space", async () => {
      const { root } = await home();

      expect(simulatedOutcome({ query: "#mentionable" }, await home()))
        .toMatchObject({
          result: link(root.id, [
            "defaultPattern",
            "backlinksIndex",
            "mentionable",
          ]),
        });
    });

    it("answers a search for a tag with no candidate and the error of no match", async () => {
      expect(
        simulatedOutcome({ query: "#Event", scope: [".", "~"] }, await home()),
      ).toMatchObject({
        candidates: [],
        error: 'No favorites or mentionables found matching "#event"',
        errorCode: "no-match",
      });
    });

    it("has no answer for a target it does not simulate", async () => {
      for (
        const operands of [
          { query: "#summaryIndex" },
          { query: "#learnedSummary" },
          { query: "#profile/picture" },
          { query: "a note about cats" },
          { query: "#mentionable", scope: ["~"] },
          { query: "#event", scope: ["did:key:other"] },
          { query: 5 },
        ]
      ) {
        expect(simulatedOutcome(operands, await home())).toBe(undefined);
      }
    });
  });

  describe("homeStubs()", () => {
    it("records the query of a `wish` it has no answer for, once", async () => {
      const stubs = homeStubs(await memoryHome());

      stubs.wishes({ query: "#profile" });
      stubs.wishes({ query: "#summaryIndex" });
      stubs.wishes({ query: "#summaryIndex" });

      expect(stubs.unsimulated).toEqual(["#summaryIndex"]);
    });
  });
});
