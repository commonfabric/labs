import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { Artifact } from "../../exec/executor.ts";
import { type Plan, runScenario } from "../harness.ts";
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
