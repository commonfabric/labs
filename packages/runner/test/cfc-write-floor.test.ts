import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { linkRefFrom, linkRefPayload } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { CfcCellLinkRefPayload } from "../src/cfc/link-label-view.ts";
import type { CfcWriteFloorMode, IFCLabel } from "../src/cfc/mod.ts";
import { recordReferencedArgumentFields } from "../src/cfc/reference-initialization.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";

const signer = await Identity.fromPassphrase("runner-cfc-write-floor");

// Epic D3 (§8.12.4.1 / SC-18): the write-side `requiredIntegrity` FLOOR. The
// read-side gate (verifyInputRequirements) quantifies over consumed reads; the
// floor tests the WRITTEN VALUE's integrity — schema `addIntegrity` mints,
// carried link-view integrity, the flow hereditary meet — against the declared
// floor. Dial `cfcWriteFloor: off | observe | enforce`. Each case names the
// rung it drives, so the arm under test is the one that decides it.
const ADMIN_ATOM = "admin-approved";
const LLM_DERIVED_ATOM = {
  type: "https://commonfabric.org/cfc/atom/LlmDerived",
};

const FLOOR_SCHEMA = {
  type: "object",
  properties: {
    out: { type: "string", ifc: { requiredIntegrity: [ADMIN_ATOM] } },
  },
  required: ["out"],
} as const satisfies JSONSchema;

// The declaring schema also MINTS the floor atom: writes through it carry the
// integrity they require (the authoring pattern for floor-protected paths).
const MINT_SCHEMA = {
  type: "object",
  properties: {
    out: {
      type: "string",
      ifc: {
        requiredIntegrity: [ADMIN_ATOM],
        addIntegrity: [ADMIN_ATOM],
      },
    },
  },
  required: ["out"],
} as const satisfies JSONSchema;

const makeRuntime = (opts: {
  storageManager: ReturnType<typeof StorageManager.emulate>;
  cfcWriteFloor?: CfcWriteFloorMode;
  cfcFlowLabels?: "off" | "observe" | "persist";
}) =>
  new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager: opts.storageManager,
    ...(opts.cfcWriteFloor !== undefined
      ? { cfcWriteFloor: opts.cfcWriteFloor }
      : {}),
    ...(opts.cfcFlowLabels !== undefined
      ? { cfcFlowLabels: opts.cfcFlowLabels }
      : {}),
  });

// Seed a doc's stored CFC metadata with a path-[] full-document write made
// inside the runtime's privileged persistence scope, so a later link to it
// carries the labels. An ordinary write there is recorded as label forgery.
const seedLabelMap = async (
  runtime: Runtime,
  id: string,
  value: FabricValue,
  entries: { path: string[]; label: IFCLabel }[],
): Promise<void> => {
  const seed = runtime.edit();
  const cell = runtime.getCell(signer.did(), id, undefined, seed);
  const docId = cell.getAsNormalizedFullLink().id as URI;
  writeSeedEnvelopeDoc(seed, signer.did());
  seedStoredEnvelope(seed, {
    space: signer.did(),
    id: docId,
    type: "application/json",
    path: [],
  }, {
    value,
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: { version: 1, entries },
    },
  });
  expect((await seed.commit()).ok).toBeDefined();
};

// Like `seedLabelMap`, with one label at `path`.
const seedLabeledDoc = (
  runtime: Runtime,
  id: string,
  value: FabricValue,
  label: IFCLabel,
  path: string[] = [],
): Promise<void> => seedLabelMap(runtime, id, value, [{ path, label }]);

