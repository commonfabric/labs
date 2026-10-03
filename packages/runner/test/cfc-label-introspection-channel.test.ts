import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";

import {
  canonicalizePreparedDigestInput,
  preparedDigestFor,
} from "../src/cfc/canonical.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { inspectStoredConfLabel } from "../src/cfc/label-introspection.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { CfcLabelMetadataObservation } from "../src/cfc/types.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { TransactionWrapper } from "../src/storage/extended-storage-transaction.ts";
import type { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-label-introspection-channel",
);
const space = signer.did();

// Inv-12 Stage 2, the SC-6 partial revisit: label-metadata observations
// recorded by the introspection surface are APPLICATION observations — they
// enter the reading transaction's consumed set with their population-rule
// labels and feed the flow derivation — while runtime-internal verifier reads
// (readStoredCfcMetadata under INTERNAL_VERIFIER_META) stay excluded exactly
// as before.

const observationFor = (
  id: string,
  confidentiality: unknown[],
  targetSpace: string = space,
): CfcLabelMetadataObservation =>
  ({
    target: {
      space: targetSpace as CfcLabelMetadataObservation["target"]["space"],
      id,
      scope: "space",
      // The first-layer metadata subtree address (§4.6.4.1): observations
      // address /cfc/labels/<target-envelope-path>, never payload paths.
      path: ["cfc", "labels", "value", "body"],
    },
    observes: "labelMetadata",
    confidentiality,
  }) as CfcLabelMetadataObservation;

const seedLabeledDoc = async (
  runtime: Runtime,
  storageKey: string,
): Promise<string> => {
  const seed = runtime.edit();
  const id = parseLink(
    runtime.getCell(
      space,
      storageKey,
      { type: "object", properties: { body: { type: "string" } } },
    ).getAsLink(),
  ).id!;
  writeSeedEnvelopeDoc(seed, space);
  seedStoredEnvelope(seed, { space, scope: "space", id: id as URI, path: [] }, {
    value: { body: "payload" },
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [{
          path: ["body"],
          label: {
            confidentiality: ["secret", {
              type: CFC_ATOM_TYPE.Caveat,
              kind: "prompt-influence",
              source: { space: "did:key:remote-a", id: "of:origin-a" },
            }],
          },
          origin: "derived",
        }],
      },
    },
  });
  expect((await seed.commit().settled).ok).toBeDefined();
  return id;
};

const makeRuntime = (options: {
  cfcFlowLabels?: "off" | "observe" | "persist";
  cfcSinkMaxConfidentiality?: Record<string, unknown[]>;
} = {}) => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime(
    {
      apiUrl: new URL("https://example.com"),
      storageManager,
      ...options,
    } as ConstructorParameters<typeof Runtime>[0],
  );
  return { storageManager, runtime };
};

const storedDocument = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
  id: string,
): { value?: unknown } | undefined =>
  (storageManager.open(signer.did()).replica as unknown as {
    getDocument(id: string): { value?: unknown } | undefined;
  }).getDocument(id);

