import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { dirname, fromFileUrl, join } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import type { RuntimeDiagnosticsSnapshot } from "../integration/multi-runtime-harness.ts";
import {
  type CaseConfig,
  type CaseResult,
  casesFromConfig,
  checkPhase,
  matrixConfigFromArgs,
  runMatrix,
  sessionSample,
} from "./lunch-poll-diagnose.ts";

const REPO_ROOT = dirname(dirname(dirname(fromFileUrl(import.meta.url))));
const SCRIPT = join(REPO_ROOT, "patterns/tools/lunch-poll-diagnose.ts");

const casesFor = (args: string[]) =>
  casesFromConfig(matrixConfigFromArgs(args), args);

function resultFor(config: CaseConfig): CaseResult {
  return {
    case: {
      users: config.userCount,
      options: config.optionCount,
      voteRounds: config.voteRounds,
      voters: config.voters ?? config.userCount,
    },
    churn: {
      commitConflicts: 0,
      commitPreempted: 0,
      commitReverts: 0,
      commitRejected: 0,
      sessions: [],
    },
    convergence: {
      converged: true,
      voteCounts: [],
      optionCounts: [],
      userCounts: [],
      fingerprints: [],
    },
    phases: [],
  };
}

function snapshot(
  overrides: Partial<RuntimeDiagnosticsSnapshot> = {},
): RuntimeDiagnosticsSnapshot {
  return {
    graph: { nodes: [], edges: [], timestamp: 0 },
    settleStatsHistory: [],
    actionRunTrace: [],
    triggerTrace: [],
    ...overrides,
  };
}

const POLL_OUTPUT = {
  users: [{ name: "User 1" }],
  options: [{ id: "o1", title: "Restaurant 1" }],
  votes: [],
  hostName: "User 1",
  myName: "User 1",
  todayDate: "2026-11-12",
  joinMessage: "",
  userCount: 1,
  optionCount: 1,
  voteCount: 0,
  isJoined: true,
  isAdmin: true,
};

