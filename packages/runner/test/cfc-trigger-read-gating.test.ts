import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { internSchema } from "@commonfabric/data-model-schema";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";
import { TransactionWrapper } from "../src/storage/extended-storage-transaction.ts";
import { Runtime } from "../src/runtime.ts";
import { enqueueSinkRequestPostCommitEffect } from "../src/cfc/sink-request.ts";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import type { SinkMaxConfidentiality } from "../src/cfc/mod.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-trigger-read-gating");

// Epic H5 (§8.9.2 / SC-3): the addresses whose invalidating writes SCHEDULED a
// reactive rerun (trigger reads) join the enforcement consumed set behind the
// `cfcTriggerReadGating` flag. Without it, a handler scheduled by a secret's
// write can egress to a ceiling'd sink — or write a requiredIntegrity-floored
// target — without ever re-reading that secret, and pass. Each case states the
// flag it drives: OFF, where the egress passes, and ON, where it is rejected,
// which is the fail-closed direction.
const CONFIDENTIAL_SCHEMA = internSchema(
  {
    type: "object",
    properties: {
      secret: { type: "string", ifc: { confidentiality: ["medical"] } },
    },
    required: ["secret"],
  } satisfies JSONSchema,
  true,
);

const OUT_SCHEMA = internSchema(
  {
    type: "object",
    properties: { v: { type: "string" } },
    required: ["v"],
  } satisfies JSONSchema,
  true,
);

// The output of a run scheduled by the confidential cell. Its value derives
// from the [medical] trigger read, so the document declares that
// confidentiality.
const DERIVED_OUT_SCHEMA = internSchema(
  {
    type: "object",
    properties: { v: { type: "string" } },
    required: ["v"],
    ifc: { confidentiality: ["medical"] },
  } satisfies JSONSchema,
  true,
);

const makeRuntime = (opts: {
  storageManager: ReturnType<typeof StorageManager.emulate>;
  cfcTriggerReadGating?: boolean;
  cfcFlowLabels?: "off" | "observe" | "persist";
  cfcSinkMaxConfidentiality?: SinkMaxConfidentiality;
}) =>
  new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager: opts.storageManager,
    cfcSinkMaxConfidentiality: opts.cfcSinkMaxConfidentiality,
    ...(opts.cfcTriggerReadGating !== undefined
      ? { cfcTriggerReadGating: opts.cfcTriggerReadGating }
      : {}),
    ...(opts.cfcFlowLabels !== undefined
      ? { cfcFlowLabels: opts.cfcFlowLabels }
      : {}),
  });

// Seed a confidential cell and return the id whose /secret carries [medical].
const seedConfidential = async (
  runtime: Runtime,
  id: string,
): Promise<string> => {
  const seed = runtime.edit();
  const target = runtime.getCell(signer.did(), id, undefined, seed);
  const targetId = target.getAsNormalizedFullLink().id;
  seedStoredEnvelope(seed, {
    space: signer.did(),
    scope: "space",
    id: targetId,
    path: [],
  }, {
    value: { secret: "rosebud" },
    cfc: {
      version: 1,
      schemaHash: CONFIDENTIAL_SCHEMA.taggedHashString,
      labelMap: {
        version: 1,
        entries: [{
          path: ["secret"],
          label: { confidentiality: ["medical"] },
        }],
      },
    },
  });
  seed.writeOrThrow({
    space: signer.did(),
    scope: "space",
    id: `cid:${CONFIDENTIAL_SCHEMA.taggedHashString}`,
    path: [],
  }, { value: CONFIDENTIAL_SCHEMA.schema });
  expect((await seed.commit().settled).ok).toBeDefined();
  return targetId;
};

