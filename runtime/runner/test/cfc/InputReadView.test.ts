import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import { afterEach, describe, it } from "@commonfabric/test-support/test";

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
          const meta = { ...internalVerifierRead };
          tx.readOrThrow({ ...address("reclassified"), path: ["value"] }, {
            meta,
          });
          const view = new InputReadView(tx);
          expect(view.reads()).toEqual([]);

          for (const key of Reflect.ownKeys(meta)) delete meta[key];
          expect(view.reads().map((read) => read.id)).toEqual([
            "of:reclassified",
          ]);

          Object.assign(meta, internalVerifierRead);
          expect(view.reads()).toEqual([]);
        } finally {
          tx.abort();
        }
      });

      it("returns the reads as each record is classified by what its metadata inherits", () => {
        // A frozen metadata object cannot change, but what it inherits from
        // `Object.prototype` can, and that classifies its reads too.

        const runtime = newRuntime();
        const tx = runtime.edit();
        const [marker] = Reflect.ownKeys(internalVerifierRead);
        try {
          tx.readOrThrow({ ...address("inherited"), path: ["value"] });
          const view = new InputReadView(tx);
          expect(view.reads().map((read) => read.id)).toEqual([
            "of:inherited",
          ]);

          Object.defineProperty(Object.prototype, marker, {
            value: true,
            configurable: true,
          });
          try {
            expect(view.reads()).toEqual([]);
          } finally {
            Reflect.deleteProperty(Object.prototype, marker);
          }
          expect(view.reads().map((read) => read.id)).toEqual([
            "of:inherited",
          ]);
        } finally {
          tx.abort();
        }
      });

      it("compares no record with its copy while the transaction lists the same records", () => {
        // A boundary pass asks once for each target it verifies. An ask that
        // compared every record would cost the targets times the reads.

        const runtime = newRuntime();
        const tx = runtime.edit();
        try {
          const records = 40;
          for (let index = 0; index < records; index++) {
            tx.readOrThrow({ ...address(`read-${index}`), path: ["value"] });
          }
          const view = new InputReadView(tx);
          const reads = view.reads();
          expect(reads).toHaveLength(records);
          for (let ask = 0; ask < 25; ask++) {
            expect(view.reads()).toBe(reads);
          }
          expect(view.recordsCompared).toBe(0);
          expect(view.metadataObjectsClassified).toBe(0);
        } finally {
          tx.abort();
        }
      });

      it("classifies no more metadata objects for more cells written", () => {
        // The write path records its reads of each destination under
        // metadata objects of its own. Each is frozen, so an ask does not
        // classify one for every cell the transaction wrote.

        const classified = (cells: number) => {
          const runtime = newRuntime();
          const tx = runtime.edit();
          try {
            for (let index = 0; index < cells; index++) {
              runtime.getCell(space, `written-${index}`, {
                type: "object",
                properties: { text: { type: "string" } },
              }, tx).set({ text: `row ${index}` });
            }
            const view = new InputReadView(tx);
            view.reads();
            view.reads();
            return view.metadataObjectsClassified;
          } finally {
            tx.abort();
          }
        };
        expect(classified(40)).toBe(classified(4));
      });

      it("fixes the metadata object of each record it has copied", () => {
        const runtime = newRuntime();
        const tx = runtime.edit();
        try {
          tx.readOrThrow({ ...address("fixed"), path: ["value"] });
          const record = [...tx.getReadActivities!()].at(-1)!;
          const view = new InputReadView(tx);
          view.reads();
          expect(() => {
            record.meta = { ...internalVerifierRead };
          }).toThrow(TypeError);
          expect(view.reads().map((read) => read.id)).toEqual(["of:fixed"]);
        } finally {
          tx.abort();
        }
      });

      it("compares every record of a transaction that does not fix its records", () => {
        // Such a transaction leaves each record open to another metadata
        // object, which only a comparison of every record finds.

        const runtime = newRuntime();
        const tx = runtime.edit();
        try {
          tx.readOrThrow({ ...address("open"), path: ["value"] });
          const record = [...tx.getReadActivities!()].at(-1)!;
          const open = new Proxy(tx, {
            get(target, prop) {
              if (prop === "freezeReadActivityRecords") return undefined;
              const member = Reflect.get(target, prop, target);
              return typeof member === "function"
                ? member.bind(target)
                : member;
            },
          });
          const view = new InputReadView(open);
          expect(view.reads().map((read) => read.id)).toEqual(["of:open"]);

          const meta = { ...internalVerifierRead };
          record.meta = meta;
          expect(view.reads()).toEqual([]);
          expect(view.recordsCompared).toBe(1);

          for (const key of Reflect.ownKeys(meta)) delete meta[key];
          expect(view.reads().map((read) => read.id)).toEqual(["of:open"]);
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

      it("joins a label-metadata observation as a read of its target that consumed the observed clauses", () => {
        const runtime = newRuntime();
        const tx = runtime.edit();
        try {
          tx.readOrThrow({ ...address("unlabeled"), path: ["value"] });
          const view = new InputReadView(tx);
          const resolver = new VerifierMetadataResolver(tx);
          view.reads();
          resolver.refresh();
          expect(view.gatedReads(resolver)).toEqual([]);

          tx.recordCfcLabelMetadataObservation({
            target: { ...address("observed"), path: ["field"] },
            observes: "labelMetadata",
            confidentiality: ["secret"],
          });
          const gated = view.gatedReads(resolver);
          expect(gated.map((read) => [read.id, read.path, read.label])).toEqual(
            [["of:observed", ["field"], { confidentiality: ["secret"] }]],
          );
          // Label metadata carries no evidence of the value it describes.
          expect(
            gated[0].locations().map((location) => [
              location.confidentiality,
              location.integrity,
              location.evidence,
            ]),
          ).toEqual([[["secret"], [], []]]);
        } finally {
          tx.abort();
        }
      });
    });
  });
});
