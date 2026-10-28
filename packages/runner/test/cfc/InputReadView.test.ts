import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";

import {
  InputReadView,
  VerifierMetadataResolver,
} from "../../src/cfc/prepare.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { internalVerifierRead } from "../../src/storage/reactivity-log.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-input-read-view");
const space = signer.did();

describe("InputReadView", () => {
  // The boundary pass verifies every written target against the reads the
  // transaction made, and a commit of many targets asks for the same reads
  // once per target. These pin that the pass builds the view once and reuses
  // it, and that the view does not outlive what it was built from: a read it
  // has not seen, or a write that retires an envelope it resolved.

  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const newRuntime = () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    return runtime;
  };

  const address = (id: string) => ({
    space,
    scope: "space" as const,
    id: `of:${id}` as URI,
    path: [] as string[],
  });

  /** Commits a document holding `{ field: "stored" }` under a secret label. */
  const seedLabeled = async (runtime: Runtime, id: string) => {
    const seed = runtime.edit();
    const labeled = address(id);
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(seed, labeled, {
      value: { field: "stored" },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: ["field"],
            observes: "value",
            label: { confidentiality: ["secret"] },
          }],
        },
      },
    });
    expect((await seed.commit().settled).error).toBeUndefined();
    return labeled;
  };

  it("is built once by a boundary pass that verifies many targets", () => {
    const runtime = newRuntime();
    const tx = runtime.edit();
    try {
      for (let index = 0; index < 4; index++) {
        tx.readOrThrow({ ...address(`source-${index}`), path: ["value"] });
      }
      const targets = 6;
      for (let index = 0; index < targets; index++) {
        const target = address(`target-${index}`);
        tx.writeValueOrThrow(target, { text: `row ${index}` });
        tx.recordCfcWritePolicyInput({
          kind: "schema",
          target,
          schema: {
            type: "object",
            properties: { text: { type: "string" } },
          },
        });
      }
      // Nothing above reads a labeled document, so the boundary pass runs
      // only once the transaction is marked relevant. No target's document
      // stores a schema, so each is verified once, under its candidate.
      tx.markCfcRelevant();
      runtime.resetCfcStats();
      runtime.prepareTxForCommit(tx);
      expect(tx.getCfcState().prepare.status).toBe("prepared");
      const stats = runtime.getCfcStats();
      expect(stats.inputReadViewsBuilt).toBe(1);
      expect(stats.inputReadViewsReused).toBe(targets - 1);
    } finally {
      tx.abort();
    }
  });

  describe("instance members", () => {
    describe("reads()", () => {
      it("returns the set it built until a read it has not seen is recorded", () => {
        const runtime = newRuntime();
        const tx = runtime.edit();
        try {
          tx.readOrThrow({ ...address("first"), path: ["value"] });
          const view = new InputReadView(tx);
          const reads = view.reads();
          expect(reads.map((read) => read.id)).toEqual(["of:first"]);
          expect(view.reads()).toBe(reads);
          tx.readOrThrow({ ...address("second"), path: ["value"] });
          const after = view.reads();
          expect(after).not.toBe(reads);
          expect(after.map((read) => read.id)).toEqual([
            "of:first",
            "of:second",
          ]);
          expect(view.reads()).toBe(after);
        } finally {
          tx.abort();
        }
      });

      it("returns the reads as each record is classified at that ask", () => {
        // A record keeps its place in the transaction's list while its
        // internal-verifier classification changes, so the list's length
        // says nothing about it.

        const runtime = newRuntime();
        const tx = runtime.edit();
        try {
          tx.readOrThrow({ ...address("reclassified"), path: ["value"] });
          const record = [...tx.getReadActivities!()].at(-1)!;
          const view = new InputReadView(tx);
          expect(view.reads().map((read) => read.id)).toEqual([
            "of:reclassified",
          ]);

          const meta = { ...internalVerifierRead };
          record.meta = meta;
          expect(view.reads()).toEqual([]);

          for (const key of Reflect.ownKeys(meta)) delete meta[key];
          expect(view.reads().map((read) => read.id)).toEqual([
            "of:reclassified",
          ]);
        } finally {
          tx.abort();
        }
      });
    });

    describe("sourceMetadata()", () => {
      it("returns the envelopes it resolved until a write retires one", async () => {
        const runtime = newRuntime();
        const labeled = await seedLabeled(runtime, "labeled-envelope");
        const tx = runtime.edit();
        try {
          tx.readOrThrow({ ...labeled, path: ["value", "field"] });
          tx.readOrThrow({ ...address("plain"), path: ["value"] });
          const view = new InputReadView(tx);
          const resolver = new VerifierMetadataResolver(tx);
          view.reads();
          resolver.refresh();
          const envelopes = view.sourceMetadata(resolver);
          expect(envelopes[0]?.labelMap.entries).toHaveLength(1);
          expect(envelopes[1]).toBeUndefined();
          resolver.refresh();
          expect(view.sourceMetadata(resolver)).toBe(envelopes);

          // A write to a document the view never resolved retires nothing.
          tx.writeOrThrow({ ...address("other"), path: ["value"] }, { n: 1 });
          resolver.refresh();
          expect(view.sourceMetadata(resolver)).toBe(envelopes);

          tx.writeOrThrow({ ...labeled, path: ["value", "field"] }, "changed");
          resolver.refresh();
          const after = view.sourceMetadata(resolver);
          expect(after).not.toBe(envelopes);
          expect(after[0]?.labelMap.entries).toHaveLength(1);
        } finally {
          tx.abort();
        }
      });

      it("describes the reads the last `reads()` saw", () => {
        const runtime = newRuntime();
        const tx = runtime.edit();
        try {
          tx.readOrThrow({ ...address("seen"), path: ["value"] });
          const view = new InputReadView(tx);
          const resolver = new VerifierMetadataResolver(tx);
          view.reads();
          tx.readOrThrow({ ...address("later"), path: ["value"] });
          expect(view.sourceMetadata(resolver)).toHaveLength(1);
          expect(view.clockLessReads()).toBe(0);
          expect(view.reads()).toHaveLength(2);
          expect(view.sourceMetadata(resolver)).toHaveLength(2);
        } finally {
          tx.abort();
        }
      });
    });

    describe("gatedReads()", () => {
      it("returns the labeled reads, and the same set until an envelope is retired", async () => {
        const runtime = newRuntime();
        const labeled = await seedLabeled(runtime, "labeled-gated");
        const tx = runtime.edit();
        try {
          tx.readOrThrow({ ...labeled, path: ["value", "field"] });
          tx.readOrThrow({ ...address("unlabeled"), path: ["value"] });
          const view = new InputReadView(tx);
          const resolver = new VerifierMetadataResolver(tx);
          view.reads();
          resolver.refresh();
          const gated = view.gatedReads(resolver);
          expect(gated.map((read) => read.id)).toEqual(["of:labeled-gated"]);
          expect(gated[0].label).toEqual({ confidentiality: ["secret"] });
          expect(view.gatedReads(resolver)).toBe(gated);

          tx.writeOrThrow({ ...labeled, path: ["value", "field"] }, "changed");
          resolver.refresh();
          expect(view.gatedReads(resolver)).not.toBe(gated);
        } finally {
          tx.abort();
        }
      });
    });
  });
});
