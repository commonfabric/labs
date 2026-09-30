import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { internSchema } from "@commonfabric/data-model-schema";
import type { URI } from "@commonfabric/memory/interface";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import { RetryImmediately } from "../src/scheduler/retry-immediately.ts";
import type { Action } from "../src/scheduler.ts";

const signer = await Identity.fromPassphrase("runner-cfc-flow-labels");

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
  origin?: string;
};

const replicaEntries = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
  id: string,
): StoredEntry[] => {
  const replica = storageManager.open(signer.did()).replica as unknown as {
    getDocument(id: string): {
      cfc?: { labelMap?: { entries: StoredEntry[] } };
    } | undefined;
  };
  return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
};

const SECRET_FIELD_SCHEMA = internSchema(
  { type: "string", ifc: { confidentiality: ["secret"] } } as JSONSchema,
  true,
);

/**
 * Declares the write policy covering a raw write to a seeded document's
 * `secret` field. A schema-backed write carries this declaration from the
 * schema it went through; a raw address write states it here instead.
 */
const recordSecretWritePolicy = (
  tx: IExtendedStorageTransaction,
  id: string,
): void => {
  tx.recordCfcWritePolicyInput({
    kind: "schema",
    target: {
      space: signer.did(),
      scope: "space",
      id: id as URI,
      path: ["secret"],
    },
    schemaHash: SECRET_FIELD_SCHEMA.taggedHashString,
    schema: SECRET_FIELD_SCHEMA.schema,
  });
};