describe("CFC write-side requiredIntegrity floor (D3, §8.12.4.1)", () => {
  it("rejects an integrity-less write to a floor-declaring path under enforce", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      const tx = runtime.edit();
      const sink = runtime.getCell(
        signer.did(),
        "wf-bare-sink",
        FLOOR_SCHEMA,
        tx,
      );
      sink.set({ out: "unendorsed" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "write floor failed",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("credits a nested link floor using the builtin identity recorded for the write", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      await seedLabeledDoc(runtime, "builtin-source", { nested: "approved" }, {
        integrity: [LLM_DERIVED_ATOM],
      }, ["nested"]);
      const tx = runtime.edit();
      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: "floor-test",
      });
      const source = runtime.getCell(
        signer.did(),
        "builtin-source",
        undefined,
        tx,
      );
      const sink = runtime.getCell(signer.did(), "builtin-sink", {
        type: "object",
        properties: {
          out: {
            type: "object",
            properties: {
              nested: {
                type: "string",
                ifc: { requiredIntegrity: [LLM_DERIVED_ATOM] },
              },
            },
          },
        },
      }, tx);
      sink.set({ out: source });
      tx.setCfcImplementationIdentity(undefined);
      tx.prepareCfc();
      expect((await tx.commit()).error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("credits a nested link floor beside a reader the link's label view carries", async () => {
    // The carried view binds its reader placeholder at `reader`; the floor
    // path `approved` takes its credit from the source's own label there.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      await seedLabelMap(runtime, "reader-source", {
        reader: "r",
        approved: "yes",
      }, [
        {
          path: ["reader"],
          label: {
            confidentiality: [{
              type: CFC_ATOM_TYPE.User,
              subject: signer.did(),
            }],
          },
        },
        { path: ["approved"], label: { integrity: [ADMIN_ATOM] } },
      ]);
      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "reader-source",
        undefined,
        tx,
      );
      const link = linkRefFrom<CfcCellLinkRefPayload>({
        ...linkRefPayload(source.getAsLink()),
        cfcLabelView: {
          version: 1,
          entries: [{
            path: ["reader"],
            label: {
              confidentiality: [{
                type: CFC_ATOM_TYPE.User,
                subject: { __ctCurrentPrincipal: true },
              }],
            },
          }],
        },
      });
      const sink = runtime.getCell(signer.did(), "reader-sink", {
        type: "object",
        properties: {
          out: {
            type: "object",
            properties: {
              approved: {
                type: "string",
                ifc: { requiredIntegrity: [ADMIN_ATOM] },
              },
            },
          },
        },
      }, tx);
      sink.set({ out: link });
      tx.prepareCfc();
      expect((await tx.commit()).error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  for (const storedReader of [true, false]) {
    it(`${storedReader ? "binds" : "refuses"} a carried reader through an object back-reference ${storedReader ? "with" : "without"} an authoritative reader`, async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
      try {
        await seedLabelMap(runtime, "reader-cycle", { reader: "r" }, [
          { path: [], label: { integrity: ["object-proof"] } },
          {
            path: ["reader"],
            label: storedReader
              ? {
                confidentiality: [{
                  type: CFC_ATOM_TYPE.User,
                  subject: signer.did(),
                }],
              }
              : { integrity: ["reader-proof"] },
          },
        ]);
        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "reader-cycle",
          undefined,
          tx,
        );
        const link = linkRefFrom<CfcCellLinkRefPayload>({
          ...linkRefPayload(source.getAsLink()),
          cfcLabelView: {
            version: 1,
            entries: [{
              path: ["loop", "reader"],
              label: {
                confidentiality: [{
                  type: CFC_ATOM_TYPE.User,
                  subject: { __ctCurrentPrincipal: true },
                }],
              },
            }],
          },
        });
        source.key("loop").setRaw(link);
        tx.recordCfcWritePolicyInput({
          kind: "link-write",
          target: { ...source.getAsNormalizedFullLink(), path: ["loop"] },
          source: source.getAsNormalizedFullLink(),
          cfcLabelView: linkRefPayload(link).cfcLabelView,
        });
        recordReferencedArgumentFields(tx, source.getAsNormalizedFullLink(), [
          "loop",
        ]);
        tx.prepareCfc();
        const error = (await tx.commit()).error;
        if (storedReader) {
          expect(error).toBeUndefined();
        } else {
          expect(error?.message).toContain(
            "Link CurrentPrincipal confidentiality requires a concrete stored reader",
          );
        }
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  }

  it("fails a nested link floor under a link whose label view carries a reader the source does not store", async () => {
    // The link itself cannot be derived, so the floor credits nothing from it,
    // in agreement with the persisted labels it would have left.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      await seedLabeledDoc(
        runtime,
        "unbound-reader-source",
        {
          approved: "yes",
        },
        { integrity: [ADMIN_ATOM] },
        ["approved"],
      );
      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "unbound-reader-source",
        undefined,
        tx,
      );
      const link = linkRefFrom<CfcCellLinkRefPayload>({
        ...linkRefPayload(source.getAsLink()),
        cfcLabelView: {
          version: 1,
          entries: [{
            path: ["reader"],
            label: {
              confidentiality: [{
                type: CFC_ATOM_TYPE.User,
                subject: { __ctCurrentPrincipal: true },
              }],
            },
          }],
        },
      });
      const sink = runtime.getCell(signer.did(), "unbound-reader-sink", {
        type: "object",
        properties: {
          out: {
            type: "object",
            properties: {
              approved: {
                type: "string",
                ifc: { requiredIntegrity: [ADMIN_ATOM] },
              },
            },
          },
        },
      }, tx);
      sink.set({ out: link });
      tx.prepareCfc();
      const message = (await tx.commit()).error?.message;
      expect(message).toContain("write floor failed at /out/approved");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("flow-persist with an empty hereditary meet does not weaken the floor", async () => {
    // Under cfcFlowLabels:"persist" the floor credits the flow meet — but an
    // empty meet (the common case: some unlabeled read empties it) credits
    // nothing, so an unendorsed write still rejects. Pins the flowPersist
    // credit branch AND that flow mode cannot become an accidental bypass.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({
      storageManager,
      cfcWriteFloor: "enforce",
      cfcFlowLabels: "persist",
    });
    try {
      const tx = runtime.edit();
      const sink = runtime.getCell(
        signer.did(),
        "wf-flow-sink",
        FLOOR_SCHEMA,
        tx,
      );
      sink.set({ out: "unendorsed" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "write floor failed",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("dial off: the same write commits — byte-compat", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "off" });
    try {
      const tx = runtime.edit();
      const sink = runtime.getCell(
        signer.did(),
        "wf-off-sink",
        FLOOR_SCHEMA,
        tx,
      );
      sink.set({ out: "unendorsed" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("observe: the write commits and a diagnostic records the miss", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "observe" });
    try {
      const tx = runtime.edit();
      const sink = runtime.getCell(
        signer.did(),
        "wf-observe-sink",
        FLOOR_SCHEMA,
        tx,
      );
      sink.set({ out: "unendorsed" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
      expect(
        tx.getCfcState().diagnostics.some((d) =>
          d.includes("write-floor(observe)") && d.includes("write floor")
        ),
      ).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a schema minting its own floor atom passes (addIntegrity credits the value)", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      const tx = runtime.edit();
      const sink = runtime.getCell(
        signer.did(),
        "wf-mint-sink",
        MINT_SCHEMA,
        tx,
      );
      sink.set({ out: "endorsed" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a mint on an array's items does not satisfy a floor on the array path", async () => {
    // The shape a pattern reaches for when a list of endorsed entries is
    // stored behind a floor: each entry mints the atom, the list path
    // declares it. The floor is checked at the path it is declared on, and
    // the items' mints sit below that path, so the list write is unendorsed
    // until the list path mints too. Both halves run here — the item-only
    // shape rejects, the same shape with a path mint commits.
    const items = {
      type: "object",
      properties: {
        subject: { type: "string" },
        displayName: { type: "string" },
      },
      required: ["subject", "displayName"],
      ifc: { addIntegrity: [ADMIN_ATOM] },
    } as const;
    const itemMintOnly = {
      type: "object",
      properties: {
        admins: {
          type: "array",
          items,
          ifc: { requiredIntegrity: [ADMIN_ATOM] },
        },
      },
      required: ["admins"],
    } as const satisfies JSONSchema;
    const alsoPathMint = {
      type: "object",
      properties: {
        admins: {
          type: "array",
          items,
          ifc: { requiredIntegrity: [ADMIN_ATOM], addIntegrity: [ADMIN_ATOM] },
        },
      },
      required: ["admins"],
    } as const satisfies JSONSchema;

    const writeAdmins = async (schema: JSONSchema, id: string) => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
      try {
        const tx = runtime.edit();
        const sink = runtime.getCell(signer.did(), id, schema, tx);
        sink.set({ admins: [{ subject: "alice", displayName: "Alice" }] });
        tx.prepareCfc();
        return String((await tx.commit()).error?.message ?? "");
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    };

    expect(await writeAdmins(itemMintOnly, "wf-item-mint-sink")).toContain(
      "write floor failed",
    );
    expect(await writeAdmins(alsoPathMint, "wf-path-mint-sink")).toBe("");
  });

  it("the floor is a minimum: extra minted integrity is fine", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      const schema = {
        type: "object",
        properties: {
          out: {
            type: "string",
            ifc: {
              requiredIntegrity: [ADMIN_ATOM],
              addIntegrity: [ADMIN_ATOM, "second-endorsement"],
            },
          },
        },
        required: ["out"],
      } as const satisfies JSONSchema;
      const tx = runtime.edit();
      const sink = runtime.getCell(signer.did(), "wf-min-sink", schema, tx);
      sink.set({ out: "endorsed-plus" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("an overwrite is checked against the DECLARED floor only, never the prior value's integrity", async () => {
    // Write 1 links /out to a source whose stored integrity is
    // [ADMIN_ATOM, "extra-endorsement"] — the prior VALUE's integrity exceeds
    // the floor. Write 2 replaces it with a plain value minting only the floor
    // atom. SC-18: sibling replacement B≱A with both ≥ floor conforms — the
    // prior value's richer integrity is never consulted (no meet across
    // successive writes), and integrity legitimately does not regrow.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      await seedLabeledDoc(runtime, "wf-overwrite-src", "endorsed-rich", {
        integrity: [ADMIN_ATOM, "extra-endorsement"],
      });
      const seedTx = runtime.edit();
      const src = runtime.getCell(
        signer.did(),
        "wf-overwrite-src",
        undefined,
        seedTx,
      );
      const first = runtime.getCell(
        signer.did(),
        "wf-overwrite-sink",
        MINT_SCHEMA,
        seedTx,
      );
      first.set({ out: src as unknown as string });
      seedTx.prepareCfc();
      expect((await seedTx.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      const sink = runtime.getCell(
        signer.did(),
        "wf-overwrite-sink",
        MINT_SCHEMA,
        tx,
      );
      sink.set({ out: "new" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a forged runtime-minted atom cannot satisfy a floor keyed to it (mint gate strips first)", async () => {
    // A pattern-authored schema self-attaching LlmDerived: the S4 mint gate
    // strips it from the persisted label, so the written value's integrity is
    // empty and the floor (keyed to LlmDerived) fails — forging evidence
    // satisfies nothing.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      const schema = {
        type: "object",
        properties: {
          out: {
            type: "string",
            ifc: {
              requiredIntegrity: [LLM_DERIVED_ATOM],
              addIntegrity: [LLM_DERIVED_ATOM],
            },
          },
        },
        required: ["out"],
      } as const satisfies JSONSchema;
      const tx = runtime.edit();
      const sink = runtime.getCell(signer.did(), "wf-forged-sink", schema, tx);
      sink.set({ out: "forged" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "write floor failed",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a link whose source carries the floor atom passes (carried link-view integrity)", async () => {
    // The D2 by-reference contract on the write side: a floor-protected slot
    // accepts a REFERENCE to a value that genuinely carries the endorsement.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      await seedLabeledDoc(runtime, "wf-link-src-good", "endorsed-value", {
        integrity: [ADMIN_ATOM],
      });
      const tx = runtime.edit();
      const src = runtime.getCell(
        signer.did(),
        "wf-link-src-good",
        undefined,
        tx,
      );
      const sink = runtime.getCell(
        signer.did(),
        "wf-link-sink-good",
        FLOOR_SCHEMA,
        tx,
      );
      sink.set({ out: src as unknown as string });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a link whose source lacks the floor atom is rejected", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      // An empty stored label: the source read is excluded from the READ-side
      // gate (same trust level as unlabeled), so the write-side FLOOR is the
      // check that rejects — which is the point of this test.
      await seedLabeledDoc(runtime, "wf-link-src-bad", "unendorsed-value", {});
      const tx = runtime.edit();
      const src = runtime.getCell(
        signer.did(),
        "wf-link-src-bad",
        undefined,
        tx,
      );
      const sink = runtime.getCell(
        signer.did(),
        "wf-link-sink-bad",
        FLOOR_SCHEMA,
        tx,
      );
      sink.set({ out: src as unknown as string });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "write floor failed",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a floor-less ifc entry on the same schema is skipped", async () => {
    // A confidentiality-only sibling declares an ifc entry with NO
    // requiredIntegrity — the floor loop skips it (floor.length === 0) and
    // still enforces the real floor field.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      const schema = {
        type: "object",
        properties: {
          pub: { type: "string", ifc: { confidentiality: ["c"] } },
          out: { type: "string", ifc: { requiredIntegrity: [ADMIN_ATOM] } },
        },
        required: ["pub", "out"],
      } as const satisfies JSONSchema;
      const tx = runtime.edit();
      const sink = runtime.getCell(
        signer.did(),
        "wf-floorless-sink",
        schema,
        tx,
      );
      sink.set({ pub: "visible", out: "unendorsed" });
      tx.prepareCfc();
      const result = await tx.commit();
      // The floor field still rejects; the confidentiality-only field is inert.
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "write floor failed at /out",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a wildcard (*) floor entry is not enforced by the write floor (read-gate only, v1)", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      // Array items produce a `*` floor entry path (walkIfcSchema), which the
      // write floor skips in v1 — the per-element read gate still covers it.
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "string",
              ifc: { requiredIntegrity: [ADMIN_ATOM] },
            },
          },
        },
      } as const satisfies JSONSchema;
      const tx = runtime.edit();
      const sink = runtime.getCell(
        signer.did(),
        "wf-wildcard-sink",
        schema,
        tx,
      );
      sink.set({ items: ["unendorsed"] });
      tx.prepareCfc();
      const result = await tx.commit();
      // The wildcard floor is skipped by verifyWriteFloor (v1 scope), so no
      // write-floor rejection.
      expect(
        String((result.error as Error | undefined)?.message ?? ""),
      ).not.toContain("write floor failed");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a link whose source is not CFC-relevant still fails the floor", async () => {
    // The write at /out is a link whose source carries no stored metadata and
    // no schema, so nothing marks the link CFC-relevant and no link-write
    // policy input is recorded for it. The floor measures the path with no
    // link contribution at all, crediting only the transaction's flow
    // integrity, which is empty at the default `cfcFlowLabels` rung, and
    // refuses there.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      const tx = runtime.edit();
      const src = runtime.getCell(
        signer.did(),
        "wf-link-nometa-src",
        undefined,
        tx,
      );
      const sink = runtime.getCell(
        signer.did(),
        "wf-link-nometa-sink",
        FLOOR_SCHEMA,
        tx,
      );
      sink.set({ out: src as unknown as string });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(isCfcEnforcementRejection(result.error)).toBe(true);
      expect(result.error?.message).toContain("write floor failed at /out");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("an ancestor link cannot smuggle an unendorsed value under a nested floor", async () => {
    // Floor at /out/secret; the write links /out (an ANCESTOR) to a source
    // whose .secret carries no integrity. The nested value reconstructs as
    // undefined through the link, so without the ancestor-link check the floor
    // entry would be skipped entirely — the bypass this test pins closed.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      await seedLabeledDoc(
        runtime,
        "wf-anc-src-bad",
        { secret: "unendorsed" },
        {},
      );
      const nestedFloor = {
        type: "object",
        properties: {
          out: {
            type: "object",
            properties: {
              secret: {
                type: "string",
                ifc: { requiredIntegrity: [ADMIN_ATOM] },
              },
            },
          },
        },
      } as const satisfies JSONSchema;
      const tx = runtime.edit();
      const src = runtime.getCell(
        signer.did(),
        "wf-anc-src-bad",
        undefined,
        tx,
      );
      const sink = runtime.getCell(
        signer.did(),
        "wf-anc-sink-bad",
        nestedFloor,
        tx,
      );
      sink.set({ out: src as unknown as { secret: string } });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "write floor failed at /out/secret",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("an ancestor link whose source carries the nested floor atom passes", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      await seedLabeledDoc(
        runtime,
        "wf-anc-src-good",
        { secret: "endorsed" },
        { integrity: [ADMIN_ATOM] },
        ["secret"],
      );
      const nestedFloor = {
        type: "object",
        properties: {
          out: {
            type: "object",
            properties: {
              secret: {
                type: "string",
                ifc: { requiredIntegrity: [ADMIN_ATOM] },
              },
            },
          },
        },
      } as const satisfies JSONSchema;
      const tx = runtime.edit();
      const src = runtime.getCell(
        signer.did(),
        "wf-anc-src-good",
        undefined,
        tx,
      );
      const sink = runtime.getCell(
        signer.did(),
        "wf-anc-sink-good",
        nestedFloor,
        tx,
      );
      sink.set({ out: src as unknown as { secret: string } });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a plain sibling write next to an endorsed link child still fails the container floor", async () => {
    // Descendant-only mixed write under a floored CONTAINER: one child gets an
    // endorsed link, a sibling gets plain data in the same tx. The endorsed
    // link contribution must not launder the plain sibling — the value
    // contribution (empty integrity) fails the floor (cubic review: the
    // pure-link classification must not skip the value credit here).
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      await seedLabeledDoc(runtime, "wf-mixed-src", "endorsed-child", {
        integrity: [ADMIN_ATOM],
      });
      const containerFloor = {
        type: "object",
        properties: {
          out: {
            type: "object",
            ifc: { requiredIntegrity: [ADMIN_ATOM] },
            properties: {
              a: { type: "string" },
              b: { type: "string" },
            },
          },
        },
      } as const satisfies JSONSchema;
      const tx = runtime.edit();
      const src = runtime.getCell(signer.did(), "wf-mixed-src", undefined, tx);
      const sink = runtime.getCell(
        signer.did(),
        "wf-mixed-sink",
        containerFloor,
        tx,
      );
      sink.set({
        out: { a: src as unknown as string, b: "plain-unendorsed" },
      });
      // An unrelated doc written in the same tx: the floor's write enumeration
      // must scope to the floored target, not sweep the whole transaction.
      runtime.getCell(signer.did(), "wf-mixed-unrelated", undefined, tx)
        .set("elsewhere");
      tx.prepareCfc();
      const result = await tx.commit();
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "write floor failed at /out",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("clearing a floor-declaring path (delete) is not a floored write", async () => {
    // Establish the floor field with an endorsed value, then delete it. A
    // delete writes no value at the path, so the floor (which governs values,
    // not absence) does not reject.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      const schema = {
        type: "object",
        properties: {
          out: {
            type: "string",
            ifc: {
              requiredIntegrity: [ADMIN_ATOM],
              addIntegrity: [ADMIN_ATOM],
            },
          },
        },
      } as const satisfies JSONSchema;
      const seedTx = runtime.edit();
      const seeded = runtime.getCell(
        signer.did(),
        "wf-delete-sink",
        schema,
        seedTx,
      );
      seeded.set({ out: "endorsed" });
      seedTx.prepareCfc();
      expect((await seedTx.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      const sink = runtime.getCell(signer.did(), "wf-delete-sink", schema, tx);
      sink.set({});
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("the enforce pin cannot be weakened mid-transaction", async () => {
    // Once the runtime sets `enforce` at tx creation, code that can reach the
    // transaction must not be able to dial the floor back down and slip a
    // violation through (mirrors the flow-labels persist pin).
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      const tx = runtime.edit();
      expect(() => tx.setCfcWriteFloorMode("off")).toThrow(
        "cannot be weakened",
      );
      expect(() => tx.setCfcWriteFloorMode("observe")).toThrow(
        "cannot be weakened",
      );
      // Re-asserting enforce is fine.
      tx.setCfcWriteFloorMode("enforce");
      expect(tx.getCfcState().writeFloorMode).toBe("enforce");
      await tx.commit();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("an unwritten floor path on the same schema is not enforced (only touched paths)", async () => {
    // The schema declares a floor at /out but only the unprotected /note is
    // written. `out` is absent from the attempted writes, so the floor entry
    // does not apply (ifcEntryAppliesToAttemptedWrite=false) and no rejection
    // follows — the floor governs paths this commit actually wrote.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      const schema = {
        type: "object",
        properties: {
          out: { type: "string", ifc: { requiredIntegrity: [ADMIN_ATOM] } },
          note: { type: "string" },
        },
        required: ["note"],
      } as const satisfies JSONSchema;
      const tx = runtime.edit();
      const sink = runtime.getCell(signer.did(), "wf-sibling-sink", schema, tx);
      sink.set({ note: "b" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
