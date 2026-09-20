/**
 * That a Group E finding says enough about itself to be recorded, and that
 * what it says is true of the message beside it.
 *
 * These checks fail by design until their defects are fixed, so a nightly
 * running the audit has to be told which of its findings were already known.
 * The register that does that reads a check id, a run selector, a substring of
 * the finding's message, a reason and an issue. Five of those six come off the
 * finding, and the one property that makes them usable is the one nothing else
 * would catch: that `detail` is genuinely a substring of `message`. An entry
 * copied from a finding whose detail was not in its message would match
 * nothing, be reported stale forever, and the fix would look like the gap
 * having closed.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  KNOWN_DEFECT_CHECKS,
  KNOWN_DEFECT_REGISTRATIONS,
} from "../checks/known-defects.ts";
import { RUN_CHECKS } from "../checks/registry.ts";
import { auditRunFamily } from "../checks/structural.ts";
import { loadRunFamily, type RunFamily } from "../evidence.ts";
import type { CheckResult } from "../report.ts";
import {
  CFC_HARNESS_OBLIGATIONS,
  reconcileConformanceManifest,
  renderConformancePosition,
  statusSatisfies,
} from "../conformance-manifest.ts";
import { FIXTURE_RUN_ID, FIXTURE_RUNS_DIR } from "./regenerate-fixtures.ts";

const family = await loadRunFamily(join(FIXTURE_RUNS_DIR, FIXTURE_RUN_ID));

/**
 * The fixture with its cell-labels snapshot removed, so AUD-24's registration
 * is exercised here too.
 *
 * The fixture keeps a snapshot, so AUD-24 passes on it and carries nothing.
 * Reading only the clean tree would leave that registration untested while
 * every assertion below still passed — over a list AUD-24 was not in.
 */
const withoutCellLabels = (): RunFamily => {
  const root = structuredClone(family.root);
  root.cellLabels = { status: "absent", path: root.cellLabels.path };
  const state = root.runState;
  if (state.status === "present") {
    delete (state.value as { cellLabels?: unknown }).cellLabels;
  }
  return { root, children: structuredClone(family.children) };
};

const RESULTS = [
  ...auditRunFamily(family, RUN_CHECKS),
  ...auditRunFamily(withoutCellLabels(), RUN_CHECKS),
];

/**
 * Every finding this fixture produced that says it is about a known defect.
 *
 * Read off the results of every registered check rather than off one group's:
 * a registration is a property of a finding, and AUD-24 carries one from
 * `structural.ts` while the Group E checks carry theirs from
 * `known-defects.ts`. Collecting them by where they were declared would leave
 * a check's registration untested the moment one was added anywhere else.
 */
const registered = (): readonly CheckResult[] =>
  RESULTS.filter((result) => result.knownDefect !== undefined);

const findings = (): readonly CheckResult[] =>
  RESULTS.filter((result) =>
    (result.verdict === "fail" || result.verdict === "warn") &&
    result.knownDefect !== undefined
  );

describe("known defects", () => {
  it("reports a finding for every registered defect", () => {
    // Without this the assertions below would hold over an empty list. The
    // fixture is a captured run of a system with all three Group E gaps in
    // it, and AUD-24 joins them on the variant with no cell-labels snapshot.
    expect(
      [...new Set(findings().map((result) => result.checkId))].sort(),
    ).toEqual(
      [...Object.keys(KNOWN_DEFECT_REGISTRATIONS), "AUD-24"].sort(),
    );
  });

  it("carries what a ledger entry needs on every finding", () => {
    expect(
      registered()
        .filter((result) =>
          result.knownDefect === undefined ||
          result.knownDefect.detail.trim() === "" ||
          result.knownDefect.runShape.trim() === "" ||
          result.knownDefect.why.trim() === "" ||
          result.knownDefect.issue.trim() === ""
        )
        .map((result) => `${result.checkId}@${result.runId}`),
    ).toEqual([]);
  });

  it("names a detail that is in the message it came with", () => {
    // The property the register rests on. A detail that is not a substring of
    // the message matches nothing, so an entry written from it is stale the
    // day it lands and the gap looks closed.
    expect(
      registered()
        .filter((result) =>
          result.knownDefect === undefined ||
          !result.message.includes(result.knownDefect.detail)
        )
        .map((result) => `${result.checkId}: ${result.message}`),
    ).toEqual([]);
  });

  it("names a detail that carries no count, so a busier run still matches", () => {
    // A message states how many side effects or bindings it found. An entry
    // matching on that stops matching the moment a run makes one more call,
    // and the finding is then reported as new. A number inside a clause id —
    // the `3` of `AH-CFC-3` — is not a count, which is why this looks for a
    // standalone one rather than for any digit.
    expect(
      registered()
        .filter((result) => /(^|\s)\d+(\s|$)/.test(result.knownDefect!.detail))
        .map((result) => result.checkId),
    ).toEqual([]);
  });

  it("names an issue that can be looked up", () => {
    // A tracker id or a URL. Which tracker is not this file's business; that
    // the work can be found is.
    expect(
      registered()
        .filter((result) =>
          !/^([A-Z][A-Z0-9]*-\d+|https?:\/\/\S+)$/.test(
            result.knownDefect!.issue,
          )
        )
        .map((result) => result.checkId),
    ).toEqual([]);
  });

  it("leaves a passing check with nothing to register", () => {
    // A registration on a `pass` would read as a defect still open on a run
    // that does not have it.
    expect(
      RESULTS
        .filter((result) =>
          result.verdict !== "fail" && result.verdict !== "warn" &&
          result.knownDefect !== undefined
        )
        .map((result) => `${result.checkId}@${result.runId}`),
    ).toEqual([]);
  });

  it("covers a registration declared outside Group E", () => {
    // A registration is a property of a finding rather than of a group.
    // AUD-24 declares its own from `structural.ts`, beside the check it was
    // split out of, and everything above has to reach it.
    expect(
      registered().some((result) => result.checkId === "AUD-24"),
    ).toBe(true);
  });
});

