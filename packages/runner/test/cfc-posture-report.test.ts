/**
 * The one posture record, and the property that makes it worth having: a
 * surface that projects a runtime's posture before the runtime exists — a
 * console printing at startup, a harness recording a lazily-built session —
 * must arrive at the record the constructed runtime does.
 *
 * The parity assertions construct a real `Runtime` from each preset and
 * compare its record against the projection built from that preset's options
 * alone. A default the projection restates in its own words rather than
 * reading from the shared table fails here the moment the two disagree,
 * which is the whole reason the table is shared.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  CFC_ENFORCEMENT_MODES,
  type CfcEnforcementMode,
  type CfcPostureOptions,
  cfcPostureReport,
  inheritedCfcPostureReport,
  KNOWN_SINKS,
  projectedCfcPostureReport,
  resolveCfcDials,
  type ResolvedCfcDials,
  RUNTIME_CFC_DIAL_DEFAULTS,
} from "../src/cfc/mod.ts";
import type { RuntimeOptions } from "../src/runtime.ts";
import { presetCfcOptions, runtimePresets } from "../src/runtime-presets.ts";
import { Runtime, signer, StorageManager } from "./engine-test-support.ts";

/** The record a surface projects from options alone, with no Runtime. */
const projected = (options: RuntimeOptions) =>
  projectedCfcPostureReport(options);

/**
 * One dial set to `value` by a caller the type system never saw: an
 * initialization message across a worker boundary, a command line, the CFC
 * section of a JSON manifest. The cast is what those callers do implicitly,
 * written out so the tests below can hand over the values they hand over.
 */
const stated = (dial: string, value: unknown): CfcPostureOptions =>
  ({ [dial]: value }) as CfcPostureOptions;

