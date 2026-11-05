/**
 * What the Group C checks say when the evidence is thin, which over real
 * artifact trees is most of the time.
 *
 * `seeded-violations.test.ts` holds each check to the shape it is supposed to
 * catch; these are the other arms — a run with no session, a session recorded
 * before the posture record existed, a run state that did not load. They are
 * not edge cases: a smoke over 239 historic console runs lands on them 221
 * times, and the difference between `inconclusive` and `pass` there is the
 * difference between an audit that reports what it established and one that
 * reports the absence of evidence as evidence.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import { harnessFabricSessionPosture } from "../../src/cfc-posture.ts";
import type {
  HarnessFabricSessionCfcPosture,
  HarnessRunState,
} from "../../src/run-state.ts";
import { POSTURE_CHECKS } from "../checks/posture.ts";
import { auditRunFamily } from "../checks/structural.ts";
import { loadRunFamily, type RunEvidence } from "../evidence.ts";
import type { CheckVerdict } from "../report.ts";
import { FIXTURE_RUN_ID, FIXTURE_RUNS_DIR } from "./regenerate-fixtures.ts";

const family = await loadRunFamily(join(FIXTURE_RUNS_DIR, FIXTURE_RUN_ID));

const MAX_ENFORCEMENT_RECORD = harnessFabricSessionPosture({
  apiUrl: "https://fabric.test/",
  identityKeyPath: "/dev/null",
  space: "did:key:posture",
  cfcPosture: "max-enforcement",
});

/** The root run's verdicts with `mutate` applied to a copy of it. */
const verdicts = (
  mutate: (root: RunEvidence) => void,
): Record<string, CheckVerdict> => {
  const root = structuredClone(family.root);
  mutate(root);
  return Object.fromEntries(
    auditRunFamily({ root, children: [] }, POSTURE_CHECKS).map((result) => [
      result.checkId,
      result.verdict,
    ]),
  );
};

const stateOf = (run: RunEvidence): HarnessRunState => {
  if (run.runState.status !== "present") {
    throw new Error("the fixture's run state did not load");
  }
  return run.runState.value;
};

/** A session posture recorded with whatever `overrides` say. */
const recordedPosture = (
  overrides: Partial<HarnessFabricSessionCfcPosture>,
): HarnessFabricSessionCfcPosture => ({
  enforcementMode: "enforce-explicit",
  enforcementModeSource: "preset-pin",
  flowLabels: "persist",
  flowLabelsSource: "posture",
  posture: "max-enforcement",
  record: MAX_ENFORCEMENT_RECORD,
  ...overrides,
});

describe("posture", () => {
  describe("a run that ran no fabric session", () => {
    it("reports every Group C check not-applicable rather than passing them", () => {
      // The subject does not arise, which is a stronger statement than "no
      // evidence" and a different one from "checked and fine".
      expect(verdicts(() => {})).toEqual({
        "AUD-13": "not-applicable",
        "AUD-14": "not-applicable",
        "AUD-15": "not-applicable",
        "AUD-15a": "not-applicable",
      });
    });
  });

  describe("a run state that did not load", () => {
    it("reports every Group C check inconclusive", () => {
      expect(
        verdicts((root) => {
          root.runState = { status: "absent", path: root.runState.path };
        }),
      ).toEqual({
        "AUD-13": "inconclusive",
        "AUD-14": "inconclusive",
        "AUD-15": "inconclusive",
        "AUD-15a": "inconclusive",
      });
    });
  });

  describe("a session recorded before the posture record existed", () => {
    it("reports the matrix and sink checks inconclusive, and still reads the sources", () => {
      // The two itemized dials are all such a run holds, so what the tuple and
      // the sink list would have said is not established — while AUD-15's
      // subject, where each dial came from, is recorded either way.
      const posture = recordedPosture({});
      delete (posture as { record?: unknown }).record;
      expect(
        verdicts((root) => {
          stateOf(root).fabricSessionCfc = posture;
        }),
      ).toEqual({
        "AUD-13": "inconclusive",
        "AUD-14": "inconclusive",
        "AUD-15": "not-applicable",
        "AUD-15a": "pass",
      });
    });
  });

  describe("a session claiming no named posture", () => {
    it("reports the sink check not-applicable, having no claimed coverage to fall short of", () => {
      const posture = recordedPosture({});
      delete (posture as { posture?: unknown }).posture;
      expect(
        verdicts((root) => {
          stateOf(root).fabricSessionCfc = posture;
        })["AUD-14"],
      ).toBe("not-applicable");
    });
  });

  describe("AUD-15 over the policy snapshot", () => {
    /** The fixture with the snapshot's mode source and mode set. */
    const withSnapshotMode = (
      source: string,
      mode: string,
    ): Record<string, CheckVerdict> =>
      verdicts((root) => {
        stateOf(root).fabricSessionCfc = recordedPosture({});
        if (root.policySnapshot.status !== "present") {
          throw new Error("the fixture's policy snapshot did not load");
        }
        const snapshot = root.policySnapshot.value as {
          cfc: { enforcementMode: string; enforcementModeSource: string };
        };
        snapshot.cfc.enforcementModeSource = source;
        snapshot.cfc.enforcementMode = mode;
      });

    it("is inconclusive when the snapshot is absent, so the source is unknown", () => {
      expect(
        verdicts((root) => {
          stateOf(root).fabricSessionCfc = recordedPosture({});
          delete stateOf(root).cfcPolicySnapshot;
          root.policySnapshot = {
            status: "absent",
            path: root.policySnapshot.path,
          };
        })["AUD-15"],
      ).toBe("inconclusive");
    });

    it("passes a default-sourced mode no weaker than the session claims", () => {
      // The default landed on the claim, which is the ordinary case and is not
      // a fallback of any kind.
      expect(withSnapshotMode("default", "enforce-explicit")["AUD-15"]).toBe(
        "pass",
      );
    });

    it("passes a default-sourced mode stricter than the session claims", () => {
      expect(withSnapshotMode("default", "enforce-strict")["AUD-15"]).toBe(
        "pass",
      );
    });

    it("does not arise for a mode the operator configured", () => {
      expect(withSnapshotMode("explicit-config", "observe")["AUD-15"]).toBe(
        "not-applicable",
      );
    });

    it("fails a default-sourced enforcement mode weaker than the session claims", () => {
      expect(
        verdicts((root) => {
          stateOf(root).fabricSessionCfc = recordedPosture({});
          if (root.policySnapshot.status !== "present") {
            throw new Error("the fixture's policy snapshot did not load");
          }
          const snapshot = root.policySnapshot.value as {
            cfc: { enforcementMode: string; enforcementModeSource: string };
          };
          snapshot.cfc.enforcementModeSource = "default";
          snapshot.cfc.enforcementMode = "observe";
        })["AUD-15"],
      ).toBe("fail");
    });
  });
});