describe("CFC label-metadata observation channel (inv-12 Stage 2)", () => {
  it("recorded observations join the flow derivation with their population labels", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      const tx = runtime.edit();
      tx.recordCfcLabelMetadataObservation(
        observationFor("of:introspected", ["secret"]),
      );
      const join = deriveFlowJoin(tx, { collectLabeledSpaces: true });
      expect(join.confidentiality).toContainEqual("secret");
      // The observation's space counts as a label contributor (the Stage 1
      // cross-space predicate input).
      expect([...(join.labeledSpaces ?? [])]).toContain(space);
      // Confidentiality only: a metadata observation is not a content input,
      // so it must not seed or empty the hereditary integrity meet.
      expect(join.integrity).toEqual([]);
      await tx.commit().settled;
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("marks the transaction relevant and invalidates a prepared digest", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      const tx = runtime.edit();
      expect(tx.getCfcState().relevant).toBe(false);
      runtime.getCell(space, "channel-out-1", undefined, tx).set({ v: 1 });
      tx.prepareCfc();
      expect(tx.getCfcState().prepare.status).toBe("prepared");
      tx.recordCfcLabelMetadataObservation(
        observationFor("of:introspected", ["secret"]),
      );
      expect(tx.getCfcState().relevant).toBe(true);
      const prepare = tx.getCfcState().prepare;
      expect(prepare.status).toBe("invalidated");
      expect(
        (prepare as { reasons: readonly string[] }).reasons,
      ).toContainEqual("label-metadata-observation-added");
      await tx.commit().settled;
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("binds observations into the prepared digest", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      const bare = runtime.edit();
      runtime.getCell(space, "channel-digest", undefined, bare).set({ v: 1 });
      const bareDigest = bare.prepareCfc();
      expect(bareDigest).not.toBe("");
      await bare.commit().settled;

      const observing = runtime.edit();
      runtime.getCell(space, "channel-digest", undefined, observing).set({
        v: 1,
      });
      observing.recordCfcLabelMetadataObservation(
        observationFor("of:introspected", ["secret"]),
      );
      const observingDigest = observing.prepareCfc();
      expect(observingDigest).not.toBe("");
      // Same reads/writes, one extra observation: the digest must differ —
      // the observation is a boundary-decision input (it changes the flow
      // join and the consumed set).
      expect(observingDigest).not.toBe(bareDigest);
      await observing.commit().settled;
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("ignores empty (public) observations", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      const tx = runtime.edit();
      tx.recordCfcLabelMetadataObservation(
        observationFor("of:introspected", []),
      );
      expect(tx.getCfcState().labelMetadataObservations).toHaveLength(0);
      expect(tx.getCfcState().relevant).toBe(false);
      await tx.commit().settled;
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists the observation's confidentiality onto written docs under flow persist", async () => {
    const { storageManager, runtime } = makeRuntime({
      // The closing assertion reads a stamp off the written document. The
      // runtime writes that stamp at this rung.
      cfcFlowLabels: "persist",
    });
    try {
      const tx = runtime.edit();
      // The stamp this test reads back lands on a document in `space`, and
      // the observation's atom names the readers of that same space.
      const observed = cfcAtom.space(space);
      tx.recordCfcLabelMetadataObservation(
        observationFor("of:introspected", [observed]),
      );
      const out = runtime.getCell(space, "channel-out-persist", undefined, tx);
      out.set({ copied: "derived-from-metadata" });
      tx.prepareCfc();
      expect((await tx.commit().settled).ok).toBeDefined();

      const outId = out.getAsNormalizedFullLink().id;
      const check = runtime.edit();
      const stored = readStoredCfcMetadata(check, { space, id: outId });
      await check.commit().settled;
      const derived = stored?.labelMap.entries.find((entry) =>
        entry.origin === "derived"
      );
      expect(derived).toBeDefined();
      // The result of a transaction that observed protected label metadata
      // carries that metadata's population label: result label ⊇ the
      // consumed observation's confidentiality.
      expect(derived!.label.confidentiality).toContainEqual(observed);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps verifier reads excluded: raw metadata reads consume nothing", async () => {
    const { storageManager, runtime } = makeRuntime({
      // The closing assertion is that the written document carries no
      // derived stamp. This is the rung that stamps, so the absence is
      // evidence about the verifier read.
      cfcFlowLabels: "persist",
    });
    try {
      const id = await seedLabeledDoc(runtime, "channel-verifier-src");

      // Transaction A: performs a runtime-internal verifier read of the
      // stored metadata (the readStoredCfcMetadata seam prepare itself
      // uses) and writes a doc. Transaction B: writes the same value with
      // no metadata read. Their consumed sets must be EQUAL — the verifier
      // read is not an observation (§8.10.1); only the explicit
      // record-channel consumes.
      const txA = runtime.edit();
      const metadata = readStoredCfcMetadata(txA, { space, id });
      expect(metadata).toBeDefined();
      expect(
        metadata!.labelMap.entries[0].label.confidentiality,
      ).toContainEqual("secret");
      const joinA = deriveFlowJoin(txA);

      const txB = runtime.edit();
      const joinB = deriveFlowJoin(txB);

      expect(joinA.confidentiality).toEqual(joinB.confidentiality);
      expect(joinA.confidentiality).toEqual([]);

      // And end-to-end: the doc written by the verifier-reading transaction
      // stays unlabeled (no derived component minted from the raw read).
      const outA = runtime.getCell(
        space,
        "channel-verifier-out",
        undefined,
        txA,
      );
      outA.set({ copied: "no-taint" });
      txA.prepareCfc();
      expect((await txA.commit().settled).ok).toBeDefined();
      await txB.commit().settled;

      const outAId = outA.getAsNormalizedFullLink().id;
      const check = runtime.edit();
      const stored = readStoredCfcMetadata(check, { space, id: outAId });
      await check.commit().settled;
      // The stored value pins the document the metadata is read from, so an
      // envelope carrying no derived entry is that document's own.
      expect(storedDocument(storageManager, outAId)?.value).toEqual({
        copied: "no-taint",
      });
      expect(
        stored?.labelMap.entries.some((entry) => entry.origin === "derived"),
      ).not.toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("canonicalizes observations order-insensitively (address sort + hash tiebreak)", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      // The digest must not depend on recording order: address-sorted for
      // distinct targets, canonical-hash tiebreak for same-address records.
      const a = observationFor("of:introspected-a", ["secret-a"]);
      const b = observationFor("of:introspected-b", ["secret-b"]);
      const sameAddr1 = observationFor("of:introspected-a", ["secret-c"]);

      const base = {
        consumedReads: [],
        attemptedWrites: [],
        writes: [],
        writeAttemptLog: [],
        dereferenceTraces: [],
        triggerReads: [],
        writePolicyInputs: [],
      } as const;
      const forward = canonicalizePreparedDigestInput({
        ...base,
        labelMetadataObservations: [a, b, sameAddr1],
      });
      const reversed = canonicalizePreparedDigestInput({
        ...base,
        labelMetadataObservations: [sameAddr1, b, a],
      });
      expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
      expect(
        preparedDigestFor({
          ...base,
          labelMetadataObservations: [a, b, sameAddr1],
        }),
      ).toBe(
        preparedDigestFor({
          ...base,
          labelMetadataObservations: [sameAddr1, b, a],
        }),
      );
      // Distinct-space targets exercise the address arm too.
      const foreign = observationFor(
        "of:introspected-a",
        ["secret-d"],
        "did:key:zforeign",
      );
      const withForeign = canonicalizePreparedDigestInput({
        ...base,
        labelMetadataObservations: [foreign, a],
      });
      expect(
        (withForeign.labelMetadataObservations ?? []).map((o) =>
          o.target.space
        ),
      ).toEqual([space, "did:key:zforeign"]);
      // And end-to-end: two txs with identical activity, recording in
      // opposite orders, prepare to the SAME digest. Both prepare before
      // either commits so their journals are byte-identical. The document
      // they write declares a store policy admitting both observed atoms.
      const canonSchema = {
        type: "object",
        properties: { v: { type: "number" } },
        ifc: { confidentiality: ["secret-a", "secret-b"] },
      } as JSONSchema;
      const tx1 = runtime.edit();
      runtime.getCell(space, "channel-canon", canonSchema, tx1).set({ v: 1 });
      tx1.recordCfcLabelMetadataObservation(a);
      tx1.recordCfcLabelMetadataObservation(b);
      const digest1 = tx1.prepareCfc();
      const tx2 = runtime.edit();
      runtime.getCell(space, "channel-canon", canonSchema, tx2).set({ v: 1 });
      tx2.recordCfcLabelMetadataObservation(b);
      tx2.recordCfcLabelMetadataObservation(a);
      const digest2 = tx2.prepareCfc();
      expect(digest1).not.toBe("");
      expect(digest1).toBe(digest2);
      await tx1.commit().settled;
      tx2.abort(new Error("digest comparison only"));
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps smuggled empty observations out of the flow derivation", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      // recordCfcLabelMetadataObservation drops empty (public) observations,
      // so the deriveFlowJoin guard is defense in depth for INTERNAL
      // construction paths that might bypass it — exercise it directly with
      // a delegating wrapper tx (the cid-trigger-smuggle idiom): methods
      // bound to the real tx, state carrying one empty and one labeled
      // record.
      const tx = runtime.edit();
      const state = tx.getCfcState();
      const smuggledState = {
        ...state,
        labelMetadataObservations: [
          observationFor("of:introspected-empty", []),
          observationFor("of:introspected-full", ["secret"]),
        ],
      };
      const smuggledTx = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop === "getCfcState") {
            return () => smuggledState;
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const join = deriveFlowJoin(smuggledTx, { collectLabeledSpaces: true });
      expect(join.confidentiality).toEqual(["secret"]);
      // The empty record contributes nothing — not even its space.
      expect([...(join.labeledSpaces ?? [])]).toEqual([space]);
      await tx.commit().settled;
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("forwards recording through TransactionWrapper", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      // Cell.sample()/sink() hand out wrapped transactions; an introspection
      // running under one must land its observation on the SHARED underlying
      // state.
      const tx = runtime.edit();
      const wrapper = new TransactionWrapper(tx);
      wrapper.recordCfcLabelMetadataObservation(
        observationFor("of:introspected", ["secret"]),
      );
      expect(tx.getCfcState().labelMetadataObservations).toHaveLength(1);
      expect(tx.getCfcState().relevant).toBe(true);
      await tx.commit().settled;
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("inspectStoredConfLabel records the observation at the concrete metadata path", async () => {
    const { storageManager, runtime } = makeRuntime({
      // The introspection step hands back a protected result, and records
      // the observation the assertions below read, at this rung.
      cfcFlowLabels: "persist",
    });
    try {
      const id = await seedLabeledDoc(runtime, "channel-direct-src");
      const tx = runtime.edit();
      const cell = runtime.getCell(space, "channel-direct-src", undefined, tx);
      const outcome = inspectStoredConfLabel(
        tx,
        cell.getAsNormalizedFullLink(),
        "/body",
        {},
      );
      expect(outcome.status).toBe("ok");
      const observations = tx.getCfcState().labelMetadataObservations;
      // The seeded label holds two clauses ("secret" — a public type-only
      // string atom, nothing recorded — and the source-bearing caveat): one
      // protected whole-atom projection.
      expect(observations).toHaveLength(1);
      expect(observations[0].observes).toBe("labelMetadata");
      // The record addresses the CONCRETE first-layer metadata path the
      // projection consulted (§4.6.4.1 addressing; template-population
      // Stage B upgraded the record from the subtree root to the
      // clause/alternative-indexed path) — never a payload path.
      expect([...observations[0].target.path]).toEqual([
        "cfc",
        "labels",
        "value",
        "body",
        "confidentiality",
        "clauses",
        "1",
        "alternatives",
        "0",
      ]);
      expect(observations[0].target.id).toBe(id);
      expect([...observations[0].confidentiality]).toContainEqual("secret");
      await tx.commit().settled;
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("collapses a metadata read error to the unobservable arm", async () => {
    const { storageManager, runtime } = makeRuntime({
      // This is the rung where the introspection step reaches its recording
      // arm, so the empty observation list below is evidence about the
      // aborted read.
      cfcFlowLabels: "persist",
    });
    try {
      await seedLabeledDoc(runtime, "channel-err-src");
      const tx = runtime.edit();
      const cell = runtime.getCell(space, "channel-err-src", undefined, tx);
      const link = cell.getAsNormalizedFullLink();
      tx.abort(new Error("simulated storage failure"));
      // Reads on an aborted transaction throw; the introspection step must
      // collapse that to the SAME notAvailable as missing metadata.
      const outcome = inspectStoredConfLabel(tx, link, "/body", {});
      expect(outcome).toEqual({ status: "notAvailable" });
      expect(tx.getCfcState().labelMetadataObservations).toHaveLength(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("gates protected writes on consumed observations (maxConfidentiality)", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      const tx = runtime.edit();
      tx.recordCfcLabelMetadataObservation(
        observationFor("of:introspected", ["secret"]),
      );
      const target = runtime.getCell(
        space,
        "channel-gated-target",
        {
          type: "object",
          properties: {
            out: { type: "string", ifc: { maxConfidentiality: [] } },
          },
          required: ["out"],
        },
        tx,
      );
      target.set({ out: "derived" });
      tx.prepareCfc();
      const result = await tx.commit().settled;
      expect(result.error?.message).toContain("maxConfidentiality");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("feeds the sink-request egress ceiling (consumed set)", async () => {
    const { storageManager, runtime } = makeRuntime({
      cfcSinkMaxConfidentiality: { fetchJson: [] },
    });
    try {
      const tx = runtime.edit() as ExtendedStorageTransaction;
      tx.recordCfcLabelMetadataObservation(
        observationFor("of:introspected", ["secret"]),
      );
      tx.recordCfcWritePolicyInput({
        kind: "sink-request",
        effectId: "introspection-egress-1",
        sink: "fetchJson",
        request: { url: "https://example.com" },
      });
      tx.prepareCfc();
      const result = await tx.commit().settled;
      // The empty (public-only) fetchJson ceiling must reject a request from
      // a transaction whose consumed set includes the protected metadata
      // observation.
      expect(result.error?.message).toContain(
        "CFC enforcement rejected commit",
      );
      const reasons =
        (tx.getCfcState().prepare as { reasons?: readonly string[] })
          .reasons ?? [];
      expect(
        reasons.some((reason) => reason.includes("fetchJson")),
      ).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