describe("lunch-poll-diagnose", () => {
  describe("casesFromConfig", () => {
    it("returns one case per options and users pair of a preset", () => {
      expect(casesFor(["--quick"])).toEqual([
        {
          program: "main.tsx",
          optionCount: 1,
          userCount: 2,
          voteRounds: 1,
          voters: undefined,
        },
        {
          program: "main.tsx",
          optionCount: 3,
          userCount: 2,
          voteRounds: 1,
          voters: undefined,
        },
      ]);
    });

    it("throws naming a --cases entry that is not <options>x<users>", () => {
      // Skipping the entry instead would run the default matrix in place of
      // the one asked for whenever every entry was mistyped.
      expect(() => casesFor(["--cases=2x3,2by3"])).toThrow(
        '--cases entries must be <options>x<users>; got "2by3"',
      );
    });

    it("throws for a --cases entry with no users", () => {
      expect(() => casesFor(["--cases=1x0"])).toThrow(
        "lunch-poll diagnostics require at least 1 user for 1x0; got 0",
      );
    });

    it("throws for a list argument holding a non-integer", () => {
      expect(() => matrixConfigFromArgs(["--options=1,a"])).toThrow(
        "--options must be comma-separated integers >= 0; got --options=1,a",
      );
    });
  });

  describe("runMatrix", () => {
    it("reports each case's result or failure in the matrix's order", async () => {
      const report = await runMatrix(
        ["--cases=1x1,2x1,3x1", "--rounds=2", "--program=previous.tsx"],
        (config) => {
          if (config.optionCount === 2) {
            return Promise.reject(new Error("gate refused"));
          }
          if (config.optionCount === 3) return Promise.reject("not an error");
          return Promise.resolve(resultFor(config));
        },
      );

      expect(report.kind).toBe("lunch-poll-scaling-diagnostics");
      expect(report.config.program).toBe("previous.tsx");
      const [first, second, third] = report.results;
      expect(first).toEqual({
        ok: true,
        result: resultFor({
          program: "previous.tsx",
          optionCount: 1,
          userCount: 1,
          voteRounds: 2,
        }),
      });
      expect(second.ok).toBe(false);
      if (second.ok) throw new Error("the second case should have failed");
      expect(second.case).toEqual({
        program: "previous.tsx",
        optionCount: 2,
        userCount: 1,
        voteRounds: 2,
        voters: undefined,
      });
      // A thrown Error keeps its stack, which says where the case stopped.
      expect(second.error).toMatch(/^gate refused\nError: gate refused\n/);
      expect(third).toMatchObject({ ok: false, error: "not an error" });
      expect(report.results).toHaveLength(3);
    });

    it("rejects a command line naming no valid matrix before running a case", async () => {
      const ran: CaseConfig[] = [];
      await expect(
        runMatrix(["--quick", "--production"], (config) => {
          ran.push(config);
          return Promise.resolve(resultFor(config));
        }),
      ).rejects.toThrow("--quick and --production cannot be combined");
      expect(ran).toEqual([]);
    });

    it("exits the script with status 1 and the reason on stderr for a bad command line", async () => {
      const output = await runDenoCommandWithTemporaryLock({
        root: REPO_ROOT,
        args: (lockPath) => [
          "run",
          "--config",
          join(REPO_ROOT, "deno.jsonc"),
          "--lock",
          lockPath,
          "--frozen",
          "-A",
          SCRIPT,
          "--quick",
          "--production",
        ],
      });
      expect(output.code).toBe(1);
      expect(new TextDecoder().decode(output.stdout)).toBe("");
      expect(new TextDecoder().decode(output.stderr)).toContain(
        "--quick and --production cannot be combined",
      );
    });
  });

  describe("sessionSample", () => {
    it("throws for a poll output that is not an object", () => {
      expect(() => sessionSample("sample-not-object", null, snapshot()))
        .toThrow("poll output is not an object: null");
    });

    it("reads the poll output's fields", () => {
      const sample = sessionSample("sample-poll", POLL_OUTPUT, snapshot());
      expect(sample.label).toBe("sample-poll");
      expect(sample.poll).toEqual({
        myName: "User 1",
        hostName: "User 1",
        isJoined: true,
        isAdmin: true,
        joinMessage: "",
        todayDate: "2026-11-12",
        users: 1,
        options: 1,
        votes: 0,
      });
    });

    it("counts malformed diagnostics entries as empty", () => {
      const sample = sessionSample(
        "sample-malformed",
        POLL_OUTPUT,
        snapshot({
          graph: {
            nodes: [
              { id: "a", type: "computation", isDirty: true, isPending: true },
              { id: "b", type: "input", isDirty: false, isPending: false },
            ],
            edges: [],
            timestamp: 0,
          },
          settleStatsHistory: [
            null,
            {
              stats: {
                iterations: [
                  "not an iteration",
                  { workSetSize: 4, orderSize: 2, actionsRun: 3 },
                ],
                totalDurationMs: 7,
              },
            },
          ],
          actionRunTrace: [
            null,
            { actionId: "pull:x", durationMs: 5, actualWrites: "not a list" },
            {
              actionId: "raw:ifElse:abc:def",
              durationMs: 9,
              actualWrites: [null, { space: "s", entityId: "e", path: ["a"] }],
            },
          ],
        }),
      );

      expect(sample.graph).toMatchObject({
        nodes: 2,
        computations: 1,
        inputs: 1,
        dirty: 1,
        pending: 1,
      });
      expect(sample.settle).toEqual({
        totalHistoryEntries: 2,
        maxRecentSettleMs: 7,
        maxRecentWorkSet: 4,
        recentActionsRun: 3,
      });
      expect(sample.actions).toEqual({
        totalTraceEntries: 3,
        newTraceEntries: 3,
        // A write that is not an address still counts as a write.
        slowestNew: { site: "raw:ifElse:abc", durationMs: 9, actualWrites: 2 },
      });
    });

    it("reports only the actions a session ran since its last sample", () => {
      const trace = snapshot({
        actionRunTrace: [{ actionId: "raw:ifElse:abc", durationMs: 1 }],
      });
      const first = sessionSample("sample-cursor", POLL_OUTPUT, trace);
      expect(first.actions.slowestNew).toEqual({
        site: "raw:ifElse:abc",
        durationMs: 1,
        actualWrites: 0,
      });

      const second = sessionSample("sample-cursor", POLL_OUTPUT, trace);
      expect(second.actions).toEqual({
        totalTraceEntries: 1,
        newTraceEntries: 0,
        slowestNew: null,
      });
    });
  });

  describe("checkPhase", () => {
    const joined = sessionSample("phase-joined", POLL_OUTPUT, snapshot());
    const refused = sessionSample(
      "phase-refused",
      { ...POLL_OUTPUT, isJoined: false, joinMessage: "no profile" },
      snapshot(),
    );

    it("returns when every session reached the phase", () => {
      expect(() =>
        checkPhase(
          { phase: "join", sessions: [joined] },
          "join the poll",
          (poll) => poll.isJoined,
        )
      ).not.toThrow();
    });

    it("throws naming each session the phase did not reach and its poll", () => {
      expect(() =>
        checkPhase(
          { phase: "join", sessions: [joined, refused] },
          "join the poll",
          (poll) => poll.isJoined,
        )
      ).toThrow(
        'after phase "join", 1 of 2 sessions did not join the poll: ' +
          `phase-refused ${JSON.stringify(refused.poll)}`,
      );
    });
  });
});