describe("CFC flow labels (default transition)", () => {
  // S16 default transition: a transaction's outputs are tainted by what it
  // read. Without this, "read labeled data, write a derived plain value to an
  // unlabeled cell" launders the label away (audit S16) — the acceptance
  // scenario for the cfcFlowLabels dial.

  it("persists derived flow labels on laundered value copies and gates downstream egress", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // At this rung the writer-fit check flags a tainted write to a store
      // that declares no ceiling and lets it land. The derived doc declares
      // none, and the `flowEntry` assertions below read back the entry that
      // write persisted.
      cfcEnforcementMode: "enforce-explicit",
      // Persisting the derived join is what puts that entry in the document.
      cfcFlowLabels: "persist",
    });
    try {
      // Doc A: labeled secret.
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-flow-labels-source",
          {
            type: "object",
            properties: { secret: { type: "string" } },
          },
        ).getAsLink(),
      ).id!;
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "s3cr3t" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      // The laundering tx: read A raw, write a derived plain value to the
      // unlabeled doc B. No schema ifc anywhere near B.
      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "cfc-flow-labels-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      expect(raw.secret).toBe("s3cr3t");

      const derived = runtime.getCell(
        signer.did(),
        "cfc-flow-labels-derived",
        undefined,
        tx,
      );
      derived.set({ copied: `${raw.secret}!` });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      // The derived doc carries the consumed confidentiality as a derived
      // component at the written path.
      const derivedId = derived.getAsNormalizedFullLink().id;
      const entries = replicaEntries(storageManager, derivedId);
      const flowEntry = entries.find((e) => e.origin === "derived");
      expect(flowEntry).toBeDefined();
      expect(flowEntry!.label.confidentiality).toContainEqual("secret");

      // And the derived label feeds the existing enforcement seams: a
      // later tx consuming B cannot write into a slot whose ceiling
      // excludes the secret.
      const egress = runtime.edit();
      const derivedIn = runtime.getCell(
        signer.did(),
        "cfc-flow-labels-derived",
        undefined,
        egress,
      );
      const rawDerived = derivedIn.getRaw() as { copied?: string };
      expect(rawDerived.copied).toBe("s3cr3t!");

      const gated = runtime.getCell(
        signer.did(),
        "cfc-flow-labels-gated",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: { maxConfidentiality: ["internal"] },
            },
          },
          required: ["value"],
        },
        egress,
      );
      gated.set({ value: "leak" });
      egress.prepareCfc();
      const result = await egress.commit();
      expect(result.error?.message).toContain("maxConfidentiality");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not exempt user value fields named like runtime surfaces", async () => {
    // Runtime-internal surfaces (`["cfc"]`, `["source"]`) are document-root
    // siblings of `value`; user fields of the same names live under
    // `["value", ...]` and canonicalize to identical logical paths. The
    // surface exclusions must therefore key on the RAW storage path — keying
    // on the canonical path lets `value.source` writes/reads dodge flow-label
    // propagation entirely (#4011 Codex P1).

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // At this rung the writer-fit check flags a tainted write to a store
      // that declares no ceiling and lets it land. Neither the target
      // doc nor the out doc declares one, and the `flowEntry` and `outEntry`
      // assertions below read back the entries those writes persisted.
      cfcEnforcementMode: "enforce-explicit",
      // Persisting the derived join is what puts those entries in the
      // documents.
      cfcFlowLabels: "persist",
    });
    try {
      // Doc A: labeled secret. Doc B: pre-existing plain doc with a user
      // field named `source`.
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-flow-surface-secret",
          { type: "object", properties: { secret: { type: "string" } } },
        ).getAsLink(),
      ).id!;
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "s3cr3t" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      const targetId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-flow-surface-target",
          { type: "object", properties: { source: { type: "string" } } },
        ).getAsLink(),
      ).id!;
      seed.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: targetId,
        path: [],
      }, { value: { source: "public" } });
      expect((await seed.commit()).ok).toBeDefined();

      // Write side: a tainted write landing exactly at B's user field
      // `value.source` must enter the flow targets (raw path
      // ["value","source"], canonical ["source"] — the runtime-internal
      // `["source"]` surface has no `value` prefix).
      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "cfc-flow-surface-secret",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      expect(raw.secret).toBe("s3cr3t");
      tx.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: targetId,
        path: ["value", "source"],
      }, `${raw.secret}!`);
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const entries = replicaEntries(storageManager, targetId);
      const flowEntry = entries.find((e) => e.origin === "derived");
      expect(flowEntry).toBeDefined();
      expect(flowEntry!.path).toEqual(["source"]);
      expect(flowEntry!.label.confidentiality).toContainEqual("secret");

      // Read side: consuming the now-labeled `value.source` (read activity
      // at raw ["value","source"]) taints what the transaction writes
      // elsewhere — the read must not be dropped as a surface read.
      const launder = runtime.edit();
      const taintedIn = runtime.getCell(
        signer.did(),
        "cfc-flow-surface-target",
        undefined,
        launder,
      );
      const copied = taintedIn.key("source").getRaw() as string;
      expect(copied).toBe("s3cr3t!");
      const out = runtime.getCell(
        signer.did(),
        "cfc-flow-surface-out",
        undefined,
        launder,
      );
      out.set({ copied });
      launder.prepareCfc();
      expect((await launder.commit()).ok).toBeDefined();

      const outId = out.getAsNormalizedFullLink().id;
      const outEntry = replicaEntries(storageManager, outId).find((e) =>
        e.origin === "derived"
      );
      expect(outEntry).toBeDefined();
      expect(outEntry!.label.confidentiality).toContainEqual("secret");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("untainted overwrite replaces the value channel and grows the existence channel", async () => {
    // Derived labels are per-value, not a ratchet: overwriting a flow-labeled
    // path from a transaction that read nothing labeled replaces the derived
    // component, so the label tracks the current value (the old, tainted value
    // is gone; reads of it journaled its label at read time).

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // At this rung the writer-fit check flags a tainted write to a store
      // that declares no ceiling and lets it land. The target declares
      // none, and the `derivedAfter` assertions below read back the entries
      // the tainted write and the overwrite left there.
      cfcEnforcementMode: "enforce-explicit",
      // Persisting the derived join is what puts the value and shape entries
      // in the document.
      cfcFlowLabels: "persist",
    });
    try {
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-flow-replace-source",
          { type: "object", properties: { secret: { type: "string" } } },
        ).getAsLink(),
      ).id!;
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "s3cr3t" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      // Tainted write: doc gets a derived ["secret"] component.
      const taint = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "cfc-flow-replace-source",
        undefined,
        taint,
      );
      const raw = source.getRaw() as { secret?: string };
      const target = runtime.getCell(
        signer.did(),
        "cfc-flow-replace-target",
        undefined,
        taint,
      );
      target.set({ note: raw.secret });
      taint.prepareCfc();
      expect((await taint.commit()).ok).toBeDefined();

      const targetId = target.getAsNormalizedFullLink().id;
      expect(
        replicaEntries(storageManager, targetId).find((e) =>
          e.origin === "derived"
        )?.label.confidentiality,
      ).toContainEqual("secret");

      // Untainted overwrite: a write whose journal contains no reads (raw
      // root write). The VALUE channel is replaced (cleared — this tx
      // derived nothing): §8.12.8 replace-on-overwrite is a value-class
      // rule. The EXISTENCE (shape) channel grows instead of vanishing
      // (SC-4, C3): "this path was once written under secret" must not
      // become a public bit. Note that `cell.set()` is NOT an untainted
      // write: it journals a read of the prior value, so a set-overwrite
      // of a tainted doc conservatively re-derives the taint — by the
      // journal it consumed the old value.
      const clean = runtime.edit();
      clean.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: targetId,
        path: ["value"],
      }, { note: "fresh public text" });
      clean.prepareCfc();
      expect(await clean.commit()).toMatchObject({ ok: expect.anything() });

      const entriesAfter = replicaEntries(storageManager, targetId);
      const derivedAfter = entriesAfter.filter((e) => e.origin === "derived");
      expect(
        derivedAfter.filter((e) =>
          (e as { observes?: string }).observes !== "shape"
        ),
      ).toEqual([]);
      expect(derivedAfter.length).toBe(1);
      expect((derivedAfter[0] as { observes?: string }).observes).toBe(
        "shape",
      );
      expect(derivedAfter[0].label.confidentiality).toEqual(["secret"]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("SC-11: re-deriving an unchanged label writes no envelope (idempotent)", async () => {
    // The load-bearing prereq for cfcFlowLabels:"persist" — a rerun that reads
    // the same inputs derives the same labels and must NOT rewrite the ["cfc"]
    // doc (which would bump the revision and churn sync/conflict every
    // recompute). Observed directly: the second, identical derivation records
    // no write to the target's ["cfc"] path.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // At this rung the writer-fit check flags a tainted write to a store
      // that declares no ceiling and lets it land. The target declares
      // none, so the first derivation's envelope write lands. The second
      // derivation's `wroteCfc` assertion measures the skip of that same
      // write.
      cfcEnforcementMode: "enforce-explicit",
      // Persisting the derived join is what makes an envelope write happen at
      // all, and `wroteCfc` reads it back.
      cfcFlowLabels: "persist",
    });
    try {
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-flow-idem-source",
          { type: "object", properties: { secret: { type: "string" } } },
        ).getAsLink(),
      ).id!;
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "s3cr3t" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{ path: ["secret"], label: { confidentiality: ["x"] } }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const deriveOnce = () => {
        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "cfc-flow-idem-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const target = runtime.getCell(
          signer.did(),
          "cfc-flow-idem-target",
          undefined,
          tx,
        );
        target.set({ note: raw.secret });
        tx.prepareCfc();
        const targetId = target.getAsNormalizedFullLink().id;
        const wroteCfc = [...(tx.getWriteDetails?.(signer.did()) ?? [])].some(
          (w) => w.address.id === targetId && w.address.path[0] === "cfc",
        );
        return { tx, targetId, wroteCfc };
      };

      // First derivation: the envelope IS written (a real derived component).
      const first = deriveOnce();
      expect(first.wroteCfc).toBe(true);
      expect((await first.tx.commit()).ok).toBeDefined();
      expect(
        replicaEntries(storageManager, first.targetId).find((e) =>
          e.origin === "derived"
        )?.label.confidentiality,
      ).toContainEqual("x");

      // Identical re-derivation: the envelope write is SKIPPED (idempotent).
      const second = deriveOnce();
      expect(second.wroteCfc).toBe(false);
      expect((await second.tx.commit()).ok).toBeDefined();
      // ...and the stored label is unchanged.
      expect(
        replicaEntries(storageManager, second.targetId).find((e) =>
          e.origin === "derived"
        )?.label.confidentiality,
      ).toContainEqual("x");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("SC-11: skips the envelope write for a canonically-equal but byte-different stored form", async () => {
    // SC-11's equality is over the CANONICAL form (§4.1.3 c14n; spec-changes
    // SC-11): the prepare-side skip must elide the envelope write even when the
    // stored form differs BYTE-wise from the rebuild — top-level entry order
    // and OR-clause alternative order are serialization freedom, not label
    // changes. The storage layer's raw deep-equal write elision is
    // order-sensitive and cannot catch these, so this pins the prepare.ts skip
    // itself: a stored-form permutation (a raw seed, an older writer, a peer
    // whose view merge ordered alternatives differently) must not be rewritten
    // by every re-derivation.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // At this rung the writer-fit check flags a tainted write to a store
      // that declares no ceiling and lets it land. The target declares
      // none, so the first derivation writes the envelope that the permutation
      // reorders and the second derivation's `wroteCfc` assertion measures the
      // skip of.
      cfcEnforcementMode: "enforce-explicit",
      // Persisting the derived join is what writes that envelope.
      cfcFlowLabels: "persist",
    });
    try {
      const getDocument = (id: string) =>
        (storageManager.open(signer.did()).replica as unknown as {
          getDocument(id: string): Record<string, unknown> | undefined;
        }).getDocument(id);

      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-flow-canon-source",
          { type: "object", properties: { secret: { type: "string" } } },
        ).getAsLink(),
      ).id!;
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "s3cr3t" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              // An OR-clause: its alternative order is one of the two
              // serialization freedoms permuted below.
              label: { confidentiality: [{ anyOf: ["s1", "s2"] }] },
            }],
          },
        },
      });
      const targetId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-flow-canon-target",
          {
            type: "object",
            properties: { a: { type: "string" }, b: { type: "string" } },
          },
        ).getAsLink(),
      ).id!;
      seed.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: targetId,
        path: [],
      }, { value: { a: "a0", b: "b0" } });
      expect((await seed.commit()).ok).toBeDefined();

      // One derivation shape, run twice with fresh values: read the labeled
      // source, write two sibling leaves (two derived stamps, so the entry
      // LIST order is exercised, not just one entry's interior).
      const derive = (suffix: string) => {
        const tx = runtime.edit();
        const raw = runtime.getCell(
          signer.did(),
          "cfc-flow-canon-source",
          undefined,
          tx,
        ).getRaw() as { secret?: string };
        expect(raw.secret).toBe("s3cr3t");
        for (const field of ["a", "b"]) {
          tx.writeOrThrow({
            space: signer.did(),
            scope: "space",
            id: targetId,
            path: ["value", field],
          }, `${field}-${suffix}`);
        }
        tx.prepareCfc();
        const wroteCfc = [...(tx.getWriteDetails?.(signer.did()) ?? [])].some(
          (w) => w.address.id === targetId && w.address.path[0] === "cfc",
        );
        return { tx, wroteCfc };
      };

      const first = derive("1");
      expect(first.wroteCfc).toBe(true);
      expect((await first.tx.commit()).ok).toBeDefined();
      const stored = getDocument(targetId) as {
        cfc: {
          labelMap: {
            entries: {
              path: string[];
              label: { confidentiality?: unknown[] };
              origin?: string;
              observes?: string;
            }[];
          };
        };
      };
      // Each path carries value and existence labels plus a metadata shape
      // template protecting queries about those derived labels.
      expect(stored.cfc.labelMap.entries.length).toBe(6);

      // Re-serialize the stored envelope into a canonically-equal but
      // byte-DIFFERENT form by reversing the ENTRY LIST ORDER (across paths).
      // `canonicalizeCfcMetadata` sorts entries by (path, origin, observes),
      // so the reordering washes out under canonicalization — while the
      // storage layer's order-sensitive `valueEqual` on the `["cfc"]` doc
      // sees a different array and would NOT elide the rewrite. So this is
      // exactly a byte-difference the skip must absorb and the storage
      // elision cannot: a peer, an older writer, or a hand-authored seed
      // whose entry order differs must not be rewritten every recompute.
      //
      // The clause INTERIORS are left stable on purpose. Permuting an
      // OR-clause's alternative order in the STORED form would defeat
      // idempotence through C3's existence-grow, not through this skip:
      // the grow folds the cleared entry's clause back in via
      // `uniqueCfcAtoms` (deepEqual dedup, not clause-aware), so a
      // reversed-`anyOf` stored clause and the fresh canonical-order join
      // clause both survive as a doubled clause list. That is a narrow
      // grow-side limitation, orthogonal to the canonical-compare skip
      // under test here.
      const permuted = {
        ...stored.cfc,
        labelMap: {
          version: 1,
          entries: [...stored.cfc.labelMap.entries].reverse(),
        },
      };
      expect(permuted).not.toEqual(stored.cfc);
      const reseed = runtime.edit();
      seedStoredEnvelope(reseed, {
        space: signer.did(),
        scope: "space",
        id: targetId,
        path: [],
      }, { ...stored, cfc: permuted } as never);
      expect((await reseed.commit()).ok).toBeDefined();
      expect((getDocument(targetId) as { cfc: unknown }).cfc).toEqual(
        permuted,
      );

      // Identical re-derivation, fresh values: the rebuild differs from the
      // stored form byte-wise (sorted entries, normalized clause) — the
      // storage-layer elision would NOT absorb this write — but is
      // canonically equal, so the SC-11 skip must elide it.
      const second = derive("2");
      expect(second.wroteCfc).toBe(false);
      expect((await second.tx.commit()).ok).toBeDefined();

      // Storage-layer contract: the stored envelope is byte-untouched while
      // the value writes landed.
      const after = getDocument(targetId) as {
        value: { a?: string; b?: string };
        cfc: unknown;
      };
      expect(after.cfc).toEqual(permuted);
      expect(after.value).toEqual({ a: "a-2", b: "b-2" });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("observe mode derives the join as a diagnostic and persists nothing", async () => {
    // H1 observe-mode contract (enforcement-matrix rollout constraint 1:
    // measure under `observe` before a host flips to `persist`): the join IS
    // derived and surfaced as a diagnostic, and NOTHING persists — no ["cfc"]
    // write in the transaction, no envelope on the stored target at all.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // The assertions below read that the join is reported as a diagnostic
      // and that neither the transaction nor the stored document carries an
      // envelope. That holds at the `observe` rung.
      cfcFlowLabels: "observe",
    });
    try {
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-flow-observe-source",
          { type: "object", properties: { secret: { type: "string" } } },
        ).getAsLink(),
      ).id!;
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "s3cr3t" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      // The same laundering shape the persist tests use: read the secret,
      // write a derived plain value to an unlabeled doc.
      const tx = runtime.edit();
      const raw = runtime.getCell(
        signer.did(),
        "cfc-flow-observe-source",
        undefined,
        tx,
      ).getRaw() as { secret?: string };
      expect(raw.secret).toBe("s3cr3t");
      const target = runtime.getCell(
        signer.did(),
        "cfc-flow-observe-target",
        undefined,
        tx,
      );
      target.set({ copied: `${raw.secret}!` });
      tx.prepareCfc();

      // The join was derived and reported...
      expect(
        tx.getCfcState().diagnostics.some((d) =>
          /^flow-labels\(observe\): would derive 1 confidentiality \/ 0 integrity atom\(s\) onto \d+ written doc\(s\)$/
            .test(d)
        ),
      ).toBe(true);
      // ...but nothing was persisted: no ["cfc"] write in this transaction...
      const targetId = target.getAsNormalizedFullLink().id;
      expect(
        [...(tx.getWriteDetails?.(signer.did()) ?? [])].some(
          (w) => w.address.id === targetId && w.address.path[0] === "cfc",
        ),
      ).toBe(false);
      expect((await tx.commit()).ok).toBeDefined();

      // ...and the stored doc carries no envelope at all (no version bump
      // from label persistence — the doc has exactly its value).
      const storedTarget = (storageManager.open(signer.did())
        .replica as unknown as {
          getDocument(id: string): { cfc?: unknown } | undefined;
        }).getDocument(targetId);
      expect(storedTarget).toBeDefined();
      expect(storedTarget!.cfc).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("joins trigger-read labels into the derived component", async () => {
    // A2: trigger reads (§8.9.2). The decision to run was influenced by the
    // triggering change even when the run never reads the changed value, so
    // its labels join the derivation.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // At this rung the writer-fit check flags a tainted write to a store
      // that declares no ceiling and lets it land. The out doc declares
      // none, and the `entry` assertions below read back what that write
      // persisted.
      cfcEnforcementMode: "enforce-explicit",
      // Persisting the derived join is what puts that entry in the document.
      cfcFlowLabels: "persist",
    });
    try {
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-trigger-source",
          { type: "object", properties: { secret: { type: "string" } } },
        ).getAsLink(),
      ).id!;
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "s3cr3t" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      // The transaction reads nothing — only the trigger connects it to
      // the labeled doc.
      const tx = runtime.edit();
      tx.addCfcTriggerReads([{
        space: signer.did(),
        id: sourceId,
        type: "application/json",
        path: ["value", "secret"],
      }]);
      const out = runtime.getCell(
        signer.did(),
        "cfc-trigger-out",
        undefined,
        tx,
      );
      out.set({ flag: 1 });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const outId = out.getAsNormalizedFullLink().id;
      const entry = replicaEntries(storageManager, outId).find((e) =>
        e.origin === "derived"
      );
      expect(entry).toBeDefined();
      expect(entry!.label.confidentiality).toContainEqual("secret");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("taints rerun writes with the triggering change's labels", async () => {
    // A2 end-to-end through the scheduler: run 1 subscribes to the labeled
    // doc; the rerun triggered by its change takes a branch that never
    // re-reads it, yet the rerun's write is tainted via the recorded trigger.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // At this rung the writer-fit check flags a tainted write to a store
      // that declares no ceiling and lets it land. The flag doc declares
      // none, and the `entry` assertions below read back what the rerun's
      // write persisted.
      cfcEnforcementMode: "enforce-explicit",
      // Persisting the derived join is what puts that entry in the document.
      cfcFlowLabels: "persist",
    });
    try {
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-trigger-sched-source",
          { type: "object", properties: { secret: { type: "string" } } },
        ).getAsLink(),
      ).id!;
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "v1" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const setup = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "cfc-trigger-sched-source",
        undefined,
        setup,
      );
      const flag = runtime.getCell(
        signer.did(),
        "cfc-trigger-sched-flag",
        undefined,
        setup,
      );
      setup.abort();

      let runs = 0;
      const action: Action = (atx) => {
        runs++;
        if (runs === 1) {
          // Subscribe to the labeled doc.
          source.withTx(atx).getRaw();
        } else {
          // Branch away: never re-read the source, just write the flag.
          flag.withTx(atx).set({ ran: runs });
        }
      };
      runtime.scheduler.subscribe(
        action,
        { reads: [], shallowReads: [], writes: [] },
        { isEffect: true },
      );
      await runtime.idle();
      expect(runs).toBe(1);

      const bump = runtime.edit();
      bump.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: ["value", "secret"],
      }, "v2");
      recordSecretWritePolicy(bump, sourceId);
      bump.prepareCfc();
      expect((await bump.commit()).ok).toBeDefined();
      await runtime.idle();
      expect(runs).toBeGreaterThan(1);

      const flagId = flag.getAsNormalizedFullLink().id;
      const entry = replicaEntries(storageManager, flagId).find((e) =>
        e.origin === "derived"
      );
      expect(entry).toBeDefined();
      expect(entry!.label.confidentiality).toContainEqual("secret");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps trigger-read labels across a RetryImmediately rerun", async () => {
    // A2 + retry: the triggered rerun aborts with RetryImmediately, so its
    // consumed trigger reads must be restored for the retry run — otherwise
    // the retry's writes are under-tainted (the run still exists only because
    // the labeled dep changed).

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // At this rung the writer-fit check flags a tainted write to a store
      // that declares no ceiling and lets it land. The flag doc declares
      // none, and the `entry` assertions below read back what the retry's
      // write persisted.
      cfcEnforcementMode: "enforce-explicit",
      // Persisting the derived join is what puts that entry in the document.
      cfcFlowLabels: "persist",
    });
    try {
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-trigger-retry-source",
          { type: "object", properties: { secret: { type: "string" } } },
        ).getAsLink(),
      ).id!;
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "v1" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const setup = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "cfc-trigger-retry-source",
        undefined,
        setup,
      );
      const flag = runtime.getCell(
        signer.did(),
        "cfc-trigger-retry-flag",
        undefined,
        setup,
      );
      setup.abort();

      let runs = 0;
      const action: Action = (atx) => {
        runs++;
        if (runs === 1) {
          // Subscribe to the labeled doc.
          source.withTx(atx).getRaw();
        } else if (runs === 2) {
          // The triggered rerun aborts; the scheduler re-runs it.
          throw new RetryImmediately();
        } else {
          // The retry branches away: never re-reads the source.
          flag.withTx(atx).set({ ran: runs });
        }
      };
      runtime.scheduler.subscribe(
        action,
        { reads: [], shallowReads: [], writes: [] },
        { isEffect: true },
      );
      await runtime.idle();
      expect(runs).toBe(1);

      const bump = runtime.edit();
      bump.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: ["value", "secret"],
      }, "v2");
      recordSecretWritePolicy(bump, sourceId);
      bump.prepareCfc();
      expect((await bump.commit()).ok).toBeDefined();
      await runtime.idle();
      expect(runs).toBeGreaterThanOrEqual(3);

      const flagId = flag.getAsNormalizedFullLink().id;
      const entry = replicaEntries(storageManager, flagId).find((e) =>
        e.origin === "derived"
      );
      expect(entry).toBeDefined();
      expect(entry!.label.confidentiality).toContainEqual("secret");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