// A tx that (a) marks itself CFC-relevant by writing an output cell, (b) records
// the confidential cell as a TRIGGER read (never re-reading it), and (c)
// enqueues a fetchJson sink request. No confidential read is consumed directly.
const scheduledEgress = (
  runtime: Runtime,
  outId: string,
  secretId: string,
) => {
  const tx = runtime.edit();
  runtime.getCell(signer.did(), outId, OUT_SCHEMA.schema, tx).set({
    v: "computed",
  });
  tx.addCfcTriggerReads([{
    space: signer.did(),
    id: secretId as `${string}:${string}`,
    type: "application/json",
    path: ["value", "secret"],
  }]);
  enqueueSinkRequestPostCommitEffect(
    tx,
    "fetchJson",
    "fetchJson:h5",
    createFrozenRequestSnapshot({ url: "https://example.com/exfil" }),
    "fetchJson-start",
    () => {},
  );
  tx.prepareCfc();
  return tx;
};

describe("CFC trigger-read gating (H5, §8.9.2 / SC-3)", () => {
  it("flag OFF: a scheduled egress that never re-reads the secret passes", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({
      storageManager,
      // Pinned: the commit below asserts no error, which is what an ungated
      // trigger read produces.
      cfcTriggerReadGating: false,
      // Pinned: under flow persist the trigger reads reach the sink gate
      // through the per-tx flow join. The channel this arm characterizes
      // needs the flow dial off as well.
      cfcFlowLabels: "off",
      cfcSinkMaxConfidentiality: { fetchJson: [] },
    });
    try {
      const secretId = await seedConfidential(runtime, "h5-off-secret");
      const tx = scheduledEgress(runtime, "h5-off-out", secretId);
      const result = await tx.commit().settled;
      // With gating off the trigger read is not in the consumed set, so the
      // public-only sink ceiling is not tripped.
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("flag ON: the same scheduled egress is rejected by the sink ceiling", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({
      storageManager,
      // Pinned: the commit below asserts the "exceeds ceiling for fetchJson"
      // rejection, which is what a gated trigger read produces.
      cfcTriggerReadGating: true,
      // Pinned at the OFF arm's flow dial, so the gating flag is the one
      // difference between the two arms.
      cfcFlowLabels: "off",
      cfcSinkMaxConfidentiality: { fetchJson: [] },
    });
    try {
      const secretId = await seedConfidential(runtime, "h5-on-secret");
      const tx = scheduledEgress(runtime, "h5-on-out", secretId);
      const result = await tx.commit().settled;
      expect(isCfcEnforcementRejection(result.error)).toBe(true);
      expect(String((result.error as Error).message)).toContain(
        "exceeds ceiling for fetchJson",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  // The run was scheduled by a change to `items.length`, and the label sits on
  // the array's membership, not on `length`. A read of an array's `length`
  // observes its membership, so the egress is rejected, whatever `items` holds
  // by the time the run prepares.
  for (
    const [holding, items] of [
      ["the array", ["a", "b", "c"]],
      ["a string that replaced the array", "gone"],
    ] as const
  ) {
    it(`flag ON: a trigger read of a length carries its parent's membership label, the parent holding ${holding}`, async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({
        storageManager,
        // Pinned: the commit below asserts the ceiling rejection, which only a
        // gated trigger read produces.
        cfcTriggerReadGating: true,
        // Pinned: with the flow dial off, the trigger read reaches the sink gate
        // only through the gated consumed set.
        cfcFlowLabels: "off",
        cfcSinkMaxConfidentiality: { fetchJson: [] },
      });
      try {
        const seed = runtime.edit();
        const itemsId = runtime.getCell(
          signer.did(),
          `h5-length-items-${typeof items}`,
          undefined,
          seed,
        ).getAsNormalizedFullLink().id;
        writeSeedEnvelopeDoc(seed, signer.did());
        seedStoredEnvelope(seed, {
          space: signer.did(),
          scope: "space",
          id: itemsId,
          path: [],
        }, {
          value: { items },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{
                path: ["items"],
                label: { confidentiality: ["medical"] },
                origin: "declared",
                observes: "enumerate",
              }],
            },
          },
        });
        expect((await seed.commit().settled).ok).toBeDefined();

        const tx = runtime.edit();
        runtime.getCell(signer.did(), "h5-length-out", OUT_SCHEMA.schema, tx)
          .set({ v: "computed" });
        tx.addCfcTriggerReads([{
          space: signer.did(),
          id: itemsId,
          type: "application/json",
          path: ["value", "items", "length"],
        }]);
        enqueueSinkRequestPostCommitEffect(
          tx,
          "fetchJson",
          "fetchJson:length",
          createFrozenRequestSnapshot({ url: "https://example.com/exfil" }),
          "fetchJson-start",
          () => {},
        );
        tx.prepareCfc();
        const result = await tx.commit().settled;
        expect(isCfcEnforcementRejection(result.error)).toBe(true);
        expect(String((result.error as Error).message)).toContain(
          "exceeds ceiling for fetchJson",
        );
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  }

  it("flag ON but no trigger read: an unrelated scheduled egress still passes", async () => {
    // The gate only folds in ACTUAL trigger reads — a run scheduled by a
    // non-confidential write (no confidential trigger) is not over-blocked.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({
      storageManager,
      // Pinned: the commit below asserts no error with the gate enabled.
      cfcTriggerReadGating: true,
      cfcSinkMaxConfidentiality: { fetchJson: [] },
    });
    try {
      const tx = runtime.edit();
      runtime.getCell(signer.did(), "h5-none-out", OUT_SCHEMA.schema, tx).set({
        v: "computed",
      });
      enqueueSinkRequestPostCommitEffect(
        tx,
        "fetchJson",
        "fetchJson:none",
        createFrozenRequestSnapshot({ url: "https://example.com/ok" }),
        "fetchJson-start",
        () => {},
      );
      tx.prepareCfc();
      const result = await tx.commit().settled;
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("flag ON: a cid: trigger read is excluded (content-addressed docs never gate)", async () => {
    // Trigger entries for content-addressed schema/program docs (cid:) are
    // structural plumbing, dropped at ingest by addCfcTriggerReads
    // (flowReadExcluded), so a run whose only trigger is a cid: address has an
    // empty trigger set and egresses freely even with the gate on.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({
      storageManager,
      // Pinned: the commit below asserts no error with the gate enabled.
      cfcTriggerReadGating: true,
      cfcSinkMaxConfidentiality: { fetchJson: [] },
    });
    try {
      const tx = runtime.edit();
      runtime.getCell(signer.did(), "h5-cid-out", OUT_SCHEMA.schema, tx).set({
        v: "computed",
      });
      tx.addCfcTriggerReads([{
        space: signer.did(),
        id:
          `cid:${CONFIDENTIAL_SCHEMA.taggedHashString}` as `${string}:${string}`,
        type: "application/json",
        path: ["value"],
      }]);
      enqueueSinkRequestPostCommitEffect(
        tx,
        "fetchJson",
        "fetchJson:cid",
        createFrozenRequestSnapshot({ url: "https://example.com/ok" }),
        "fetchJson-start",
        () => {},
      );
      tx.prepareCfc();
      const result = await tx.commit().settled;
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("the enabled gate cannot be disabled mid-transaction (anti-downgrade pin)", async () => {
    // The runtime enables the gate at tx creation; code holding the
    // transaction must not be able to dial it back off before `prepareCfc()` — that would empty triggerReadSources and
    // skip both H5 gates the deployment enabled (mirrors the write-floor
    // enforce pin).
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({
      storageManager,
      // Pinned: the steps below assert that disabling the gate throws and
      // then read the gate back as enabled.
      cfcTriggerReadGating: true,
      cfcSinkMaxConfidentiality: { fetchJson: [] },
    });
    try {
      const secretId = await seedConfidential(runtime, "h5-pin-secret");
      const tx = runtime.edit();
      const out = runtime.getCell(
        signer.did(),
        "h5-pin-out",
        DERIVED_OUT_SCHEMA.schema,
        tx,
      );
      out.set({ v: "computed" });
      tx.addCfcTriggerReads([{
        space: signer.did(),
        id: secretId as `${string}:${string}`,
        type: "application/json",
        path: ["value", "secret"],
      }]);
      // The malicious downgrade throws...
      expect(() => tx.setCfcTriggerReadGating(false)).toThrow(
        "cannot be disabled",
      );
      // ...re-asserting the enabled state is permitted...
      tx.setCfcTriggerReadGating(true);
      expect(tx.getCfcState().triggerReadGating).toBe(true);
      // ...and even with the throw swallowed the gate still enforces: the
      // scheduled egress is rejected by the sink ceiling.
      enqueueSinkRequestPostCommitEffect(
        tx,
        "fetchJson",
        "fetchJson:h5-pin",
        createFrozenRequestSnapshot({ url: "https://example.com/exfil" }),
        "fetchJson-start",
        () => {},
      );
      tx.prepareCfc();
      const result = await tx.commit().settled;
      expect(isCfcEnforcementRejection(result.error)).toBe(true);
      expect(String((result.error as Error).message)).toContain(
        "exceeds ceiling for fetchJson",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("getCfcState() is a read-only view — direct state mutation cannot bypass the pin", async () => {
    // `Readonly<CfcTxState>` is compile-time only: without a runtime guard,
    // code holding the transaction could skip the pinned
    // setter and flip the gate (or truncate the trigger set, or un-mark
    // relevance, or forge the prepare status) directly on the object
    // `getCfcState()` returns (cubic/codex review on #4517).
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({
      storageManager,
      // Pinned: the steps below read the gate back as enabled after the
      // attempts to mutate the view.
      cfcTriggerReadGating: true,
      cfcSinkMaxConfidentiality: { fetchJson: [] },
    });
    try {
      const secretId = await seedConfidential(runtime, "h5-view-secret");
      const tx = runtime.edit();
      const out = runtime.getCell(
        signer.did(),
        "h5-view-out",
        DERIVED_OUT_SCHEMA.schema,
        tx,
      );
      out.set({ v: "computed" });
      tx.addCfcTriggerReads([{
        space: signer.did(),
        id: secretId as `${string}:${string}`,
        type: "application/json",
        path: ["value", "secret"],
      }]);
      const state = tx.getCfcState() as unknown as {
        triggerReadGating: boolean;
        relevant: boolean;
        triggerReads: unknown[];
        prepare: { status: string };
      };
      expect(() => {
        state.triggerReadGating = false;
      }).toThrow("read-only");
      expect(() => {
        state.triggerReads.length = 0;
      }).toThrow("read-only");
      expect(() => {
        state.triggerReads.pop();
      }).toThrow("read-only");
      expect(() => {
        state.relevant = false;
      }).toThrow("read-only");
      expect(() => {
        state.prepare.status = "prepared";
      }).toThrow("read-only");
      // The backing state is not reachable around the view either: the field
      // is ECMAScript-private, so `(tx as any).cfcState` finds nothing.
      expect((tx as unknown as Record<string, unknown>).cfcState)
        .toBeUndefined();
      // The Map facade forwards reads bound to the real Map and rejects
      // mutators.
      const identities = tx.getCfcState().writePolicyInputIdentities;
      // The out document's declared schema is the only write-policy input
      // this transaction records, so the facade reports that one entry.
      expect(identities.size).toBe(1);
      expect(
        [...identities.keys()].map((key) => (key as { kind: string }).kind),
      ).toEqual(["schema"]);
      expect(identities.get({} as never)).toBeUndefined();
      expect(() => identities.set({} as never, {} as never)).toThrow(
        "read-only",
      );
      expect(() => identities.clear()).toThrow("read-only");
      // The child-cell wrapper's diagnostics seam delegates to the wrapped
      // transaction.
      new TransactionWrapper(tx, {}).noteCfcDiagnostic("h5-view-wrapper-note");
      expect(tx.getCfcState().diagnostics).toContainEqual(
        "h5-view-wrapper-note",
      );
      // Nothing stuck: the state is intact and the gate still enforces.
      expect(tx.getCfcState().triggerReadGating).toBe(true);
      expect(tx.getCfcState().triggerReads.length).toBe(1);
      enqueueSinkRequestPostCommitEffect(
        tx,
        "fetchJson",
        "fetchJson:h5-view",
        createFrozenRequestSnapshot({ url: "https://example.com/exfil" }),
        "fetchJson-start",
        () => {},
      );
      tx.prepareCfc();
      const result = await tx.commit().settled;
      expect(isCfcEnforcementRejection(result.error)).toBe(true);
      expect(String((result.error as Error).message)).toContain(
        "exceeds ceiling for fetchJson",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("the input-requirement gate also consults trigger reads under the flag", async () => {
    // A requiredIntegrity-floored write whose only consumed input is a TRIGGER
    // read that lacks the required atom: flag OFF passes (empty gate set), flag
    // ON fails (the trigger read joins gatedReads and misses the floor).
    const run = async (gating: boolean) => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({
        storageManager,
        cfcTriggerReadGating: gating,
      });
      try {
        // A trigger source labeled with a NON-required endorsement.
        const seed = runtime.edit();
        const srcCell = runtime.getCell(
          signer.did(),
          "h5-ri-src",
          undefined,
          seed,
        );
        const srcId = srcCell.getAsNormalizedFullLink().id;
        writeSeedEnvelopeDoc(seed, signer.did());
        seedStoredEnvelope(seed, {
          space: signer.did(),
          scope: "space",
          id: srcId,
          path: [],
        }, {
          value: "data",
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{
                path: [],
                label: { integrity: ["other-endorsement"] },
              }],
            },
          },
        });
        expect((await seed.commit().settled).ok).toBeDefined();

        const tx = runtime.edit();
        const sink = runtime.getCell(
          signer.did(),
          "h5-ri-sink",
          {
            type: "object",
            properties: {
              out: { type: "string", ifc: { requiredIntegrity: ["needed"] } },
            },
            required: ["out"],
          } as const satisfies JSONSchema,
          tx,
        );
        sink.set({ out: "derived" });
        tx.addCfcTriggerReads([{
          space: signer.did(),
          id: srcId as `${string}:${string}`,
          type: "application/json",
          path: ["value"],
        }]);
        tx.prepareCfc();
        const result = await tx.commit().settled;
        return String((result.error as Error | undefined)?.message ?? "");
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    };
    expect(await run(false)).not.toContain("requiredIntegrity failed");
    expect(await run(true)).toContain("requiredIntegrity failed");
  });

  it("gates a trigger read of a payload field named `value` at that field", async () => {
    // The source's `secret` carries [medical] and its field `value` carries
    // nothing. Gated at the payload root instead, the read would consume
    // `secret` and miss the target's ceiling. The trigger read of `secret` is
    // the control: it shows the ceiling refuses what it should.
    const run = async (field: string) => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({
        storageManager,
        cfcTriggerReadGating: true,
      });
      try {
        const seed = runtime.edit();
        const srcCell = runtime.getCell(
          signer.did(),
          "h5-value-field-src",
          undefined,
          seed,
        );
        const srcId = srcCell.getAsNormalizedFullLink().id;
        writeSeedEnvelopeDoc(seed, signer.did());
        seedStoredEnvelope(seed, {
          space: signer.did(),
          scope: "space",
          id: srcId,
          path: [],
        }, {
          value: { value: "plain", secret: "rosebud" },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{
                path: ["secret"],
                label: { confidentiality: ["medical"] },
              }],
            },
          },
        });
        expect((await seed.commit().settled).ok).toBeDefined();

        const tx = runtime.edit();
        const sink = runtime.getCell(
          signer.did(),
          "h5-value-field-sink",
          {
            type: "object",
            properties: {
              out: {
                type: "string",
                ifc: { maxConfidentiality: ["internal"] },
              },
            },
            required: ["out"],
          } as const satisfies JSONSchema,
          tx,
        );
        sink.set({ out: "derived" });
        tx.addCfcTriggerReads([{
          space: signer.did(),
          id: srcId as `${string}:${string}`,
          type: "application/json",
          path: ["value", field],
        }]);
        tx.prepareCfc();
        const result = await tx.commit().settled;
        return String((result.error as Error | undefined)?.message ?? "");
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    };
    expect(await run("value")).not.toContain("maxConfidentiality failed");
    expect(await run("secret")).toContain("maxConfidentiality failed");
  });
});
