/**
 * The session posture a run records, and the lines a surface prints from it.
 *
 * The projection is the part worth pinning: it is what the console and the run
 * state publish before the session's runtime exists, and it says so. The
 * renderer is pinned because it is the only form most operators ever see the
 * record in — an ungated sink that did not reach the output is a gap nobody
 * reads about.
 *
 * The itemized dials belong here too — the enforcement rung, the flow-label
 * rung, and where the flow-label rung came from. A run records each beside the
 * record, from the same configuration, and an audit reads both.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { presetCfcOptions } from "@commonfabric/runner";
import { RUNTIME_CFC_DIAL_DEFAULTS } from "@commonfabric/runner/cfc";

import {
  harnessFabricSessionPosture,
  harnessFabricSessionPostureBanner,
  renderCfcPostureReport,
} from "../src/cfc-posture.ts";
import {
  fabricSessionCfcEnforcementMode,
  fabricSessionCfcFlowLabels,
  fabricSessionCfcFlowLabelsSource,
  type HarnessFabricCfcFlowLabelsMode,
} from "../src/config.ts";

const SESSION = {
  apiUrl: "https://toolshed.example/",
  identityKeyPath: "/keys/agent.pkcs8",
  space: "my-space",
} as const;

/**
 * Every configuration of the two dials that decide a session's flow-label
 * rung: the named bundle it selects, and the rung it states itself.
 */
const SESSIONS = ([undefined, "max-enforcement"] as const).flatMap(
  (cfcPosture) =>
    ([undefined, "off", "observe", "persist"] as const).map((
      cfcFlowLabels,
    ) => ({
      ...SESSION,
      ...(cfcPosture !== undefined ? { cfcPosture } : {}),
      ...(cfcFlowLabels !== undefined ? { cfcFlowLabels } : {}),
    })),
);

