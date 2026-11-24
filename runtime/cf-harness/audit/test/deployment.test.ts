/**
 * The Group D checks, each held to the shape it is supposed to catch.
 *
 * These read a corpus rather than a run, so a case here builds the corpus:
 * the fixture family, with a posture record installed where the check reads
 * one. The `/api/meta` cases serve a stub over loopback rather than reaching
 * a deployment — the check's subject is what a payload says, and a real
 * toolshed would make the suite a test of the network.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  cfcPostureReport,
  inheritedCfcPostureReport,
  resolveCfcDials,
  RUNTIME_CFC_DIAL_DEFAULTS,
} from "@commonfabric/runner/cfc";
import {
  MAX_ENFORCEMENT_CFC_OPTIONS,
  MAX_ENFORCEMENT_SINK_CEILINGS,
} from "@commonfabric/runner";

import { harnessFabricSessionPosture } from "../../src/cfc-posture.ts";
import type { HarnessRunState } from "../../src/run-state.ts";
import { auditDeployment } from "../checks/deployment.ts";
import { readToolshedMeta } from "../cli.ts";
import { loadRunFamily, type RunFamily } from "../evidence.ts";
import { parseExpectedPosture } from "../expected-posture.ts";
import type { CheckResult, CheckVerdict } from "../report.ts";
import { FIXTURE_RUN_ID, FIXTURE_RUNS_DIR } from "./regenerate-fixtures.ts";

const family = await loadRunFamily(join(FIXTURE_RUNS_DIR, FIXTURE_RUN_ID));

const MAX_ENFORCEMENT_RECORD = harnessFabricSessionPosture({
  apiUrl: "https://fabric.test/",
  identityKeyPath: "/dev/null",
  space: "did:key:deployment",
  cfcPosture: "max-enforcement",
});

/**
 * The same posture as a deployment publishes it: read off resolved runtime
 * fields rather than projected. Built through the resolved constructor rather
 * than by restamping a projection, so the suite never demonstrates the one
 * move the provenance field exists to prevent. The dials come from the
 * max-enforcement bundle, resolved the way a runtime resolves them, so this
 * record carries the values a max-enforcement deployment runs at.
 */
const ATTESTED_MAX_ENFORCEMENT_RECORD = cfcPostureReport({
  ...resolveCfcDials(MAX_ENFORCEMENT_CFC_OPTIONS),
  cfcPolicySnapshot: undefined,
  cfcSinkMaxConfidentiality: MAX_ENFORCEMENT_SINK_CEILINGS,
});

/** The fleet posture as a deployment publishes it. */
const ATTESTED_FLEET_RECORD = cfcPostureReport({
  ...RUNTIME_CFC_DIAL_DEFAULTS,
  cfcPolicySnapshot: undefined,
  cfcSinkMaxConfidentiality: {},
});

const FLEET_RECORD = harnessFabricSessionPosture({
  apiUrl: "https://fabric.test/",
  identityKeyPath: "/dev/null",
  space: "did:key:deployment",
});

const MAX_ENFORCEMENT_SPEC = parseExpectedPosture({
  label: "max-enforcement",
  flowLabels: "persist",
  writeFloor: "enforce",
  triggerReadGating: true,
  ceilingedSinks: ["fetchText", "fetchJson"],
  ungatedSinks: [
    "llm",
    "llmDialog",
    "generateText",
    "generateObject",
    "sqliteQuery",
  ],
});

/**
 * The fixture family with one denied decision seeded onto its root run.
 *
 * `attested` additionally clears the two fields that weaken a posture, so the
 * only difference between the two arms of AUD-16's positive case is the thing
 * that arm is about.
 */