describe("the CFC posture record", () => {
  describe("dial rendering", () => {
    it("marks an observe rung as deciding nothing", () => {
      const record = cfcPostureReport({
        ...RUNTIME_CFC_DIAL_DEFAULTS,
        // The assertions below read this rung back out of the record and
        // check that it decides nothing.
        cfcPolicyEvaluation: "observe",
        cfcPolicySnapshot: undefined,
        cfcSinkMaxConfidentiality: {},
      });
      expect(record.policyEvaluation.rung).toBe("observe");
      expect(record.policyEvaluation.diagnosticOnly).toBe(true);
      expect(record.policyEvaluation.decidesOn).toContain("un-rewritten");
    });

    it("marks an enforcing rung as deciding on something", () => {
      const record = cfcPostureReport({
        ...RUNTIME_CFC_DIAL_DEFAULTS,
        // The assertions below check that this rung decides on the rewritten
        // label rather than only reporting.
        cfcPolicyEvaluation: "enforce",
        cfcPolicySnapshot: undefined,
        cfcSinkMaxConfidentiality: {},
      });
      expect(record.policyEvaluation.diagnosticOnly).toBe(false);
      expect(record.policyEvaluation.decidesOn).toContain("rewritten label");
    });
  });

  describe("the dial ladders", () => {
    // A dial off its ladder splits the runtime in two. The consumers of the
    // named-rung dials test for one rung — `writeFloorMode === "enforce"`,
    // `flowLabelsMode === "persist"` — while the guards around them test only
    // for `!== "off"`, so an unrecognized name enters the block and then
    // decides nothing, running as `observe` does. The record published at
    // `/api/meta` says the opposite: `diagnosticOnly` is false, because the
    // name is not one of the diagnostic rungs either, and `decidesOn` is
    // absent, which `CfcDialReport` declares a `string`. The two on-or-off
    // dials part the other way round: the gates read them for truthiness
    // while the record tests for `true`, so a truthy value that is not `true`
    // runs the gate while the record says the gate is off.

    // Written as a record over every dial, so a dial added to
    // `ResolvedCfcDials` is a type error here until it has a case of its own.
    const offLadder: Record<keyof ResolvedCfcDials, unknown> = {
      cfcEnforcementMode: "enforce-strictly",
      cfcFlowLabels: "persisted",
      cfcWriteFloor: "enfroce",
      cfcPolicyEvaluation: "enforcing",
      cfcLabelMetadataProtection: "observing",
      cfcDeclaredMonotonicity: "on",
      cfcTriggerReadGating: "true",
      cfcDecomposedEnvelopes: 1,
      cfcContentAddressedLabels: 1,
    };

    for (const [dial, value] of Object.entries(offLadder)) {
      it(`throws when a projection states a \`${dial}\` off its ladder`, () => {
        expect(() => projectedCfcPostureReport(stated(dial, value))).toThrow(
          new RegExp("^Runtime `" + dial + "` is "),
        );
      });
    }

    it("names the rungs it would have taken", () => {
      expect(() =>
        projectedCfcPostureReport(stated("cfcWriteFloor", "enfroce"))
      )
        .toThrow(
          'Runtime `cfcWriteFloor` is "enfroce", not one of off, observe, enforce',
        );
      expect(() =>
        projectedCfcPostureReport(stated("cfcTriggerReadGating", "true"))
      ).toThrow(
        'Runtime `cfcTriggerReadGating` is "true", not one of true, false',
      );
    });

    it("throws on a `null`, which no dial has a rung for", () => {
      // `null` is not an unset dial. The option type has no `null` member, so
      // one that arrives came from a caller the types did not reach, and
      // resolving it to the default would give that caller a posture it never
      // stated.
      expect(() => projectedCfcPostureReport(stated("cfcFlowLabels", null)))
        .toThrow(/^Runtime `cfcFlowLabels` is null, /);
    });

    it("throws on a value that merely renders as a rung", () => {
      // A rung is the string, not everything that prints as it. Every consumer
      // compares the dial against a rung with `===`, so a one-element array or
      // a boxed string decides nothing while carrying the rung's name into the
      // published record.
      for (
        const lookalike of [
          ["enforce"],
          new String("enforce"),
          { toString: () => "enforce" },
        ]
      ) {
        expect(() =>
          projectedCfcPostureReport(stated("cfcWriteFloor", lookalike))
        ).toThrow(/^Runtime `cfcWriteFloor` is /);
      }
    });

    it("returns a stated rung that is not the default", () => {
      // Both dials are read back out of the record below, so the refusals
      // above are held to accepting the values a deployment does state.
      const record = projectedCfcPostureReport({
        cfcWriteFloor: "enforce",
        cfcTriggerReadGating: true,
      });
      expect(record.writeFloor.rung).toBe("enforce");
      expect(record.writeFloor.diagnosticOnly).toBe(false);
      expect(record.triggerReadGating).toBe(true);
    });

    describe("a constructed Runtime", () => {
      let storageManager: ReturnType<typeof StorageManager.emulate>;

      beforeEach(() => {
        storageManager = StorageManager.emulate({ as: signer });
      });

      afterEach(async () => {
        await storageManager.close();
      });

      const construct = (options: CfcPostureOptions) =>
        new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
          ...options,
        });

      it("throws on a string dial off its ladder", () => {
        expect(() => construct(stated("cfcWriteFloor", "enfroce"))).toThrow(
          /^Runtime `cfcWriteFloor` is /,
        );
      });

      it("throws on a boolean dial that is neither `true` nor `false`", () => {
        expect(() => construct(stated("cfcTriggerReadGating", "true"))).toThrow(
          /^Runtime `cfcTriggerReadGating` is /,
        );
      });

      it("constructs on `enforce-strict`, `enforce` and `true`", async () => {
        // The refusals above are worth nothing if a rung is refused too, and
        // these are the settings a deployment states by hand. The claim is
        // about these three: the ladders are not exported rung by rung, so a
        // case here cannot exhaust them.
        const runtime = construct({
          cfcEnforcementMode: "enforce-strict",
          cfcWriteFloor: "enforce",
          cfcDecomposedEnvelopes: true,
        });
        try {
          expect(cfcPostureReport(runtime).writeFloor.rung).toBe("enforce");
          expect(cfcPostureReport(runtime).decomposedEnvelopes).toBe(true);
        } finally {
          await runtime.dispose();
        }
      });
    });
  });

  describe("inheritance", () => {
    it("carries every value of the parent's record across, and only restamps it", () => {
      // A host running on another host's runtime publishes that runtime's
      // posture. Recomputing the values would be a second reading that can
      // disagree with the first, which is what the one record exists to rule
      // out.
      const parent = projectedCfcPostureReport(
        presetCfcOptions({ cfcPosture: "max-enforcement" }),
      );
      const inherited = inheritedCfcPostureReport(parent);
      expect(inherited.provenance).toBe("inherited");
      expect(inherited).toEqual({ ...parent, provenance: "inherited" });
    });

    it("stamps a resolved parent's record the same way", async () => {
      // A resolved parent's record is an attestation, and the inheriting
      // host carries the attested values across the way it carries projected
      // ones.
      const options = runtimePresets.remoteClient({
        apiUrl: new URL(import.meta.url),
        storageManager: StorageManager.emulate({ as: signer }),
        experimental: {},
        cfcPosture: "max-enforcement",
      });
      const runtime = new Runtime(options);
      try {
        const parent = cfcPostureReport(runtime);
        expect(inheritedCfcPostureReport(parent)).toEqual({
          ...parent,
          provenance: "inherited",
        });
      } finally {
        await runtime.dispose();
        await options.storageManager.close();
      }
    });
  });

  describe("sink governance", () => {
    it("lists every known sink, ungated ones included", () => {
      const record = cfcPostureReport({
        ...RUNTIME_CFC_DIAL_DEFAULTS,
        cfcPolicySnapshot: undefined,
        cfcSinkMaxConfidentiality: { fetchText: [] },
      });
      expect(record.sinks.map((sink) => sink.sink)).toEqual([...KNOWN_SINKS]);
      const fetchText = record.sinks.find((sink) => sink.sink === "fetchText");
      expect(fetchText).toEqual({ sink: "fetchText", ceiling: [] });
      const fetchJson = record.sinks.find((sink) => sink.sink === "fetchJson");
      expect(fetchJson).toEqual({
        sink: "fetchJson",
        ungated: "no confidentiality ceiling is configured for this sink",
      });
    });

    it("publishes a deliberately ungated sink as a deviation with an owner and a retirement", () => {
      const record = cfcPostureReport({
        ...RUNTIME_CFC_DIAL_DEFAULTS,
        cfcPolicySnapshot: undefined,
        cfcSinkMaxConfidentiality: {},
      });
      const llm = record.deviations.filter((deviation) =>
        deviation.what.includes("`llm`")
      );
      expect(llm.length).toBe(1);
      expect(llm[0]!.owner.length).toBeGreaterThan(0);
      expect(llm[0]!.retirement.length).toBeGreaterThan(0);
    });

    it("reports no deviation for a sink the deployment ceilings", () => {
      const record = cfcPostureReport({
        ...RUNTIME_CFC_DIAL_DEFAULTS,
        cfcPolicySnapshot: undefined,
        cfcSinkMaxConfidentiality: { llm: [], llmDialog: [] },
      });
      expect(
        record.deviations.map((deviation) => deviation.what).filter((what) =>
          what.includes("`llm`") || what.includes("`llmDialog`")
        ),
      ).toEqual([]);
    });
  });

  describe("the write floor beside the flow dial", () => {
    // The floor credits the flow meet only where labels persist, so a
    // deployment holding an enforcing floor below that rung turns away
    // writes the join would have endorsed (ordering constraint 3,
    // docs/specs/cfc-enforcement-matrix.md §2).

    it("holds the floor at `enforce` where the flow dial is left alone", () => {
      expect(presetCfcOptions({}).cfcWriteFloor).toBe("enforce");
      expect(presetCfcOptions({ cfcFlowLabels: "persist" }).cfcWriteFloor).toBe(
        "enforce",
      );
    });

    it("drops the floor to `observe` where a caller puts flow labels below persist", () => {
      expect(presetCfcOptions({ cfcFlowLabels: "observe" }).cfcWriteFloor).toBe(
        "observe",
      );
      expect(presetCfcOptions({ cfcFlowLabels: "off" }).cfcWriteFloor).toBe(
        "observe",
      );
    });

    it("drops the floor under the max-enforcement bundle too, which pins it", () => {
      expect(
        presetCfcOptions({
          cfcPosture: "max-enforcement",
          cfcFlowLabels: "off",
        }).cfcWriteFloor,
      ).toBe("observe");
    });
  });

  describe("the enforcement-mode ladder", () => {
    const offLadder = "enforce-strictly" as CfcEnforcementMode;

    it("refuses a name off the ladder, naming it and the ladder", () => {
      const refusal = expect(() =>
        resolveCfcDials({ cfcEnforcementMode: offLadder })
      );
      refusal.toThrow(offLadder);
      refusal.toThrow(CFC_ENFORCEMENT_MODES.join(", "));
    });

    it("resolves every name on the ladder", () => {
      for (const mode of CFC_ENFORCEMENT_MODES) {
        expect(resolveCfcDials({ cfcEnforcementMode: mode }))
          .toMatchObject({ cfcEnforcementMode: mode });
      }
    });

    it("defaults a construction that names no mode", () => {
      expect(resolveCfcDials({}).cfcEnforcementMode).toBe(
        RUNTIME_CFC_DIAL_DEFAULTS.cfcEnforcementMode,
      );
    });

    it("refuses a null, which names no member of the ladder", () => {
      expect(() =>
        resolveCfcDials({ cfcEnforcementMode: null as unknown as undefined })
      ).toThrow(CFC_ENFORCEMENT_MODES.join(", "));
    });

    it("refuses to construct a Runtime on a name off the ladder", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      try {
        expect(() =>
          new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager,
            cfcEnforcementMode: offLadder,
          })
        ).toThrow(offLadder);
      } finally {
        await storageManager.close();
      }
    });

    it("refuses to project a posture on a name off the ladder", () => {
      // A posture record is published before its runtime exists, so a
      // projection that answered here would announce a rung nothing runs at.
      expect(() => projectedCfcPostureReport({ cfcEnforcementMode: offLadder }))
        .toThrow(offLadder);
    });
  });

  describe("parity with a constructed Runtime", () => {
    const emulated = () => StorageManager.emulate({ as: signer });
    const cases: readonly [string, () => RuntimeOptions][] = [
      ["unitTest", () =>
        runtimePresets.unitTest({
          apiUrl: new URL(import.meta.url),
          storageManager: emulated(),
        })],
      ["unitTest under max-enforcement", () =>
        runtimePresets.unitTest({
          apiUrl: new URL(import.meta.url),
          storageManager: emulated(),
          cfcPosture: "max-enforcement",
        })],
      ["remoteClient", () =>
        runtimePresets.remoteClient({
          apiUrl: new URL(import.meta.url),
          storageManager: emulated(),
          experimental: {},
        })],
      [
        // This case hands the preset an enforcement mode. The parity
        // assertion then covers a caller-supplied rung reaching both the
        // constructed Runtime and the projection.
        "remoteClient under max-enforcement, raised to strict",
        () =>
          runtimePresets.remoteClient({
            apiUrl: new URL(import.meta.url),
            storageManager: emulated(),
            experimental: {},
            cfcPosture: "max-enforcement",
            cfcEnforcementMode: "enforce-strict",
          }),
      ],
      ["productionServer", () =>
        runtimePresets.productionServer({
          apiUrl: new URL(import.meta.url),
          storageManager: emulated(),
          experimental: {},
        })],
      ["browserWorker", () =>
        runtimePresets.browserWorker({
          apiUrl: new URL(import.meta.url),
          storageManager: emulated(),
          experimental: {},
        })],
      ["patternTest", () =>
        runtimePresets.patternTest({
          apiUrl: new URL(import.meta.url),
          storageManager: emulated(),
          experimental: {},
        })],
    ];

    for (const [name, build] of cases) {
      it(`${name} projects the record its Runtime resolves`, async () => {
        // Every value equal, and exactly one field not: the projection says it
        // is a projection. That difference is the point of the field, so the
        // comparison names it rather than stripping it — a projection that
        // deep-equalled an attestation would be one nothing could tell apart.
        const options = build();
        const runtime = new Runtime(options);
        try {
          const resolved = cfcPostureReport(runtime);
          const prediction = projected(options);
          expect(resolved.provenance).toBe("resolved");
          expect(prediction.provenance).toBe("projected");
          expect(resolved).toEqual({ ...prediction, provenance: "resolved" });
        } finally {
          await runtime.dispose();
          await options.storageManager.close();
        }
      });
    }

    it("projects the same record from the preset's CFC options alone", () => {
      // What a host with no storage manager to spare can reach: the CFC
      // options a preset composes are pure, so a surface that has only a
      // session's dials still lands on the record.
      const options = runtimePresets.remoteClient({
        apiUrl: new URL(import.meta.url),
        storageManager: emulated(),
        experimental: {},
        cfcPosture: "max-enforcement",
      });
      expect(projected(options)).toEqual(
        projectedCfcPostureReport(
          presetCfcOptions({ cfcPosture: "max-enforcement" }),
        ),
      );
    });
  });
});