describe("cfc-posture", () => {
  describe("harnessFabricSessionPosture()", () => {
    it("marks the record a projection, never an attestation", () => {
      // The session's runtime is built lazily and may never be built at all,
      // so what this returns is what the run expects to be at.
      expect(harnessFabricSessionPosture(SESSION).provenance).toBe("projected");
    });

    it("marks a rung that decides nothing as diagnostic-only, and carries no digest without a policy", () => {
      // `off` is the rung the first two assertions read. Whether a dial is
      // diagnostic-only is derived from its rung rather than stated, and a
      // session selecting no bundle configures no policy records, so there
      // is no snapshot for a digest to be taken of.
      const record = harnessFabricSessionPosture({
        ...SESSION,
        cfcFlowLabels: "off",
      });
      expect(record.flowLabels.rung).toBe("off");
      expect(record.flowLabels.diagnosticOnly).toBe(true);
      expect(record.policyDigest).toBe(null);
    });

    it("resolves the named bundle's dials when the session selects it", () => {
      const record = harnessFabricSessionPosture({
        ...SESSION,
        cfcPosture: "max-enforcement",
      });
      expect(record.flowLabels.rung).toBe("persist");
      expect(record.writeFloor.rung).toBe("enforce");
      expect(record.triggerReadGating).toBe(true);
      expect(record.policyEvaluation.diagnosticOnly).toBe(false);
      expect(typeof record.policyDigest).toBe("string");
    });

    it("lets a session dial win over the bundle it opted into", () => {
      const record = harnessFabricSessionPosture({
        ...SESSION,
        cfcPosture: "max-enforcement",
        // The two rungs the assertions below read back.
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "observe",
      });
      expect(record.enforcementMode.rung).toBe("enforce-strict");
      expect(record.flowLabels.rung).toBe("observe");
    });

    it("publishes every ungated sink as a deviation under the bundle", () => {
      // The four llm-class sinks and `sqliteQuery`, each carrying the owner
      // AH-CFC-15 asks a published deviation for.
      const record = harnessFabricSessionPosture({
        ...SESSION,
        cfcPosture: "max-enforcement",
      });
      expect(record.deviations.map((deviation) => deviation.owner.length > 0))
        .toEqual([true, true, true, true, true]);
    });
  });

  describe("fabricSessionCfcEnforcementMode()", () => {
    it("leaves the dial on the pin under the named bundle", () => {
      // The bundle sets every other staged enforcement dial and this one it
      // leaves alone.
      expect(
        fabricSessionCfcEnforcementMode({
          ...SESSION,
          cfcPosture: "max-enforcement",
        }),
      ).toBe(presetCfcOptions({}).cfcEnforcementMode);
    });

    it("names the rung the session states", () => {
      expect(
        fabricSessionCfcEnforcementMode({
          ...SESSION,
          cfcEnforcementMode: "enforce-strict",
        }),
      ).toBe("enforce-strict");
    });

    it("agrees with the record the same configuration projects", () => {
      // A run records both from the same config: the itemized dial an audit
      // compares against, and the whole record beside it. Each rung below is
      // the one both sides of the assertion read back.
      for (
        const session of [
          SESSION,
          { ...SESSION, cfcEnforcementMode: "enforce-strict" as const },
        ]
      ) {
        expect(fabricSessionCfcEnforcementMode(session)).toBe(
          harnessFabricSessionPosture(session).enforcementMode.rung,
        );
      }
    });
  });

  describe("fabricSessionCfcFlowLabels()", () => {
    it("returns the rung the named bundle supplies", () => {
      expect(
        fabricSessionCfcFlowLabels({
          ...SESSION,
          cfcPosture: "max-enforcement",
        }),
      ).toBe(presetCfcOptions({ cfcPosture: "max-enforcement" }).cfcFlowLabels);
    });

    it("returns the runtime's own default when nothing states the dial", () => {
      expect(fabricSessionCfcFlowLabels(SESSION)).toBe(
        RUNTIME_CFC_DIAL_DEFAULTS.cfcFlowLabels,
      );
    });

    it("returns the rung the session states over the bundle's", () => {
      expect(
        fabricSessionCfcFlowLabels({
          ...SESSION,
          cfcPosture: "max-enforcement",
          // `off` is the rung the assertion below reads back.
          cfcFlowLabels: "off",
        }),
      ).toBe("off");
    });

    it("throws naming the ladder for a rung outside it", () => {
      // A value outside the ladder reaches a session config only from a
      // caller the type checker never saw. The record has no rung to state
      // for it, and the run that would carry one is refused instead. Where
      // the run holds the whole record beside this dial, the record's own
      // resolution refuses first; where a host supplied the session factory,
      // there is no record and this is the only reader.

      expect(() =>
        fabricSessionCfcFlowLabels({
          ...SESSION,
          cfcFlowLabels: "persistt" as HarnessFabricCfcFlowLabelsMode,
        })
      ).toThrow("off, observe, persist");
    });

    it("returns the rung the record projected from that configuration carries", () => {
      // A run records both from the same configuration: the itemized dial an
      // audit compares against, and the whole record beside it. Every
      // configuration of the two dials that reach this one, rather than a
      // chosen few.

      for (const session of SESSIONS) {
        expect(fabricSessionCfcFlowLabels(session)).toBe(
          harnessFabricSessionPosture(session).flowLabels.rung,
        );
      }
    });
  });

  describe("fabricSessionCfcFlowLabelsSource()", () => {
    it("returns `configured` when the session states the dial", () => {
      // `off` is what the runtime also defaults to, so a source read off the
      // rung rather than the configuration would say `default` here. Both
      // ways round on the bundle, which the stated dial outranks either way.

      for (const bundle of [{}, { cfcPosture: "max-enforcement" as const }]) {
        expect(
          fabricSessionCfcFlowLabelsSource({
            ...SESSION,
            ...bundle,
            cfcFlowLabels: "off",
          }),
        ).toBe("configured");
      }
    });

    it("returns `posture` when only the named bundle supplies the dial", () => {
      expect(
        fabricSessionCfcFlowLabelsSource({
          ...SESSION,
          cfcPosture: "max-enforcement",
        }),
      ).toBe("posture");
    });

    it("returns `default` when neither the session nor a bundle states the dial", () => {
      expect(fabricSessionCfcFlowLabelsSource(SESSION)).toBe("default");
    });
  });

  describe("renderCfcPostureReport()", () => {
    const rendered = (
      posture: Parameters<typeof harnessFabricSessionPosture>[0],
    ) =>
      renderCfcPostureReport(harnessFabricSessionPosture(posture)).join("\n");

    it("says a projected record is not an attestation", () => {
      expect(rendered(SESSION)).toContain("not what one attested");
    });

    it("says nothing of the kind for a resolved record", () => {
      const record = harnessFabricSessionPosture(SESSION);
      expect(
        renderCfcPostureReport({ ...record, provenance: "resolved" }).join(
          "\n",
        ),
      ).not.toContain("not what one attested");
    });

    it("marks a diagnostic rung as deciding nothing", () => {
      // `off` is the rung the assertion reads back.
      expect(rendered({ ...SESSION, cfcFlowLabels: "off" })).toContain(
        "off (diagnostic only) — decides on",
      );
    });

    it("prints every ungated sink with the reason it releases ungated", () => {
      const text = rendered({ ...SESSION, cfcPosture: "max-enforcement" });
      for (
        const sink of ["llm", "llmDialog", "generateText", "generateObject"]
      ) {
        expect(text).toContain(`sink ${sink}`);
      }
      expect(text).toContain("UNGATED —");
    });

    it("prints a ceilinged sink as public only when its ceiling is empty", () => {
      expect(rendered({ ...SESSION, cfcPosture: "max-enforcement" }))
        .toContain("public only");
    });

    it("prints every sink of an unconfigured deployment, not an empty list", () => {
      const text = rendered(SESSION);
      for (const sink of ["fetchText", "fetchJson", "streamData", "llm"]) {
        expect(text).toContain(`sink ${sink}`);
      }
    });

    it("prints each deviation with its owner and what retires it", () => {
      const text = rendered({ ...SESSION, cfcPosture: "max-enforcement" });
      expect(text).toContain("deviation:");
      expect(text).toContain("owner:");
      expect(text).toContain("retires when:");
    });
  });

  describe("harnessFabricSessionPostureBanner()", () => {
    it("opens with the bundle the console opted into", () => {
      expect(
        harnessFabricSessionPostureBanner({
          ...SESSION,
          cfcPosture: "max-enforcement",
        })[0],
      ).toContain("max-enforcement");
    });

    it("names the fleet posture when the console opted into no bundle", () => {
      expect(harnessFabricSessionPostureBanner(SESSION)[0]).toContain(
        "first-party default",
      );
    });

    it("carries the whole record under that opening line", () => {
      // What an operator reads at startup is the banner, so the record
      // reaching it is the property — a bundle name over an unprinted record
      // says a deployment is enforcing without showing what.
      const banner = harnessFabricSessionPostureBanner({
        ...SESSION,
        cfcPosture: "max-enforcement",
      });
      expect(banner.slice(1)).toEqual(
        renderCfcPostureReport(
          harnessFabricSessionPosture({
            ...SESSION,
            cfcPosture: "max-enforcement",
          }),
        ),
      );
    });
  });
});