const familyRefusing = (
  reasonCode: string,
  attested = false,
  alsoCodes: readonly string[] = [],
): RunFamily => {
  const root = structuredClone(family.root);
  if (root.policyTrace.status !== "present") {
    throw new Error("the fixture's policy trace did not load");
  }
  const trace = root.policyTrace.value as unknown as {
    decisions: { decision: string; reasonCodes: string[] }[];
  };
  trace.decisions = [
    ...trace.decisions,
    { decision: "denied", reasonCodes: [reasonCode, ...alsoCodes] },
  ];
  if (attested && root.policySnapshot.status === "present") {
    const snapshot = root.policySnapshot.value as {
      cfc: { substrateStatus?: string; absenceBehavior?: string };
    };
    delete snapshot.cfc.substrateStatus;
    delete snapshot.cfc.absenceBehavior;
  }
  return { root, children: [] };
};

/**
 * The fixture family with a release refusal seeded onto its policy trace.
 *
 * The refusal is seeded ONLY there, and the fixture's tool outputs are left
 * as they are: the check reads the decision channel, and a case that seeded
 * both could not tell which one it read.
 *
 * `attested` additionally clears the two fields that weaken a posture, so the
 * only difference between the two positive arms is the thing that arm is
 * about.
 */
const familyRefusingRelease = (
  gates: readonly string[],
  sinks: readonly string[],
  attested = false,
): RunFamily => {
  const root = structuredClone(family.root);
  if (root.policyTrace.status !== "present") {
    throw new Error("the fixture's policy trace did not load");
  }
  const trace = root.policyTrace.value as unknown as {
    decisions: Record<string, unknown>[];
  };
  trace.decisions = [
    ...trace.decisions,
    {
      decision: "denied",
      reasonCodes: ["cfc_release_withheld"],
      release: {
        reasonCode: "cfc_release_withheld",
        boundary: "release",
        sink: sinks[0] ?? "run_pattern",
        ceiling: [],
        refusal: {
          gates,
          sinks,
          offendingAtoms: ["medical"],
          inputKeys: ["patient"],
          attribution: "complete",
        },
      },
    },
  ];
  if (attested && root.policySnapshot.status === "present") {
    const snapshot = root.policySnapshot.value as {
      cfc: { substrateStatus?: string; absenceBehavior?: string };
    };
    delete snapshot.cfc.substrateStatus;
    delete snapshot.cfc.absenceBehavior;
  }
  return { root, children: [] };
};

/** The fixture family with `record` installed as the root run's posture. */
const familyRecording = (
  record: typeof MAX_ENFORCEMENT_RECORD | undefined,
): RunFamily => {
  const root = structuredClone(family.root);
  if (root.runState.status === "present" && record !== undefined) {
    (root.runState.value as HarnessRunState).fabricSessionCfc = {
      enforcementMode: "enforce-explicit",
      enforcementModeSource: "preset-pin",
      flowLabels: record.flowLabels.rung as "off" | "observe" | "persist",
      flowLabelsSource: "posture",
      posture: "max-enforcement",
      record,
    };
  }
  return { root, children: [] };
};

const verdictOf = (
  results: readonly CheckResult[],
  checkId: string,
): CheckVerdict | undefined =>
  results.find((result) => result.checkId === checkId)?.verdict;

