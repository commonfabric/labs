/**
 * The max-enforcement CFC posture as one running system, complementing the
 * preset goldens in `runtime-presets.test.ts`, which pin the bundle's SHAPE.
 * A dial can load and run without ever demonstrably firing in an ordinary
 * flow — "on and silent" is not "verified enforcing" — so each test here
 * makes one of them decide an outcome that the same flow without the dial
 * would decide the other way:
 *
 * - policy evaluation: an egress fits the bundle's public-only network
 *   ceiling ONLY because the §10.1 value-screened discharge dropped the
 *   caveat clause first — and refuses without the screening evidence;
 * - trigger-read gating: a scheduled egress that never re-reads the secret
 *   that triggered it is still held to the sink ceiling;
 * - refusal-as-event: the ceiling refusal of a reactive action's commit is
 *   terminal and reaches the scheduler's error channel with its reasons,
 *   rather than reading as a healthy, quietly empty piece.
 */

import { describe, it } from "@std/testing/bdd";

import { expect } from "@std/expect";
import { CFC_CONCEPT_KIND, cfcAtom } from "@commonfabric/api/cfc";
import { internSchema } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import {
  MAX_ENFORCEMENT_SINK_GOVERNANCE,
  runtimePresets,
} from "../src/runtime-presets.ts";
import { KNOWN_SINKS } from "../src/cfc/sink-inventory.ts";
import { enqueueSinkRequestPostCommitEffect } from "../src/cfc/sink-request.ts";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import type { JSONSchema, JSONValue } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import type { IFCLabel } from "../src/cfc/mod.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import type { Action, ErrorWithContext } from "../src/scheduler.ts";
import { seedStoredEnvelope } from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("runner-max-enforcement-posture");

const makePostureRuntime = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
  errorHandlers?: ((error: ErrorWithContext) => void)[],
) =>
  new Runtime(runtimePresets.unitTest({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcPosture: "max-enforcement",
    ...(errorHandlers !== undefined ? { errorHandlers } : {}),
  }));

const SOURCE_SCHEMA = internSchema(
  {
    type: "object",
    properties: { secret: { type: "string" } },
    required: ["secret"],
  } satisfies JSONSchema,
  true,
);

/**
 * Seed a cell whose `/secret` carries `label` as persisted store-policy
 * metadata — integrity evidence included, which is how screening evidence
 * actually travels with a value (a schema `ifc` declaration carries only the
 * declared components, not per-value evidence). The seed itself commits under
 * the full bundle, so the posture's metadata-protection and monotonicity
 * dials sign off on it too.
 */
const seedSource = async (
  runtime: Runtime,
  id: string,
  label: IFCLabel,
): Promise<Cell<{ secret: string }>> => {
  const tx = runtime.edit();
  const source = runtime.getCell<{ secret: string }>(
    signer.did(),
    id,
    SOURCE_SCHEMA.schema,
    tx,
  );
  const sourceId = source.getAsNormalizedFullLink().id;
  seedStoredEnvelope(tx, {
    space: signer.did(),
    scope: "space",
    id: sourceId,
    path: [],
  }, {
    value: { secret: "rosebud" },
    cfc: {
      version: 1,
      schemaHash: SOURCE_SCHEMA.taggedHashString,
      labelMap: { version: 1, entries: [{ path: ["secret"], label }] },
    },
  });
  tx.writeOrThrow({
    space: signer.did(),
    scope: "space",
    id: `cid:${SOURCE_SCHEMA.taggedHashString}`,
    path: [],
  }, { value: SOURCE_SCHEMA.schema });
  expect((await tx.commit()).error).toBeUndefined();
  return source;
};

/**
 * One egress attempt: read the labeled source, enqueue a sink request,
 * prepare, and hand back the prepare refusal reasons (empty when the request
 * fits). Aborts rather than commits — the verdict under test is prepare's.
 */