/**
 * The readings a Group E check reaches when the run is not the clean one.
 *
 * Each case here is a branch that decides what a check says rather than
 * whether it says it: an artifact the check needs and cannot read, a binding
 * missing a field the strengthened `AH-CFC-3` requires, and a manifest whose
 * status the covering checks contradict. None is reachable from the fixture,
 * which is why they are built rather than recorded.
 */
describe("Group E readings off the clean path", () => {
  const checkById = (id: string) => {
    const check = KNOWN_DEFECT_CHECKS.find((one) => one.id === id);
    if (check === undefined) throw new Error(`no check ${id}`);
    return check;
  };

  const withoutArtifact = (
    artifact: "runState" | "runReport",
  ): RunFamily => {
    const root = structuredClone(family.root);
    root[artifact] = { status: "absent", path: root[artifact].path };
    return { root, children: structuredClone(family.children) };
  };

  for (const id of ["AUD-21", "AUD-22", "AUD-23"]) {
    it(`${id} reports the run state it could not read rather than a verdict about the run`, () => {
      const fam = withoutArtifact("runState");
      const result = checkById(id).inspect(fam.root, fam);
      expect(result.verdict).toBe("inconclusive");
      expect(result.message).toContain("run-state.json");
    });
  }

  it("AUD-21 will not read a run's side effects out of a report it does not have", () => {
    const fam = withoutArtifact("runReport");
    const result = checkById("AUD-21").inspect(fam.root, fam);
    expect(result.verdict).toBe("inconclusive");
    expect(result.message).toContain("run-report.json");
  });

  it("AUD-22 names each field a binding is missing, not merely that one is", () => {
    const root = structuredClone(family.root);
    const state = root.runState;
    if (state.status !== "present") throw new Error("fixture has no run state");
    (state.value as { promptSlotBinding?: unknown }).promptSlotBinding = {
      role: "direct-command",
    };
    const fam: RunFamily = {
      root,
      children: structuredClone(family.children),
    };
    const result = checkById("AUD-22").inspect(fam.root, fam);
    expect(result.verdict).toBe("fail");
    const said = JSON.stringify(result.evidence);
    expect(said).toContain("a kernel name");
    expect(said).toContain("a named surface");
    expect(said).toContain("an authenticated subject");
  });

  it("AUD-23 refuses a claimed inheritance when the child's runtime ceiling widens", () => {
    const fam = structuredClone(family);
    if (
      fam.root.runState.status !== "present" ||
      fam.children[0].runState.status !== "present"
    ) {
      throw new Error("fixture has no run states");
    }
    const parent = fam.root.runState.value;
    const child = fam.children[0].runState.value;
    for (const delegation of parent.subagentRuns ?? []) {
      delegation.manifest.confidentialityCeiling = {
        source: "parent",
        mode: "bounded",
      };
    }
    parent.fabricSessionCfc = {
      enforcementMode: "enforce-strict",
      enforcementModeSource: "configured",
      flowLabels: "persist",
      flowLabelsSource: "configured",
      readMaxConfidentiality: ["did:key:owner"],
    };
    child.fabricSessionCfc = {
      ...parent.fabricSessionCfc,
      readMaxConfidentiality: undefined,
    };
    expect(checkById("AUD-23").inspect(fam.root, fam).verdict).toBe("warn");
  });

  for (const malformed of [false, true]) {
    it(`AUD-23 ${malformed ? "refuses malformed" : "verifies matching"} bounded runtime ceilings`, () => {
      const fam = withoutArtifact("runReport");
      if (fam.root.runState.status !== "present") {
        throw new Error("fixture has no parent run state");
      }
      const parent = fam.root.runState.value;
      parent.fabricSessionCfc = {
        enforcementMode: "enforce-strict",
        enforcementModeSource: "configured",
        flowLabels: "persist",
        flowLabelsSource: "configured",
        readMaxConfidentiality: ["did:key:owner"],
      };
      for (const delegation of parent.subagentRuns ?? []) {
        delegation.manifest.confidentialityCeiling = {
          source: "parent",
          mode: "bounded",
        };
      }
      for (const child of fam.children) {
        if (child.runState.status !== "present") {
          throw new Error("fixture has no child run state");
        }
        child.runState.value.fabricSessionCfc = {
          ...parent.fabricSessionCfc,
          readMaxConfidentiality: malformed
            ? [""]
            : [...parent.fabricSessionCfc.readMaxConfidentiality!],
        };
      }
      expect(checkById("AUD-23").inspect(fam.root, fam).verdict).toBe(
        malformed ? "warn" : "pass",
      );
    });
  }

  it("reads delegations from the run state alone when the report is gone, and claims no divergence", () => {
    // Divergence is a comparison, so an artifact that is absent is not an
    // artifact that disagrees. The check still has the run state's
    // delegations and still reports on their ceilings; what it must not do is
    // read a missing second opinion as a conflicting one.
    const fam = withoutArtifact("runReport");
    const result = checkById("AUD-23").inspect(fam.root, fam);
    expect(result.verdict).toBe("warn");
    expect(JSON.stringify(result.evidence)).not.toContain("has lost a child");
  });

  it("skips an activity that carries no prompt slot rather than counting it", () => {
    // An activity without a binding is not a binding without a subject. The
    // adder drops it, so a run whose tools mostly carry no slot does not read
    // as a run minting authority it never claimed.
    const root = structuredClone(family.root);
    const report = root.runReport;
    if (report.status !== "present") throw new Error("fixture has no report");
    const activities =
      (report.value as { toolActivity?: { promptSlot?: unknown }[] })
        .toolActivity ?? [];
    for (const activity of activities) delete activity.promptSlot;
    const fam: RunFamily = {
      root,
      children: structuredClone(family.children),
    };
    const result = checkById("AUD-22").inspect(fam.root, fam);
    expect(["fail", "not-applicable"]).toContain(result.verdict);
  });

  it("counts one binding once, however many artifacts carry it", () => {
    const root = structuredClone(family.root);
    const state = root.runState;
    const report = root.runReport;
    if (state.status !== "present" || report.status !== "present") {
      throw new Error("fixture is missing an artifact this case needs");
    }
    // The same binding, recorded in both places a run records one. A count
    // that grew with the number of artifacts carrying a binding would report
    // one run's single authority as several.
    const binding = { role: "direct-command", kernelName: "seeded" };
    (state.value as { promptSlotBinding?: unknown }).promptSlotBinding =
      binding;
    for (
      const activity of (report.value as {
        toolActivity?: { promptSlot?: unknown }[];
      }).toolActivity ?? []
    ) {
      activity.promptSlot = structuredClone(binding);
    }
    const trace = root.policyTrace;
    if (trace.status === "present") {
      for (
        const decision of (trace.value as unknown as {
          decisions?: { promptSlot?: unknown }[];
        }).decisions ?? []
      ) {
        decision.promptSlot = structuredClone(binding);
      }
    }
    const fam: RunFamily = {
      root,
      children: structuredClone(family.children),
    };
    const result = checkById("AUD-22").inspect(fam.root, fam);
    expect(result.verdict).toBe("fail");
    expect(result.message).toContain("1 binding");
  });

  it("the position says the manifest and its checks disagree, and how many times", () => {
    const obligation = CFC_HARNESS_OBLIGATIONS.find((one) =>
      one.coveredBy.length > 0
    );
    if (obligation === undefined) {
      throw new Error("no obligation names a covering check");
    }
    const contradicting: CheckResult[] = [{
      checkId: obligation.coveredBy[0],
      title: "contradicts the manifest",
      verdict: statusSatisfies(obligation.status) ? "fail" : "pass",
      message: "seeded to disagree",
      citations: [],
      evidence: [],
      runId: FIXTURE_RUN_ID,
      runDir: FIXTURE_RUNS_DIR,
    }];
    const reconciliation = reconcileConformanceManifest(contradicting);
    expect(reconciliation.disagreements.length).toBeGreaterThan(0);
    expect(renderConformancePosition(reconciliation)).toContain(
      "disagree with the checks covering them",
    );
  });
});