describe("Group D deployment checks", () => {
  describe("AUD-16 reads the release reason, not the decision word", () => {
    it("does not throw on a decision persisted with an empty release", () => {
      // `null` is a shape a record can hold and a dereference cannot. A check
      // that throws produces no verdict at all, which is worse than the wrong
      // one: the run goes unreported rather than reported badly.
      const withRefusal = familyRefusingRelease(
        ["sink-ceiling"],
        ["run_pattern"],
      );
      const trace = withRefusal.root.policyTrace;
      if (trace.status !== "present") throw new Error("no trace");
      const decisions =
        (trace.value as unknown as { decisions: Record<string, unknown>[] })
          .decisions;
      decisions[decisions.length - 1]!.release = null;

      const refusal = auditDeployment({
        families: [withRefusal],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
      }).find((one) => one.checkId === "AUD-16");
      expect(refusal).toBeDefined();
      expect(refusal?.message).not.toContain("1 release refusal");
    });

    it("does not count a release record whose boundary names neither", () => {
      // The contract exports its reason codes so a record read off disk is
      // checked against them rather than asserted into them. A persisted shape
      // nobody writes — a known reason beside a boundary that is neither
      // `release` nor `commit` — is evidence of nothing, and counting it would
      // let a malformed record answer the question this check asks.
      const withRefusal = familyRefusingRelease(
        ["sink-ceiling"],
        ["run_pattern"],
      );
      const trace = withRefusal.root.policyTrace;
      if (trace.status !== "present") throw new Error("no trace");
      const decisions =
        (trace.value as unknown as { decisions: Record<string, unknown>[] })
          .decisions;
      const seeded = decisions[decisions.length - 1]!;
      (seeded.release as { boundary?: unknown }).boundary = "bogus";

      const refusal = auditDeployment({
        families: [withRefusal],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
      }).find((one) => one.checkId === "AUD-16");
      expect(refusal?.message).not.toContain("1 release refusal");
    });

    it("counts a withheld release whose outcome word is not `denied`", () => {
      // CT-2232 gives a withheld release its own outcome word, parallel to
      // `invalid`. The refusal is the `release.reasonCode`; the outcome word
      // is a presentation of it, and a counter keyed on the word counts
      // nothing the day it moves. Seeded with the word this check must not
      // depend on.
      const withRefusal = familyRefusingRelease(
        ["sink-ceiling"],
        ["run_pattern"],
      );
      const trace = withRefusal.root.policyTrace;
      if (trace.status !== "present") throw new Error("no trace");
      const decisions =
        (trace.value as unknown as { decisions: Record<string, unknown>[] })
          .decisions;
      const seeded = decisions[decisions.length - 1]!;
      seeded.decision = "withheld";

      const refusal = auditDeployment({
        families: [withRefusal],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
      }).find((one) => one.checkId === "AUD-16");
      expect(refusal?.message).toContain("1 release refusal");
    });
  });

  describe("AUD-16 refusal liveness", () => {
    it("names the not-attested and permissive-if-absent counts", () => {
      const [result] = auditDeployment({
        families: [family],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
      });
      expect(
        result!.evidence.map((evidence) => evidence.pointer),
      ).toContain("cfc.substrateStatus");
      expect(
        result!.evidence.map((evidence) => evidence.pointer),
      ).toContain("cfc.absenceBehavior");
    });

    it("warns a corpus that recorded no release refusal", () => {
      expect(
        verdictOf(
          auditDeployment({
            families: [family],
            paths: [FIXTURE_RUNS_DIR],
            expectRefusals: false,
          }),
          "AUD-16",
        ),
      ).toBe("warn");
    });

    it("fails the same corpus once it is declared adversarial", () => {
      expect(
        verdictOf(
          auditDeployment({
            families: [family],
            paths: [FIXTURE_RUNS_DIR],
            expectRefusals: true,
          }),
          "AUD-16",
        ),
      ).toBe("fail");
    });

    it("counts a sink-ceiling refusal present only in the policy trace", () => {
      // The channel a release refusal is written to: a decision in the trace
      // carrying a `release` record, naming the gate that refused and the
      // sink whose ceiling the flow exceeded. The fixture's tool outputs hold
      // no refusal at all, so a count of one is a count of the trace.
      const results = auditDeployment({
        families: [familyRefusingRelease(["sink-ceiling"], ["fetchText"])],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: true,
      });
      const refusal = results.find((result) => result.checkId === "AUD-16");
      expect(refusal?.verdict).toBe("warn");
      expect(refusal?.message).toContain("1 release refusal");
      expect(refusal?.message).toContain("sink-ceiling");
    });

    it("counts a writer-fit refusal the same way", () => {
      expect(
        auditDeployment({
          families: [familyRefusingRelease(["writer-fit"], [])],
          paths: [FIXTURE_RUNS_DIR],
          expectRefusals: true,
        }).find((result) => result.checkId === "AUD-16")?.message,
      ).toContain("writer-fit");
    });

    it("passes once a refusal exists and no run weakens its own posture", () => {
      // The only arm where the corpus shows a label deciding an outcome and
      // nothing qualifies it.
      expect(
        verdictOf(
          auditDeployment({
            families: [
              familyRefusingRelease(["sink-ceiling"], ["fetchText"], true),
            ],
            paths: [FIXTURE_RUNS_DIR],
            expectRefusals: true,
          }),
          "AUD-16",
        ),
      ).toBe("pass");
    });

    it("counts no tool-policy denial as a release refusal", () => {
      // The denials the corpus does hold decide on authority or on a
      // capability, and the loop records its allow-side decision before the
      // tool runs, so a boundary refusal cannot appear there at all.
      const results = auditDeployment({
        families: [
          familyRefusing("cfc_enforce_explicit_requires_direct_command"),
        ],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: true,
      });
      expect(verdictOf(results, "AUD-16")).toBe("fail");
      expect(
        results.find((result) => result.checkId === "AUD-16")?.evidence[2]
          ?.detail,
      ).toContain("decide on authority rather than on a label");
    });

    it("counts the denials off the run report when the trace is absent", () => {
      // The trace is the artifact whose subject they are; a tree missing it
      // still has the same list on the report, and dropping to it is what
      // lets an older tree be counted rather than read as denial-free.
      const root = structuredClone(family.root);
      if (
        root.policyTrace.status !== "present" ||
        root.runReport.status !== "present"
      ) {
        throw new Error("the fixture's policy artifacts did not load");
      }
      root.policyTrace = { status: "absent", path: root.policyTrace.path };
      const report = root.runReport.value as unknown as {
        policyDecisions: { decision: string; reasonCodes: string[] }[];
      };
      report.policyDecisions = [
        ...report.policyDecisions ?? [],
        { decision: "denied", reasonCodes: ["tool_not_allowed"] },
      ];
      expect(
        auditDeployment({
          families: [{ root, children: [] }],
          paths: [FIXTURE_RUNS_DIR],
          expectRefusals: false,
        }).find((result) => result.checkId === "AUD-16")?.evidence[2]?.detail,
      ).toContain("1 tool-policy denial");
    });

    it("is inconclusive when the trace parsed without a decisions array and no other artifact carries one", () => {
      // A truncated trace is not a run that decided nothing. Reading its
      // missing list as an empty one would answer "no refusal here" to a
      // question this host cannot see the evidence for.
      const root = structuredClone(
        familyRefusingRelease(
          ["sink-ceiling"],
          ["run_pattern"],
        ).root,
      );
      if (
        root.policyTrace.status !== "present" ||
        root.runReport.status !== "present" ||
        root.runState.status !== "present"
      ) {
        throw new Error("the fixture's policy artifacts did not load");
      }
      delete (root.policyTrace.value as { decisions?: unknown }).decisions;
      delete (root.runReport.value as { policyDecisions?: unknown })
        .policyDecisions;
      delete (root.runState.value as { policyDecisions?: unknown })
        .policyDecisions;
      expect(
        verdictOf(
          auditDeployment({
            families: [{ root, children: [] }],
            paths: [FIXTURE_RUNS_DIR],
            expectRefusals: true,
          }),
          "AUD-16",
        ),
      ).toBe("inconclusive");
    });

    it("is inconclusive when a run's decisions could not be read anywhere", () => {
      // An unreadable channel is not an empty one, and must not report as one.
      // All three artifacts that carry the decisions have to be gone, since
      // the reader drops to the next one it can read.
      const root = structuredClone(family.root);
      const unparseable = (path: string) =>
        ({ status: "unparseable", path, detail: "could not be read" }) as const;
      root.policyTrace = unparseable(root.policyTrace.path);
      root.runReport = unparseable(root.runReport.path);
      root.runState = unparseable(root.runState.path);
      expect(
        verdictOf(
          auditDeployment({
            families: [{ root, children: [] }],
            paths: [FIXTURE_RUNS_DIR],
            expectRefusals: true,
          }),
          "AUD-16",
        ),
      ).toBe("inconclusive");
    });
  });

  describe("AUD-17 toolshed posture", () => {
    it("fails a deployment whose /api/meta publishes no posture", () => {
      const results = auditDeployment({
        families: [family],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
        expected: MAX_ENFORCEMENT_SPEC,
        toolshedMeta: {
          status: "read",
          url: "http://stub.test/api/meta",
          cfc: null,
        },
      });
      expect(verdictOf(results, "AUD-17")).toBe("fail");
    });

    it("passes a deployment whose published posture satisfies the spec", () => {
      const results = auditDeployment({
        families: [family],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
        expected: MAX_ENFORCEMENT_SPEC,
        toolshedMeta: {
          status: "read",
          url: "http://stub.test/api/meta",
          cfc: ATTESTED_MAX_ENFORCEMENT_RECORD,
        },
      });
      expect(verdictOf(results, "AUD-17")).toBe("pass");
    });

    it("fails a deployment whose published posture misses a field the spec asserts", () => {
      const results = auditDeployment({
        families: [family],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
        expected: MAX_ENFORCEMENT_SPEC,
        toolshedMeta: {
          status: "read",
          url: "http://stub.test/api/meta",
          cfc: ATTESTED_FLEET_RECORD,
        },
      });
      expect(verdictOf(results, "AUD-17")).toBe("fail");
    });

    it("fails a deployment that publishes a projection rather than an attestation", () => {
      const results = auditDeployment({
        families: [family],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
        expected: MAX_ENFORCEMENT_SPEC,
        toolshedMeta: {
          status: "read",
          url: "http://stub.test/api/meta",
          cfc: MAX_ENFORCEMENT_RECORD,
        },
      });
      // MAX_ENFORCEMENT_RECORD is the harness's projection, and satisfies
      // every field the spec asserts — so the only thing that can fail it here
      // is the kind of record it is.
      expect(verdictOf(results, "AUD-17")).toBe("fail");
    });

    it("warns a deployment publishing a posture with no spec to weigh it against", () => {
      const results = auditDeployment({
        families: [family],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
        toolshedMeta: {
          status: "read",
          url: "http://stub.test/api/meta",
          cfc: ATTESTED_MAX_ENFORCEMENT_RECORD,
        },
      });
      expect(verdictOf(results, "AUD-17")).toBe("warn");
    });

    it("is absent when no deployment was named", () => {
      const results = auditDeployment({
        families: [family],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
      });
      expect(verdictOf(results, "AUD-17")).toBeUndefined();
    });
  });

  describe("reading a deployment's published posture", () => {
    it("reads the record a stub serves on /api/meta", async () => {
      // A stub over the fetch seam rather than a listening socket: the
      // check's subject is the payload, and a port is not part of it.
      const meta = await readToolshedMeta(
        "http://stub.test",
        () =>
          Promise.resolve(
            new Response(JSON.stringify({ cfc: MAX_ENFORCEMENT_RECORD })),
          ),
      );
      expect(meta.status).toBe("read");
      expect(meta.status === "read" ? meta.cfc : undefined)
        .toEqual(MAX_ENFORCEMENT_RECORD);
    });

    it("reads a null record as a deployment that published nothing", async () => {
      const meta = await readToolshedMeta(
        "http://stub.test",
        () => Promise.resolve(new Response(JSON.stringify({ cfc: null }))),
      );
      expect(meta.status === "read" ? meta.cfc : undefined).toBe(null);
    });

    it("reads a non-OK response as unreachable, naming the status", async () => {
      // A 404 or a 502 is a deployment that did not answer the question, not
      // one that answered "no posture" — the two want different verdicts.
      const meta = await readToolshedMeta(
        "http://stub.test",
        () => Promise.resolve(new Response("nope", { status: 502 })),
      );
      expect(meta.status).toBe("unreachable");
      expect(meta.status === "unreachable" ? meta.detail : "").toBe("HTTP 502");
    });

    it("reports a rejection that is not an Error without losing it", async () => {
      const meta = await readToolshedMeta(
        "http://stub.test",
        () => Promise.reject("connection reset"),
      );
      expect(meta.status === "unreachable" ? meta.detail : "").toBe(
        "connection reset",
      );
    });

    it("reports an unreachable deployment rather than throwing", async () => {
      const meta = await readToolshedMeta(
        "http://stub.test",
        () => Promise.reject(new Error("connection refused")),
      );
      expect(meta.status).toBe("unreachable");
    });
  });

  describe("AUD-18 posture uniformity", () => {
    it("is inconclusive over a corpus that recorded no posture", () => {
      const results = auditDeployment({
        families: [family],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
      });
      expect(verdictOf(results, "AUD-18")).toBe("inconclusive");
    });

    it("passes a corpus whose runs recorded one posture", () => {
      const recording = familyRecording(MAX_ENFORCEMENT_RECORD);
      const results = auditDeployment({
        families: [recording],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
      });
      expect(verdictOf(results, "AUD-18")).toBe("pass");
    });

    it("groups the runs that recorded one posture together", () => {
      const recording = familyRecording(MAX_ENFORCEMENT_RECORD);
      const results = auditDeployment({
        families: [recording, familyRecording(MAX_ENFORCEMENT_RECORD)],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
      });
      const parity = results.find((result) => result.checkId === "AUD-18");
      expect(parity?.verdict).toBe("pass");
      // One record, both runs named under it: two entries here would be two
      // postures the corpus never had.
      expect(parity?.evidence.length).toBe(1);
      expect(parity?.evidence[0]?.detail).toContain("2 run(s)");
    });

    it("reads a delegated child's inherited record as its parent's posture", () => {
      const results = auditDeployment({
        families: [
          familyRecording(MAX_ENFORCEMENT_RECORD),
          familyRecording(inheritedCfcPostureReport(MAX_ENFORCEMENT_RECORD)),
        ],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
      });
      // One session, one posture: the stamp says how the second run came by
      // the record, not that the corpus holds two of them.
      const parity = results.find((result) => result.checkId === "AUD-18");
      expect(parity?.verdict).toBe("pass");
      expect(parity?.evidence.length).toBe(1);
      expect(parity?.evidence[0]?.detail).toContain("2 run(s)");
    });

    it("warns a corpus whose surfaces recorded different postures", () => {
      const results = auditDeployment({
        families: [
          familyRecording(MAX_ENFORCEMENT_RECORD),
          familyRecording(FLEET_RECORD),
        ],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
      });
      expect(verdictOf(results, "AUD-18")).toBe("warn");
    });

    it("fails when one of those postures does not satisfy the spec", () => {
      const results = auditDeployment({
        families: [
          familyRecording(MAX_ENFORCEMENT_RECORD),
          familyRecording(FLEET_RECORD),
        ],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
        expected: MAX_ENFORCEMENT_SPEC,
      });
      expect(verdictOf(results, "AUD-18")).toBe("fail");
    });
  });

  describe("the Group D register", () => {
    it("registers no check that could never return a verdict", () => {
      // A line item that is `inconclusive` on every tree forever reports the
      // same thing about a deployment that publishes what it is asked for as
      // about one that does not. AUD-19 was one, about the shell renderer's
      // profile, which is not a profile cf-harness is a candidate for.
      const results = auditDeployment({
        families: [family],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
      });
      expect(results.map((result) => result.checkId)).not.toContain("AUD-19");
    });
  });
});
