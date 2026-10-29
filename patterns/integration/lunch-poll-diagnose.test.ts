/**
 * The lunch-poll scaling probe still drives the poll it measures.
 *
 * `tools/lunch-poll-diagnose.ts` is the scaling diagnostic for the lunch
 * poll, and nothing else runs it. Every step it drives is gated in the
 * pattern — joining needs a resolved profile, adding an option needs the
 * host, casting a vote needs a roster entry and a resolved clock — and a gate
 * that refuses writes nothing and reports nothing. A probe driving a contract
 * the pattern has moved on from therefore still finishes and still prints its
 * JSON, reporting a matrix of zeros that reads like a measurement of an idle
 * poll. This runs the smallest case the probe has and asks what it measured.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import {
  casesFromConfig,
  compactActionSite,
  describeCase,
  matrixConfigFromArgs,
  runCase,
  voterIdentity,
} from "../tools/lunch-poll-diagnose.ts";

describe("lunch-poll-diagnose", () => {
  it("selects the production-size preset while honoring explicit overrides", () => {
    expect(matrixConfigFromArgs(["--production"])).toEqual({
      program: "main.tsx",
      optionCounts: [14],
      userCounts: [1],
      voteRounds: 3,
      voters: undefined,
    });

    expect(() => matrixConfigFromArgs(["--production", "--quick"]))
      .toThrow("--quick and --production cannot be combined");

    expect(matrixConfigFromArgs([
      "--production",
      "--program=previous.tsx",
      "--options=2,4",
      "--users=3",
      "--rounds=5",
      "--voters=2",
    ])).toEqual({
      program: "previous.tsx",
      optionCounts: [2, 4],
      userCounts: [3],
      voteRounds: 5,
      voters: 2,
    });

    expect(() => matrixConfigFromArgs(["--voters=0"]))
      .toThrow("--voters must be an integer >= 1");

    const tooManyVoters = ["--users=2", "--voters=3"];
    expect(() =>
      casesFromConfig(matrixConfigFromArgs(tooManyVoters), tooManyVoters)
    ).toThrow("--voters=3 exceeds the 2 users of 1x2");
    const tooManyVotersForCase = ["--cases=1x2", "--voters=3"];
    expect(() =>
      casesFromConfig(
        matrixConfigFromArgs(tooManyVotersForCase),
        tooManyVotersForCase,
      )
    ).toThrow("--voters=3 exceeds the 2 users of 1x2");

    expect(describeCase({ optionCount: 14, userCount: 2, voteRounds: 3 }))
      .toBe("14 options x 2 users, rounds=3");
    expect(describeCase({
      optionCount: 14,
      userCount: 2,
      voteRounds: 3,
      voters: 1,
    })).toBe("14 options x 2 users, rounds=3, voters=1");

    const explicitArgs = ["--production", "--rounds=2", "--cases=2x3,4x5"];
    expect(
      casesFromConfig(matrixConfigFromArgs(explicitArgs), explicitArgs),
    ).toEqual([
      { optionCount: 2, userCount: 3, voteRounds: 2, voters: undefined },
      { optionCount: 4, userCount: 5, voteRounds: 2, voters: undefined },
    ]);
  });

  it("refuses a case with more voters than users before opening a harness", async () => {
    await expect(
      runCase({ optionCount: 1, userCount: 2, voteRounds: 0, voters: 3 }),
    ).rejects.toThrow("--voters=3 exceeds the 2 users of 1x2");
    await expect(
      runCase({ optionCount: 1, userCount: 2, voteRounds: 0, voters: 0 }),
    ).rejects.toThrow("--voters must be an integer >= 1; got 0");
  });

  it("measures a poll two voters joined, filled, and voted in", async () => {
    const result = await runCase({
      optionCount: 1,
      userCount: 2,
      voteRounds: 1,
    });

    // Both sessions see the same poll, and it is the poll the case asked
    // for: two voters on the roster, the host's one option, and a vote from
    // each of them.
    expect(result.convergence.converged).toBe(true);
    expect(result.convergence.userCounts).toEqual([2, 2]);
    expect(result.convergence.optionCounts).toEqual([1, 1]);
    expect(result.convergence.voteCounts).toEqual([2, 2]);

    // The samples the probe exists to collect, taken at each phase.
    expect(result.phases.map((phase) => phase.phase)).toEqual([
      "baseline-open",
      "all-users-join",
      "host-adds-options",
      "concurrent-vote-round-1",
    ]);
    for (const phase of result.phases) {
      expect(phase.aggregate.maxNodes).toBeGreaterThan(0);
      expect(phase.sessions.map((session) => session.label)).toEqual([
        "user-1",
        "user-2",
      ]);
    }
  });

  describe("voterIdentity", () => {
    // A vote names its voter by profile cell, and a read of the poll output
    // hands that back either resolved or as the link that reaches it. Both
    // name the same person, and the convergence fingerprint is only a
    // comparison of vote sets while every voter has a key of their own.

    const ID = "of:fid1:lj_-VYUlQNO3nl9TB-U3wTrLA7NTtge02az-NgnaA1g";
    const SPACE = "did:key:z6Mkh7LjNUSoSVtFSQQRAVZz5XigakGLvLemwAeC4nCjQb4m";

    it("names a voter by the name on their resolved profile", () => {
      expect(voterIdentity({ name: "User 1" })).toEqual(["name", "User 1"]);
    });

    it("names a voter by the link that reaches their profile", () => {
      const identity = voterIdentity(
        linkRefFrom({ path: [], id: ID, space: SPACE, scope: "space" }),
      );
      expect(identity).toEqual(["link", SPACE, ID, "space", []]);
    });

    it("tells two links apart by the scope they are stored under", () => {
      const inSpace = linkRefFrom({
        path: [],
        id: ID,
        space: SPACE,
        scope: "space",
      });
      const perUser = linkRefFrom({
        path: [],
        id: ID,
        space: SPACE,
        scope: "user",
      });
      expect(voterIdentity(inSpace)).not.toEqual(voterIdentity(perUser));
    });

    it("tells two links apart when a path segment holds a separator", () => {
      const nested = linkRefFrom({ path: ["a", "b"], id: ID, space: SPACE });
      const dotted = linkRefFrom({ path: ["a.b"], id: ID, space: SPACE });
      expect(voterIdentity(nested)).not.toEqual(voterIdentity(dotted));
    });

    it("names no voter for a vote that has none", () => {
      expect(voterIdentity(undefined)).toEqual([]);
    });

    it("refuses a voter it cannot name", () => {
      // An empty key for a voter who has one would read as a vote nobody
      // cast, in every session at once, and compare equal everywhere.
      expect(() => voterIdentity({ profile: "not a link" })).toThrow(
        "cannot identify",
      );
    });
  });

  describe("compactActionSite", () => {
    // Every site the probe prints comes through here, from a handler id,
    // which ends in its own authored source, or from the `src` the scheduler
    // graph reports for a computation, whose id names content instead.

    const IDENTITY = "Rn0PTb8geZO-q7Hg1DIBZI5JFBBLkW4oU3co2N9DLVA";

    it("names the file, line and column of an authored site", () => {
      expect(
        compactActionSite(
          `cf:module/${IDENTITY}/apps/lunch-poll/main.tsx:1366:19`,
        ),
      ).toBe("apps/lunch-poll/main.tsx:1366:19");
    });

    it("names the authored site a handler id ends in", () => {
      expect(
        compactActionSite(
          `handler:cf:module/${IDENTITY}/apps/lunch-poll/card.tsx:62:2`,
        ),
      ).toBe("apps/lunch-poll/card.tsx:62:2");
    });

    it("names the symbol of an action with no authored site", () => {
      expect(compactActionSite(`cf:module/${IDENTITY}:__cfLift_22:vt-pymUsk`))
        .toBe("__cfLift_22:vt-pymUsk");
    });

    it("names a builtin by the builtin it is", () => {
      expect(compactActionSite("raw:ifElse:ofNy8lcRiR_Z"))
        .toBe("raw:ifElse:ofNy8lcRiR_Z");
    });

    it("names the result sink for a sink on the result", () => {
      expect(compactActionSite(`sink:did:key:z6Mk/of:fid1:AAA/value`))
        .toBe("sink:result");
    });
  });
});
