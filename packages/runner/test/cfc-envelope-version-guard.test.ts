import { internSchema } from "@commonfabric/data-model-schema";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  cfcMetadataPresent,
  readStoredCfcMetadata,
  storedCfcMetadataAppliesToPath,
  StoredCfcMetadataError,
  UnknownCfcMetadataVersionError,
  UnreadableCfcMetadataError,
} from "../src/cfc/metadata.ts";
import { loadStoredCfcEnvelope } from "../src/cfc/prepare.ts";
import { cfcLabelViewForDereference } from "../src/cfc/label-view-state.ts";

const signer = await Identity.fromPassphrase("runner-cfc-envelope-version");
const space = signer.did();

describe("CFC envelope version guard", () => {
  // A stored envelope whose version this build postdates cannot be treated as
  // absent — that would read a labeled document as unlabeled. Every reader
  // fails closed instead: the metadata reader throws, the applies-to-path probe
  // reports that policy applies, and the commit path classifies the envelope as
  // unreadable and rejects the write.

  const seedWithVersion = async (
    runtime: Runtime,
    name: string,
    version: number,
  ): Promise<`${string}:${string}`> => {
    const id = parseLink(runtime.getCell(space, name).getAsLink()).id!;
    const seed = runtime.edit();
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
      value: { secret: "sealed" },
      cfc: {
        version,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path: [], label: { confidentiality: ["vaulted"] } }],
        },
      },
    });
    expect((await seed.commit()).ok).toBeDefined();
    return id;
  };

  it("throws from the metadata reader for a version it does not interpret", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const id = await seedWithVersion(runtime, "version-guard-throw", 4);
      const tx = runtime.edit();
      expect(() => readStoredCfcMetadata(tx, { space, id })).toThrow(
        UnknownCfcMetadataVersionError,
      );
      tx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("reports that stored policy applies to a path it cannot interpret", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const id = await seedWithVersion(runtime, "version-guard-applies", 4);
      const tx = runtime.edit();
      expect(
        storedCfcMetadataAppliesToPath(tx, {
          space,
          scope: "space",
          id,
          path: ["secret"],
        }),
      ).toBe(true);
      tx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects an enforcing write whose stored envelope version is unknown", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      await seedWithVersion(runtime, "version-guard-write", 4);
      const tx = runtime.edit();
      const cell = runtime.getCell(space, "version-guard-write", {
        type: "object",
        properties: {
          secret: { type: "string", ifc: { confidentiality: ["vaulted"] } },
        },
        required: ["secret"],
      }, tx);
      cell.set({ secret: "updated" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "not one this build interprets",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects an enforcing write to a document whose own envelope shape it cannot walk", async () => {
    // The write TARGET's envelope, where the read-source cases below cover the
    // documents a transaction consumed. This one reaches the commit path
    // through `loadStoredCfcEnvelope`, which classifies an envelope it cannot
    // interpret as unreadable and records the reason rather than letting the
    // read throw out of the boundary pass.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const id = parseLink(
        runtime.getCell(space, "shape-guard-target").getAsLink(),
      ).id!;
      const seed = runtime.edit();
      writeSeedEnvelopeDoc(seed, space);
      seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
        value: { secret: "sealed" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: { version: 1, entries: [{ path: ["secret"] }] },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      const cell = runtime.getCell(space, "shape-guard-target", {
        type: "object",
        properties: {
          secret: { type: "string", ifc: { confidentiality: ["vaulted"] } },
        },
        required: ["secret"],
      }, tx);
      cell.set({ secret: "updated" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "carries no label map this build can read",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects an enforcing write that READ a document whose envelope shape it cannot walk", async () => {
    // The version is one this build interprets and the label map is not: no
    // entries to walk, an entry with no path to match a read against, an
    // array where an entry or a label belongs, an entry with no label to
    // read clauses out of, or clauses that are not a list. Reading a label is what meets these, so the refusal has to be
    // reached by every transaction that read the document, not only by one
    // whose write target declares a requirement.
    const shapes = {
      "no-label-map": { version: 1, schemaHash: SEED_ENVELOPE_SCHEMA_HASH },
      "no-entries": {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1 },
      },
      "pathless-entry": {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries: [{ label: {} }] },
      },
      "labelless-entry": {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries: [{ path: ["secret"] }] },
      },
      "array-entry": {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries: [[]] },
      },
      "array-label": {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries: [{ path: ["secret"], label: [] }] },
      },
      "unreadable-clauses": {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path: ["secret"], label: { confidentiality: "secret" } }],
        },
      },
    };
    for (const [name, envelope] of Object.entries(shapes)) {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      try {
        const sourceId = parseLink(
          runtime.getCell(space, `shape-guard-src-${name}`).getAsLink(),
        ).id!;
        const seed = runtime.edit();
        writeSeedEnvelopeDoc(seed, space);
        seedStoredEnvelope(seed, {
          space,
          scope: "space",
          id: sourceId,
          path: [],
        }, {
          value: { secret: "sealed" },
          cfc: envelope,
        });
        expect((await seed.commit()).ok).toBeDefined();

        const tx = runtime.edit();
        tx.readOrThrow({
          space,
          scope: "space",
          id: sourceId,
          type: "application/json",
          path: ["value", "secret"],
        });
        const target = runtime.getCell(space, `shape-guard-dst-${name}`, {
          type: "object",
          properties: {
            note: { type: "string", ifc: { confidentiality: ["vaulted"] } },
          },
        }, tx);
        target.set({ note: "copied" });
        tx.prepareCfc();
        const result = await tx.commit();
        expect(result.error?.message).toContain(
          "carries no label map this build can read",
        );
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    }
  });

  it("rejects an enforcing write that READ a document whose envelope version is unknown", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      // The read source carries the unreadable envelope and the write target
      // is a different document, whose schema declares no requiredIntegrity
      // and no maxConfidentiality. The write-side input gate is what resolves
      // a read's stored envelope, and the reason it must resolve every read's
      // rather than only the ones a requirement quantifies over.
      const sourceId = await seedWithVersion(runtime, "version-guard-src", 4);
      const tx = runtime.edit();
      tx.readOrThrow({
        space,
        scope: "space",
        id: sourceId,
        type: "application/json",
        path: ["value", "secret"],
      });
      const target = runtime.getCell(space, "version-guard-dst", {
        type: "object",
        properties: {
          note: { type: "string", ifc: { confidentiality: ["vaulted"] } },
        },
      }, tx);
      target.set({ note: "copied" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "not one this build interprets",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("fails closed on an unknown version whose format renamed every field", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      // The reserved position is what qualifies the record, never its
      // field names: a future format that renamed schemaHash and labelMap
      // must refuse exactly like one that kept them — no schemaHash means
      // the commit boundary has nothing to back, so the seed lands.
      const id = parseLink(
        runtime.getCell(space, "version-guard-renamed").getAsLink(),
      ).id!;
      const seed = runtime.edit();
      seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
        value: { secret: "sealed" },
        cfc: { version: 4, payload: { labels: [] } },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      expect(() => readStoredCfcMetadata(tx, { space, id })).toThrow(
        UnknownCfcMetadataVersionError,
      );
      expect(() =>
        cfcLabelViewForDereference(
          tx,
          { space, scope: "space", id, path: [] },
          { space, scope: "space", id, path: [] },
        )
      ).toThrow(UnknownCfcMetadataVersionError);
      tx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("refuses a record that merely carries an envelope-shaped member", () => {
    // `["cfc"]` is the one metadata position, and what stands there is the
    // envelope itself. A record holding an envelope-shaped member is not an
    // envelope this build interprets, so it fails closed rather than
    // resolving the member as one.
    const tx = {
      readOrThrow: () => ({
        cfc: {
          version: 1,
          schemaHash: "inner-envelope",
          labelMap: { version: 1, entries: [] },
        },
      }),
    } as unknown as Parameters<typeof readStoredCfcMetadata>[0];
    expect(() => readStoredCfcMetadata(tx, { space, id: "of:nested" }))
      .toThrow(UnreadableCfcMetadataError);
  });

  it("propagates a transaction failure from the applies-to-path probe", () => {
    // Only the unknown-version refusal converts to the fail-closed
    // "applies" answer; an erroring transaction stays the caller's
    // operational failure.
    const tx = {
      readOrThrow: () => {
        throw new Error("torn read");
      },
    } as unknown as Parameters<typeof storedCfcMetadataAppliesToPath>[0];
    expect(() =>
      storedCfcMetadataAppliesToPath(tx, {
        space,
        scope: "space",
        id: "of:torn" as `${string}:${string}`,
        path: [],
      })
    ).toThrow("torn read");
  });

  it("fails the dereference label view loudly instead of serving unlabeled", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      // The failure the guard exists to prevent: a SECRET-labeled envelope
      // under a version this build postdates must never come back as "no
      // stored labels" — that view feeds the flow join deciding what a
      // write may carry.
      const id = await seedWithVersion(runtime, "version-guard-deref", 4);
      const tx = runtime.edit();
      expect(() =>
        cfcLabelViewForDereference(
          tx,
          { space, scope: "space", id, path: [] },
          { space, scope: "space", id, path: [] },
        )
      ).toThrow(UnknownCfcMetadataVersionError);
      tx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps a link-write from an uninterpretable source CFC-relevant and refuses it", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      // Legacy link persistence derives the target's labels.
      cfcFlowLabels: "off",
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      await seedWithVersion(runtime, "version-guard-link-source", 4);
      const tx = runtime.edit();
      const source = runtime.getCell(
        space,
        "version-guard-link-source",
        undefined,
        tx,
      );
      const target = runtime.getCell(
        space,
        "version-guard-link-target",
        undefined,
        tx,
      );
      // The link write's source-relevance probe cannot interpret the
      // stored envelope; fail closed means the write records as
      // CFC-relevant and prepare meets the same unreadable envelope.
      target.key("ref").set(source.getAsLink() as never);
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("not one this build interprets");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("acquires a known target address without admitting its uninterpretable contents", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcFlowLabels: "persist",
      cfcEnforcementMode: "enforce-strict",
    });
    try {
      await seedWithVersion(runtime, "version-guard-precise-source", 4);
      const tx = runtime.edit();
      const source = runtime.getCell(
        space,
        "version-guard-precise-source",
        undefined,
        tx,
      );
      const holder = runtime.getCell(
        space,
        "version-guard-precise-holder",
        undefined,
        tx,
      );
      holder.key("ref").set(source.getAsLink() as never);
      tx.prepareCfc();
      expect((await tx.commit()).error).toBeUndefined();
      const read = runtime.edit();
      try {
        expect(() => holder.withTx(read).key("ref").get()).toThrow(
          "not one this build interprets",
        );
      } finally {
        read.abort();
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("loads an envelope whose stored root references its definition", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      // One read policy, no version distinction: a version-1 root carrying
      // `$ref: cid:` members (the trail a reference-form declared schema
      // leaves) resolves through the space, or the envelope is unreadable.
      const child = internSchema(
        {
          type: "string",
          ifc: { confidentiality: ["guarded"] },
        } as JSONSchema,
        true,
      );
      const root = internSchema(
        {
          type: "object",
          properties: { secret: { $ref: `cid:${child.taggedHashString}` } },
        } as JSONSchema,
        true,
      );
      const id = parseLink(
        runtime.getCell(space, "version-guard-refs").getAsLink(),
      ).id!;
      const seed = runtime.edit();
      for (const sah of [child, root]) {
        seed.writeOrThrow({
          space,
          scope: "space",
          id: `cid:${sah.taggedHashString}` as `${string}:${string}`,
          path: [],
        }, { value: sah.schema });
      }
      seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
        value: { secret: "sealed" },
        cfc: {
          version: 1,
          schemaHash: root.taggedHashString,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["guarded"] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      const envelope = loadStoredCfcEnvelope(tx, { space, id });
      expect(envelope.status).toBe("loaded");
      if (envelope.status !== "loaded") throw new Error("unreachable");
      const spelled = JSON.stringify(envelope.schema);
      expect(spelled).not.toContain("cid:");
      expect(spelled).toContain('"guarded"');
      tx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  describe("stored CFC envelope readers", () => {
    // A stored value at the reserved `["cfc"]` position gets one of three
    // outcomes, whichever reader reaches it: an envelope, nothing stored at
    // all, or a fail-closed `StoredCfcMetadataError`. The readers below reach that position for
    // different consumers — `readStoredCfcMetadata` for the writers and label
    // views that depend on the envelope, `loadStoredCfcEnvelope` for the commit
    // boundary, `storedCfcMetadataAppliesToPath` for the relevance probe — so a
    // value one of them cannot interpret is one none of them may read as an
    // unlabeled document.

    const entriesHolding = (entries: unknown) => ({
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: { version: 1, entries },
    });

    const uninterpretable: Record<string, unknown> = {
      "a version this build does not know": {
        version: 4,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries: [] },
      },
      "no version at all": {
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: ["secret"],
            label: { confidentiality: ["vaulted"] },
          }],
        },
      },
      "an array where the envelope belongs": [],
      "no label map": { version: 1, schemaHash: SEED_ENVELOPE_SCHEMA_HASH },
      "no entries": {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1 },
      },
      "an entry with no path": entriesHolding([{ label: {} }]),
      "an entry with no label": entriesHolding([{ path: ["secret"] }]),
      "an array where an entry belongs": entriesHolding([[]]),
      "an array where a label belongs": entriesHolding([{
        path: ["secret"],
        label: [],
      }]),
      "a path segment that is not a string": entriesHolding([{
        path: [1],
        label: { confidentiality: ["vaulted"] },
      }]),
      "clauses that are not a list": entriesHolding([{
        path: ["secret"],
        label: { confidentiality: "vaulted" },
      }]),
      "a label member this build does not know": entriesHolding([{
        path: ["secret"],
        label: { confidentiality: ["vaulted"], secrecy: ["vaulted"] },
      }]),
      "a label map of a version this build does not know": {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 2,
          entries: [{
            path: ["secret"],
            label: { confidentiality: ["vaulted"] },
          }],
        },
      },
      "no schema hash": {
        version: 1,
        labelMap: {
          version: 1,
          entries: [{
            path: ["secret"],
            label: { confidentiality: ["vaulted"] },
          }],
        },
      },
    };

    for (const [name, cfc] of Object.entries(uninterpretable)) {
      it(`fails closed in every reader for ${name}`, async () => {
        const storageManager = StorageManager.emulate({ as: signer });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
        });
        try {
          const id = parseLink(
            runtime.getCell(space, `reader-agreement-${name}`).getAsLink(),
          ).id!;
          const seed = runtime.edit();
          writeSeedEnvelopeDoc(seed, space);
          seedStoredEnvelope(
            seed,
            { space, scope: "space", id, path: [] },
            { value: { secret: "sealed" }, cfc } as never,
          );
          expect((await seed.commit()).ok).toBeDefined();

          const tx = runtime.edit();
          let thrown: unknown;
          try {
            readStoredCfcMetadata(tx, { space, id });
          } catch (error) {
            thrown = error;
          }
          expect(thrown instanceof StoredCfcMetadataError).toBe(true);
          expect(loadStoredCfcEnvelope(tx, { space, id }).status).toBe(
            "unreadable",
          );
          expect(
            storedCfcMetadataAppliesToPath(tx, {
              space,
              scope: "space",
              id,
              path: ["secret"],
            }),
          ).toBe(true);
          // The erasure guard's account of what presents a label map is the
          // same classification: a value no reader can interpret is a map
          // standing there, not a document with none.
          expect(cfcMetadataPresent(cfc)).toBe(true);
          tx.abort();
        } finally {
          await runtime.dispose();
          await storageManager.close();
        }
      });
    }

    it("reads an envelope carrying members it does not know", async () => {
      // The version is how the format announces content this build does not
      // read, so a member beside the ones it defines is not a reason to
      // refuse: the spec leaves a migrating writer free to keep a legacy
      // field, and an entry carries view-specific refinements beside its
      // label. Refusing those would read a labeled document as unreadable
      // where its labels are right there.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      try {
        const id = parseLink(
          runtime.getCell(space, "reader-agreement-extra").getAsLink(),
        ).id!;
        const seed = runtime.edit();
        writeSeedEnvelopeDoc(seed, space);
        seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
          value: { secret: "sealed" },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            provenance: "a field this build does not define",
            labelMap: {
              version: 1,
              ordering: "declared",
              entries: [{
                path: ["secret"],
                label: { confidentiality: ["vaulted"] },
                views: { ranges: [] },
              }],
            },
          },
        } as never);
        expect((await seed.commit()).ok).toBeDefined();

        const tx = runtime.edit();
        expect(readStoredCfcMetadata(tx, { space, id })?.labelMap.entries[0])
          .toMatchObject({
            path: ["secret"],
            label: { confidentiality: ["vaulted"] },
          });
        expect(loadStoredCfcEnvelope(tx, { space, id }).status).toBe("loaded");
        tx.abort();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("throws from an unschema'd write to a document carrying one", async () => {
      // The write gate is what a transaction with no `ifc` schema and no
      // stored-policy relevance would otherwise skip: it resolves the
      // document's stored envelope to find the schema the write is
      // against, so a document no reader can interpret fails the write at
      // the call site rather than letting it commit ungated.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      try {
        const id = parseLink(
          runtime.getCell(space, "reader-agreement-write").getAsLink(),
        ).id!;
        const seed = runtime.edit();
        writeSeedEnvelopeDoc(seed, space);
        seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
          value: { secret: "sealed" },
          cfc: {
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{
                path: ["secret"],
                label: { confidentiality: ["vaulted"] },
              }],
            },
          },
        } as never);
        expect((await seed.commit()).ok).toBeDefined();

        const tx = runtime.edit();
        expect(() =>
          runtime.getCell(space, "reader-agreement-write", undefined, tx)
            .set({ secret: "leaked" })
        ).toThrow(UnreadableCfcMetadataError);
        tx.abort();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("reads a document storing nothing at the reserved position as unlabeled", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      try {
        const id = parseLink(
          runtime.getCell(space, "reader-agreement-absent").getAsLink(),
        ).id!;
        const seed = runtime.edit();
        seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
          value: { secret: "sealed" },
          cfc: null,
        });
        expect((await seed.commit()).ok).toBeDefined();

        const tx = runtime.edit();
        expect(readStoredCfcMetadata(tx, { space, id })).toBeUndefined();
        expect(loadStoredCfcEnvelope(tx, { space, id }).status).toBe("none");
        expect(
          storedCfcMetadataAppliesToPath(tx, {
            space,
            scope: "space",
            id,
            path: ["secret"],
          }),
        ).toBe(false);
        tx.abort();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });
});