const readThenEgress = (
  runtime: Runtime,
  source: Cell<{ secret: string }>,
  sink = "fetchText",
): string[] => {
  const tx = runtime.edit();
  expect(source.withTx(tx).get()?.secret).toBe("rosebud");
  enqueueSinkRequestPostCommitEffect(
    tx,
    sink,
    `${sink}:max-enforcement-posture`,
    createFrozenRequestSnapshot({ url: "https://example.com/exfil" }),
    `${sink}-start`,
    () => {},
  );
  tx.prepareCfc();
  const state = tx.getCfcState();
  const reasons = state.prepare.status === "invalidated"
    ? [...state.prepare.reasons]
    : [];
  tx.abort();
  return reasons;
};

const withPostureRuntime = async (
  body: (runtime: Runtime, space: MemorySpace) => Promise<void>,
  errorHandlers?: ((error: ErrorWithContext) => void)[],
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = makePostureRuntime(storageManager, errorHandlers);
  try {
    await body(runtime, signer.did());
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

describe("max-enforcement CFC posture as one system", () => {
  describe("policy evaluation decides an egress under the bundle", () => {
    const source = "of:screened-ingest";
    const valueScreenedCaveat = cfcAtom.caveat(
      CFC_CONCEPT_KIND.PromptInjectionRiskValueScreened,
      source,
    ) as JSONValue;
    const freshValueEvidence = cfcAtom.caveatScreened({
      kind: CFC_CONCEPT_KIND.PromptInjectionRiskValueScreened,
      source,
      stage: "value",
      detector: cfcAtom.builtin("detector"),
      verdict: "pass",
      valueRef: { "/": "value-doc" },
    }) as JSONValue;

    it("admits a screened value: the §10.1 discharge is what fits the public-only ceiling", async () => {
      await withPostureRuntime(async (runtime) => {
        const cell = await seedSource(
          runtime,
          "posture-screened-source",
          {
            confidentiality: [valueScreenedCaveat],
            integrity: [freshValueEvidence],
          },
        );
        // The raw label carries the caveat, which the empty `fetchText`
        // ceiling admits nothing of. Fitting is only possible because the
        // bundle's policy records ran and the value-stage evidence
        // discharged the clause — the dial demonstrably fired.
        expect(readThenEgress(runtime, cell)).toEqual([]);
      });
    });

    it("refuses the same egress without the screening evidence", async () => {
      await withPostureRuntime(async (runtime) => {
        const cell = await seedSource(
          runtime,
          "posture-unscreened-source",
          { confidentiality: [valueScreenedCaveat] },
        );
        const reasons = readThenEgress(runtime, cell);
        expect(reasons.length).toBeGreaterThan(0);
        expect(reasons.join("\n")).toContain(
          "exceeds ceiling for fetchText",
        );
      });
    });
  });

  describe("the llm sinks are ungoverned by the posture", () => {
    it("decides every known sink, ceiling or explicitly ungated", () => {
      // Totality is the property, not the contents: a sink the registry does
      // not decide about is a sink that releases ungated without anyone
      // having chosen that, and its absence from the ceilings map reads
      // exactly like a sink nobody has reached yet.
      expect(Object.keys(MAX_ENFORCEMENT_SINK_GOVERNANCE).sort())
        .toEqual([...KNOWN_SINKS].sort());
      const ungated = Object.entries(MAX_ENFORCEMENT_SINK_GOVERNANCE)
        .filter(([, governance]) => "ungated" in governance)
        .map(([sink]) => sink);
      expect(ungated.sort()).toEqual(
        ["generateObject", "generateText", "llm", "llmDialog", "sqliteQuery"],
      );
    });

    it("carries an owner and a retirement condition for every ungated sink", () => {
      // What makes an ungated sink a published deviation rather than a gap:
      // AH-CFC-15 asks who carries it and what would close it, and a reason
      // alone answers neither.
      for (
        const [sink, governance] of Object.entries(
          MAX_ENFORCEMENT_SINK_GOVERNANCE,
        )
      ) {
        if (!("ungated" in governance)) continue;
        expect(governance.ungated.reason.length, sink).toBeGreaterThan(0);
        expect(governance.ungated.owner.length, sink).toBeGreaterThan(0);
        expect(governance.ungated.retirement.length, sink).toBeGreaterThan(0);
      }
    });

    it("lets a secret-labeled value reach the llm sink with no gate at all", async () => {
      // Pins the DOCUMENTED gap, not a desired end state: a sink with no
      // ceiling gets no gate, so under this posture any confidentiality — a
      // secret as much as a risk caveat — reaches the llm sinks without a
      // policy evaluation running for them. Governing llm release needs the
      // boundary-scoped admission mechanism described on
      // MAX_ENFORCEMENT_SINK_CEILINGS; when that lands, this test flips to
      // asserting the refusal.
      //
      // This case stages the request by hand and writes to no store, so it
      // pins the SINK's verdict alone. `builtin-abandoned-request.test.ts`
      // pins the same verdict for a pattern calling the builtin, which is the
      // path a product takes and the one that was gated by accident until the
      // §8.12.5 route-2 widening.
      await withPostureRuntime(async (runtime) => {
        const cell = await seedSource(
          runtime,
          "posture-llm-secret",
          { confidentiality: ["medical"] },
        );
        expect(readThenEgress(runtime, cell, "llm")).toEqual([]);
      });
    });
  });

  describe("trigger-read gating decides a scheduled egress under the bundle", () => {
    it("holds an egress that never re-reads its triggering secret to the sink ceiling", async () => {
      await withPostureRuntime(async (runtime, space) => {
        const cell = await seedSource(
          runtime,
          "posture-trigger-secret",
          { confidentiality: ["medical"] },
        );
        const secretId = cell.getAsNormalizedFullLink().id;
        const tx = runtime.edit();
        // The store declares the confidentiality it receives, so the write
        // fits its own ceiling (§8.12.4) and the sink ceiling below is the
        // gate that decides this commit. Without the declaration a strict
        // writer-fit refuses first and the case stops reaching its subject.
        runtime.getCell<{ v: string }>(space, "posture-trigger-out", {
          type: "object",
          properties: { v: { type: "string" } },
          ifc: { confidentiality: ["medical"] },
        }, tx).set({ v: "computed" });
        // The secret is recorded as what SCHEDULED this run; the run never
        // reads it again. Without the gating dial the consumed set would not
        // carry ["medical"] and the public-only ceiling would pass this.
        tx.addCfcTriggerReads([{
          space,
          id: secretId,
          type: "application/json",
          path: ["value", "secret"],
        }]);
        enqueueSinkRequestPostCommitEffect(
          tx,
          "fetchJson",
          "fetchJson:max-enforcement-posture",
          createFrozenRequestSnapshot({ url: "https://example.com/exfil" }),
          "fetchJson-start",
          () => {},
        );
        tx.prepareCfc();
        const result = await tx.commit();
        expect(result.error).toBeDefined();
        expect(String((result.error as Error).message)).toContain(
          "exceeds ceiling for fetchJson",
        );
      });
    });
  });

  describe("a ceiling refusal is a scheduler error event", () => {
    it("surfaces the refused reactive egress on the error channel with its reasons", async () => {
      const reported: ErrorWithContext[] = [];
      await withPostureRuntime(async (runtime, space) => {
        const cell = await seedSource(
          runtime,
          "posture-event-secret",
          { confidentiality: ["medical"] },
        );
        const state = { runs: 0 };
        const egress: Action = (tx) => {
          state.runs++;
          expect(cell.withTx(tx).get()?.secret).toBe("rosebud");
          runtime.getCell<{ v: string }>(space, "posture-event-out", {
            type: "object",
            properties: { v: { type: "string" } },
            ifc: { confidentiality: ["medical"] },
          }, tx).set({ v: "derived" });
          enqueueSinkRequestPostCommitEffect(
            tx,
            "fetchText",
            "fetchText:max-enforcement-event",
            createFrozenRequestSnapshot({ url: "https://example.com/exfil" }),
            "fetchText-start",
            () => {},
          );
        };
        runtime.scheduler.subscribe(egress, { isEffect: true });
        await runtime.scheduler.idleWithPendingCommits();
        // Terminal, not retried: the refusal is a deterministic verdict.
        expect(state.runs).toBe(1);
        expect(reported.length).toBe(1);
        expect(reported[0].name).toBe("CfcCommitRefusalError");
        expect(String(reported[0].message)).toContain(
          "exceeds ceiling for fetchText",
        );
      }, [(error) => reported.push(error)]);
    });
  });
});
