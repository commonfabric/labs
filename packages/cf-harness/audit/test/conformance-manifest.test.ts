/**
 * The manifest's own audit: that its entries can do their job, and that
 * holding a status to its checks' verdicts turns in both directions.
 *
 * The second half is the point. A reconciliation that only failed when the
 * manifest overclaimed would let every entry sit at `absent` forever,
 * describing a system that had since been fixed, and the register would stop
 * being the progress signal it exists to be.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import { RUN_CHECKS } from "../checks/registry.ts";
import { auditRunFamily } from "../checks/structural.ts";
import {
  CFC_HARNESS_OBLIGATIONS,
  type ConformanceObligation,
  countObligationStatuses,
  manifestReconciliationFails,
  reconcileConformanceManifest,
  renderConformancePosition,
} from "../conformance-manifest.ts";
import { loadRunFamily } from "../evidence.ts";
import type { CheckResult, CheckVerdict } from "../report.ts";
import { FIXTURE_RUN_ID, FIXTURE_RUNS_DIR } from "./regenerate-fixtures.ts";

const family = await loadRunFamily(join(FIXTURE_RUNS_DIR, FIXTURE_RUN_ID));
const FIXTURE_RESULTS = auditRunFamily(family, RUN_CHECKS);

/** A result carrying `verdict` for `checkId`, as a check would have reported. */
const resultFor = (checkId: string, verdict: CheckVerdict): CheckResult => ({
  checkId,
  title: checkId,
  runId: "seeded",
  runDir: "/seeded",
  verdict,
  message: "seeded",
  citations: [],
  evidence: [],
});

const obligation = (
  overrides: Partial<ConformanceObligation>,
): ConformanceObligation => ({
  id: "HX",
  obligation: "a seeded obligation",
  status: "absent",
  account: "seeded",
  evidence: [],
  coveredBy: ["AUD-20"],
  issue: "CT-2178",
  ...overrides,
});

describe("conformance manifest", () => {
  describe("the entries", () => {
    it("gives every obligation an id, the clause, an account and an issue", () => {
      expect(
        CFC_HARNESS_OBLIGATIONS.filter((one) =>
          one.id.trim() === "" || one.obligation.trim() === "" ||
          one.account.trim() === "" || one.issue.trim() === ""
        ).map((one) => one.id),
      ).toEqual([]);
    });

    it("names only checks that exist", () => {
      // A `coveredBy` naming a check nobody registered reconciles against
      // nothing, and reads as an obligation the audit is watching.
      const registered = new Set(RUN_CHECKS.map((check) => check.id));
      expect(
        CFC_HARNESS_OBLIGATIONS.flatMap((one) =>
          one.coveredBy.filter((checkId) => !registered.has(checkId))
        ),
      ).toEqual([]);
    });

    it("gives every obligation a distinct id", () => {
      expect(new Set(CFC_HARNESS_OBLIGATIONS.map((one) => one.id)).size).toBe(
        CFC_HARNESS_OBLIGATIONS.length,
      );
    });

    it("counts the nine obligations of the checklist", () => {
      const counts = countObligationStatuses();
      expect(
        counts.mechanized + counts.documented + counts.partial + counts.absent,
      ).toBe(9);
    });
  });

  describe("reconciliation against the checks", () => {
    it("agrees where an unmet obligation's check is still reporting it", () => {
      const reconciliation = reconcileConformanceManifest(
        [resultFor("AUD-20", "fail")],
        [obligation({ status: "partial" })],
      );
      expect(reconciliation.obligations[0]!.outcome).toBe("agrees");
      expect(manifestReconciliationFails(reconciliation)).toBe(false);
    });

    it("disagrees where an unmet obligation's every check now passes", () => {
      // The direction that catches good news. The gap closed and the manifest
      // did not move with it, which is the failure that keeps the register
      // shrinking rather than rotting into a permanent excuse.
      const reconciliation = reconcileConformanceManifest(
        [resultFor("AUD-20", "pass")],
        [obligation({ status: "absent" })],
      );
      expect(reconciliation.obligations[0]!.outcome).toBe("disagrees");
      expect(manifestReconciliationFails(reconciliation)).toBe(true);
    });

    it("disagrees where an answered obligation's check is failing", () => {
      const reconciliation = reconcileConformanceManifest(
        [resultFor("AUD-20", "fail")],
        [obligation({ status: "mechanized" })],
      );
      expect(reconciliation.obligations[0]!.outcome).toBe("disagrees");
      expect(manifestReconciliationFails(reconciliation)).toBe(true);
    });

    it("agrees where an answered obligation's check passes", () => {
      const reconciliation = reconcileConformanceManifest(
        [resultFor("AUD-20", "pass")],
        [obligation({ status: "mechanized" })],
      );
      expect(reconciliation.obligations[0]!.outcome).toBe("agrees");
    });

    it("leaves an obligation no check covers unreconciled, not agreeing", () => {
      // Counting it as agreement would report the absence of a check as a
      // check that passed, which is what `inconclusive` exists to prevent.
      const reconciliation = reconcileConformanceManifest(
        [],
        [obligation({ status: "mechanized", coveredBy: [] })],
      );
      expect(reconciliation.obligations[0]!.outcome).toBe("unreconciled");
      expect(manifestReconciliationFails(reconciliation)).toBe(false);
    });

    it("leaves an obligation unreconciled when its checks established nothing", () => {
      const reconciliation = reconcileConformanceManifest(
        [
          resultFor("AUD-20", "inconclusive"),
          resultFor("AUD-20", "not-applicable"),
        ],
        [obligation({ status: "partial" })],
      );
      expect(reconciliation.obligations[0]!.outcome).toBe("unreconciled");
    });

    it("reads the worst verdict a check reached across the runs", () => {
      // One run passing does not close a gap another run is still reporting.
      const reconciliation = reconcileConformanceManifest(
        [resultFor("AUD-20", "pass"), resultFor("AUD-20", "fail")],
        [obligation({ status: "partial" })],
      );
      expect(reconciliation.obligations[0]!.outcome).toBe("agrees");
    });
  });

  describe("against the fixture", () => {
    it("holds every covered obligation to a check that agrees with it", () => {
      const reconciliation = reconcileConformanceManifest(
        auditRunFamily(family, RUN_CHECKS),
      );
      expect(
        reconciliation.disagreements.map((one) => one.obligation.id),
      ).toEqual([]);
    });

    it("prints the position as a headline a reader cannot miss", () => {
      const position = renderConformancePosition(
        reconcileConformanceManifest(FIXTURE_RESULTS),
      );
      expect(position).toContain(
        "CfcAgentHarnessProfile is NOT satisfied by @commonfabric/cf-harness",
      );
      for (const one of CFC_HARNESS_OBLIGATIONS) {
        expect(position).toContain(one.id);
      }
    });

    it("marks the external pin as the weaker guarantee it is", () => {
      // The quotes come from another repository, so nothing here can re-read
      // the document and break when the words change. A reader has to be able
      // to tell that from a citation the drift test does guard.
      expect(
        renderConformancePosition(
          reconcileConformanceManifest(FIXTURE_RESULTS),
        ),
      ).toContain("external: not drift-guarded");
    });
  });
});
