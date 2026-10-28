import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { linkRefFrom, linkRefPayload } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import {
  cfcLabelViewForCell,
  cfcLabelViewForResolvedTarget,
} from "../src/cfc/label-view.ts";
import type { CfcCellLinkRefPayload } from "../src/cfc/link-label-view.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import type { CfcWriteFloorMode, IFCLabel } from "../src/cfc/mod.ts";
import { prepareBoundaryCommit } from "../src/cfc/prepare.ts";
import { recordReferencedArgumentFields } from "../src/cfc/reference-initialization.ts";
import {
  type LabelMapEntry,
  runtimeWritePolicyAuthorization,
} from "../src/cfc/types.ts";
import { isVerdictReason, plainReason } from "../src/cfc/verdict-reason.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";

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
  entries: { path: string[]; label: IFCLabel; origin?: "link" }[],
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
  expect((await seed.commit().settled).ok).toBeDefined();
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
  describe("value stamp decisions", () => {
    for (const union of ["anyOf", "oneOf"] as const) {
      for (const matches of [false, true]) {
        it(`${matches ? "persists the stamp credited by" : "rejects a stamp from an incompatible branch of"} an \`${union}\` floor`, async () => {
          const storageManager = StorageManager.emulate({ as: signer });
          const runtime = makeRuntime({
            storageManager,
            cfcWriteFloor: "enforce",
          });
          try {
            const schema = {
              type: "object",
              properties: {
                out: {
                  [union]: [
                    {
                      type: "string",
                      ifc: { requiredIntegrity: [ADMIN_ATOM] },
                    },
                    { type: "number", ifc: { addIntegrity: [ADMIN_ATOM] } },
                  ],
                },
              },
            } as const satisfies JSONSchema;
            const tx = runtime.edit();
            const sink = runtime.getCell(
              signer.did(),
              "union-stamp-floor",
              schema,
              tx,
            );
            sink.set({ out: matches ? 42 : "unendorsed" });
            tx.prepareCfc();
            const result = await tx.commit().settled;
            if (matches) {
              expect(result.ok).toBeDefined();
              const read = runtime.edit();
              try {
                const stored = sink.withTx(read).key("out");
                expect(stored.get()).toBe(42);
                expect(
                  cfcLabelViewForCell(stored)?.entries.flatMap(
                    (entry) => entry.label.integrity ?? [],
                  ),
                ).toEqual([ADMIN_ATOM]);
              } finally {
                read.abort();
              }
            } else {
              expect(result.error?.message).toContain(
                "write floor failed at /out",
              );
            }
          } finally {
            await runtime.dispose();
            await storageManager.close();
          }
        });
      }
    }

    for (const builtin of [false, true]) {
      it(`${builtin ? "persists" : "refuses"} a runtime stamp ${builtin ? "credited to" : "forged by"} the write's author`, async () => {
        const storageManager = StorageManager.emulate({ as: signer });
        const runtime = makeRuntime({
          storageManager,
          cfcWriteFloor: "enforce",
        });
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
          } as const satisfies JSONSchema;
          const tx = runtime.edit();
          if (builtin) {
            setCfcImplementationIdentity(tx, {
              kind: "builtin",
              builtinId: "floor-test",
            });
          }
          const sink = runtime.getCell(
            signer.did(),
            "runtime-stamp-floor",
            schema,
            tx,
          );
          sink.set({ out: "authored value" });
          setCfcImplementationIdentity(tx, undefined);
          tx.prepareCfc();
          const result = await tx.commit().settled;
          if (builtin) {
            expect(result.ok).toBeDefined();
            const read = runtime.edit();
            try {
              const stored = sink.withTx(read).key("out");
              expect(stored.get()).toBe("authored value");
              expect(
                cfcLabelViewForCell(stored)?.entries.flatMap(
                  (entry) => entry.label.integrity ?? [],
                ),
              ).toEqual([LLM_DERIVED_ATOM]);
            } finally {
              read.abort();
            }
          } else {
            expect(result.error?.message).toContain(
              "write floor failed at /out",
            );
          }
        } finally {
          await runtime.dispose();
          await storageManager.close();
        }
      });
    }

    it("admits a value of another branch where the floor's own branch names the stamp, and stamps nothing", async () => {
      // The floor applies whichever branch the written value takes, so a
      // branch that both requires and stamps an atom is met by a write
      // through the union, as a flag whose `true` branch is floored is when
      // it is written `false`. The stamp lands only on a value of its branch.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
      try {
        const schema = {
          type: "object",
          properties: {
            out: {
              anyOf: [
                {
                  type: "string",
                  ifc: {
                    requiredIntegrity: [ADMIN_ATOM],
                    addIntegrity: [ADMIN_ATOM],
                  },
                },
                { type: "number" },
              ],
            },
          },
        } as const satisfies JSONSchema;
        const tx = runtime.edit();
        const sink = runtime.getCell(
          signer.did(),
          "own-branch-stamp-floor",
          schema,
          tx,
        );
        sink.set({ out: 42 });
        tx.prepareCfc();
        expect((await tx.commit().settled).ok).toBeDefined();

        const read = runtime.edit();
        try {
          const stored = sink.withTx(read).key("out");
          expect(stored.get()).toBe(42);
          expect(
            (cfcLabelViewForCell(stored)?.entries ?? []).flatMap(
              (entry) => entry.label.integrity ?? [],
            ),
          ).toEqual([]);
        } finally {
          read.abort();
        }
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });

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
      const result = await tx.commit().settled;
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
      setCfcImplementationIdentity(tx, {
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
      setCfcImplementationIdentity(tx, undefined);
      tx.prepareCfc();
      expect((await tx.commit().settled).error).toBeUndefined();
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
      expect((await tx.commit().settled).error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  // A link to the document holding it, written with a carried view that
  // names the current principal at `viewPath`. At the view's root the reader
  // placeholder is the reference's own restriction, bound to the reader the
  // source stores at the linked path and to nothing else; below the root the
  // view is not persisted.
  const backReferenceWithCarriedReader = async (
    runtime: Runtime,
    id: string,
    viewPath: string[],
  ): Promise<{ error?: Error; stored: LabelMapEntry[] }> => {
    const tx = runtime.edit();
    const source = runtime.getCell(signer.did(), id, undefined, tx);
    const link = linkRefFrom<CfcCellLinkRefPayload>({
      ...linkRefPayload(source.getAsLink()),
      cfcLabelView: {
        version: 1,
        entries: [{
          path: viewPath,
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
    const error = (await tx.commit().settled).error;
    const read = runtime.edit();
    try {
      return {
        error,
        stored: readStoredCfcMetadata(read, source.getAsNormalizedFullLink())
          ?.labelMap.entries ?? [],
      };
    } finally {
      read.abort();
    }
  };

  it("binds a carried reader at the root of a back-reference's view to the reader the source stores", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      await seedLabelMap(runtime, "reader-cycle", { reader: "r" }, [{
        path: [],
        label: {
          integrity: ["object-proof"],
          confidentiality: [{
            type: CFC_ATOM_TYPE.User,
            subject: signer.did(),
          }],
        },
      }]);
      const { error, stored } = await backReferenceWithCarriedReader(
        runtime,
        "reader-cycle",
        [],
      );
      expect(error).toBeUndefined();
      const slot = stored.find((entry) => entry.path.join("/") === "loop");
      expect(slot?.origin).toBe("link");
      expect(slot?.label.confidentiality).toEqual([{
        type: CFC_ATOM_TYPE.User,
        subject: signer.did(),
      }]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("refuses a carried reader at the root of a back-reference's view when the source stores none", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      await seedLabelMap(runtime, "reader-cycle", { reader: "r" }, [
        { path: [], label: { integrity: ["object-proof"] } },
        { path: ["reader"], label: { integrity: ["reader-proof"] } },
      ]);
      const { error } = await backReferenceWithCarriedReader(
        runtime,
        "reader-cycle",
        [],
      );
      expect(error?.message).toContain(
        "Link CurrentPrincipal confidentiality requires a concrete reader",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("drops a carried reader below the root of a back-reference's view", async () => {
    // Below its root a carried view describes positions of the target, which
    // the target labels itself, so a placeholder there binds nothing and
    // refuses nothing.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      await seedLabelMap(runtime, "reader-cycle", { reader: "r" }, [
        { path: [], label: { integrity: ["object-proof"] } },
        { path: ["reader"], label: { integrity: ["reader-proof"] } },
      ]);
      const { error, stored } = await backReferenceWithCarriedReader(
        runtime,
        "reader-cycle",
        ["loop", "reader"],
      );
      expect(error).toBeUndefined();
      expect(stored.filter((entry) => entry.path[0] === "loop")).toEqual([]);
      expect(JSON.stringify(stored)).not.toContain("__ctCurrentPrincipal");
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
      const result = await tx.commit().settled;
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
      const result = await tx.commit().settled;
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
      const result = await tx.commit().settled;
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
      const result = await tx.commit().settled;
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
        return String((await tx.commit().settled).error?.message ?? "");
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
      const result = await tx.commit().settled;
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
      expect((await seedTx.commit().settled).ok).toBeDefined();

      const tx = runtime.edit();
      const sink = runtime.getCell(
        signer.did(),
        "wf-overwrite-sink",
        MINT_SCHEMA,
        tx,
      );
      sink.set({ out: "new" });
      tx.prepareCfc();
      const result = await tx.commit().settled;
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
      const result = await tx.commit().settled;
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
      const result = await tx.commit().settled;
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
      const result = await tx.commit().settled;
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "write floor failed",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("refuses a link at a path whose schema both requires and mints the atom, when the source lacks it", async () => {
    // The stamp the schema mints at `out` lands on a value written there, and
    // a reference is not one: the store keeps no stamp at a slot holding a
    // reference, so the floor at `out` is held to what the linked source
    // carries, and a source carrying nothing fails it.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      await seedLabeledDoc(
        runtime,
        "wf-link-src-unminted",
        "unendorsed-value",
        {},
      );
      const tx = runtime.edit();
      const src = runtime.getCell(
        signer.did(),
        "wf-link-src-unminted",
        undefined,
        tx,
      );
      const sink = runtime.getCell(
        signer.did(),
        "wf-link-sink-minting",
        MINT_SCHEMA,
        tx,
      );
      sink.set({ out: src as unknown as string });
      tx.prepareCfc();
      const result = await tx.commit().settled;
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "write floor failed at /out",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("stores no stamp at a slot holding a reference, so no view of the slot carries the atom the schema mints there", async () => {
    // Under `observe` the same write commits, with the miss recorded, which
    // shows what the floor is held to: the stamp the schema mints at `out` is
    // persisted nowhere, and neither the slot's own view nor the view of the
    // document it resolves to carries the atom.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "observe" });
    try {
      await seedLabeledDoc(
        runtime,
        "wf-link-src-unminted-observe",
        "unendorsed-value",
        {},
      );
      const tx = runtime.edit();
      const src = runtime.getCell(
        signer.did(),
        "wf-link-src-unminted-observe",
        undefined,
        tx,
      );
      const sink = runtime.getCell(
        signer.did(),
        "wf-link-sink-minting-observe",
        MINT_SCHEMA,
        tx,
      );
      sink.set({ out: src as unknown as string });
      tx.prepareCfc();
      const result = await tx.commit().settled;
      expect(result.error).toBeUndefined();
      expect(
        tx.getCfcState().diagnostics.some((d) =>
          d.includes("write-floor(observe)") && d.includes("write floor")
        ),
      ).toBe(true);
      const read = runtime.edit();
      const stored = readStoredCfcMetadata(
        read,
        runtime.getCell(
          signer.did(),
          "wf-link-sink-minting-observe",
          undefined,
          read,
        )
          .getAsNormalizedFullLink(),
      );
      const slot = runtime.getCell(
        signer.did(),
        "wf-link-sink-minting-observe",
        undefined,
        read,
      ).key("out");
      const atomsOf = (view: ReturnType<typeof cfcLabelViewForCell>) =>
        (view?.entries ?? []).flatMap((entry) => entry.label.integrity ?? []);
      // The stored value pins the document, and the declared entry at `out`
      // pins the label map, so the absent stamp is the claim.
      expect(slot.get()).toBe("unendorsed-value");
      expect(
        (stored?.labelMap.entries ?? []).some((entry) =>
          entry.origin === "declared" && entry.path[0] === "out"
        ),
      ).toBe(true);
      expect(
        (stored?.labelMap.entries ?? []).some((entry) =>
          entry.origin === "minted" &&
          (entry.label.integrity ?? []).includes(ADMIN_ATOM)
        ),
      ).toBe(false);
      expect(atomsOf(cfcLabelViewForCell(slot))).not.toContain(ADMIN_ATOM);
      expect(atomsOf(cfcLabelViewForResolvedTarget(slot))).not.toContain(
        ADMIN_ATOM,
      );
      read.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("credits the references beneath a minted list path with the list's own stamp", async () => {
    // The roster shape: the list path both requires and mints the atom, and
    // each role holds a reference under `subject`. The list is a value
    // written at the floor path, so its stamp is persisted there and covers
    // the references beneath it, whatever their documents carry.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      await seedLabeledDoc(runtime, "wf-roster-profile", { name: "Alice" }, {});
      const tx = runtime.edit();
      const profile = runtime.getCell(
        signer.did(),
        "wf-roster-profile",
        undefined,
        tx,
      );
      const sink = runtime.getCell(signer.did(), "wf-roster-sink", {
        type: "object",
        properties: {
          admins: {
            type: "array",
            items: {
              type: "object",
              properties: {
                subject: { type: "object" },
                displayName: { type: "string" },
              },
              required: ["subject", "displayName"],
            },
            ifc: {
              requiredIntegrity: [ADMIN_ATOM],
              addIntegrity: [ADMIN_ATOM],
            },
          },
        },
        required: ["admins"],
      }, tx);
      sink.set({
        admins: [{
          subject: profile as unknown as Record<string, unknown>,
          displayName: "Alice",
        }],
      });
      tx.prepareCfc();
      const result = await tx.commit().settled;
      expect(result.error).toBeUndefined();
      const read = runtime.edit();
      const stored = readStoredCfcMetadata(
        read,
        runtime.getCell(signer.did(), "wf-roster-sink", undefined, read)
          .getAsNormalizedFullLink(),
      );
      read.abort();
      expect(
        (stored?.labelMap.entries ?? []).filter((entry) =>
          entry.origin === "minted"
        ).map((entry) => ({
          path: [...entry.path],
          integrity: entry.label.integrity,
        })),
      ).toEqual([{ path: ["admins"], integrity: [ADMIN_ATOM] }]);
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
      const result = await tx.commit().settled;
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
      const result = await tx.commit().settled;
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
    // no schema. The sink's schema declares the floor, which is what makes
    // the transaction one the boundary prepares; the link's evidence is the
    // source's own label, which is nothing, and the floor refuses it.
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
      const result = await tx.commit().settled;
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
      const result = await tx.commit().settled;
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "write floor failed at /out/secret",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("an ancestor link cannot smuggle an unendorsed value reached through a link inside another link's target path", async () => {
    // Floor at /out/secret; /out links to a source whose `secret` is a link to
    // `ptr/secret` in a middle document, and `ptr` is itself a link to the
    // document holding the unendorsed value. Reaching the value means
    // following the link at `ptr`, partway along the first link's target
    // path; a walk that read that path whole would find nothing there and
    // take the floor as not applying.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      // Each document carries stored labels, none of them the floor's atom.
      const linkTo = (id: string, path: string[] = []) => {
        let cell = runtime.getCell<unknown>(signer.did(), id);
        for (const segment of path) {
          cell = (cell as unknown as { key(k: string): typeof cell }).key(
            segment,
          );
        }
        return cell.getAsLink() as unknown as FabricValue;
      };
      await seedLabeledDoc(
        runtime,
        "wf-hop-leaf",
        { secret: "unendorsed" },
        {},
      );
      await seedLabeledDoc(
        runtime,
        "wf-hop-middle",
        { ptr: linkTo("wf-hop-leaf") },
        {},
      );
      await seedLabeledDoc(
        runtime,
        "wf-hop-source",
        { secret: linkTo("wf-hop-middle", ["ptr", "secret"]) },
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
      const source = runtime.getCell(
        signer.did(),
        "wf-hop-source",
        undefined,
        tx,
      );
      const sink = runtime.getCell(
        signer.did(),
        "wf-hop-sink",
        nestedFloor,
        tx,
      );
      sink.set({ out: source as unknown as { secret: string } });
      tx.prepareCfc();
      const result = await tx.commit().settled;
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "write floor failed at /out/secret",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("an ancestor link cannot meet a floor with a stored link's label beside the value's own", async () => {
    // Floor at /out/secret requiring two atoms. /out links to a source whose
    // `secret` is a stored link carrying the first atom, and the value it
    // reaches carries only the second. The stored link's label describes
    // what its target held when it was written, so the value's own label is
    // the only credit, and it meets half the floor.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      const linkTo = (id: string, path: string[] = []) => {
        let cell = runtime.getCell<unknown>(signer.did(), id);
        for (const segment of path) {
          cell = (cell as unknown as { key(k: string): typeof cell }).key(
            segment,
          );
        }
        return cell.getAsLink() as unknown as FabricValue;
      };
      await seedLabelMap(runtime, "wf-split-leaf", { secret: "unendorsed" }, [
        { path: ["secret"], label: { integrity: ["second-proof"] } },
      ]);
      await seedLabelMap(runtime, "wf-split-middle", {
        ptr: linkTo("wf-split-leaf"),
      }, []);
      await seedLabelMap(runtime, "wf-split-source", {
        secret: linkTo("wf-split-middle", ["ptr", "secret"]),
      }, [{
        path: ["secret"],
        label: { integrity: [ADMIN_ATOM] },
        origin: "link",
      }]);
      const splitFloor = {
        type: "object",
        properties: {
          out: {
            type: "object",
            properties: {
              secret: {
                type: "string",
                ifc: { requiredIntegrity: [ADMIN_ATOM, "second-proof"] },
              },
            },
          },
        },
      } as const satisfies JSONSchema;

      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "wf-split-source",
        undefined,
        tx,
      );
      const sink = runtime.getCell(
        signer.did(),
        "wf-split-sink",
        splitFloor,
        tx,
      );
      sink.set({ out: source as unknown as { secret: string } });
      tx.prepareCfc();
      const result = await tx.commit().settled;
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
      const result = await tx.commit().settled;
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
      const result = await tx.commit().settled;
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
      expect((await seedTx.commit().settled).ok).toBeDefined();

      const tx = runtime.edit();
      const sink = runtime.getCell(signer.did(), "wf-delete-sink", schema, tx);
      sink.set({});
      tx.prepareCfc();
      const result = await tx.commit().settled;
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
      await tx.commit().settled;
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
      const result = await tx.commit().settled;
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  describe("verdicts", () => {
    // A floor's refusal is terminal, `CfcCommitRefusalError`, where every
    // document whose evidence decided it is one the transaction holds, so that
    // an immediate re-run refuses identically. A refusal resting on a document
    // the transaction does not hold stays the retryable
    // `StorageTransactionAborted`.

    const LIST_FLOOR_SCHEMA = {
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

    // The two held sources a floor finds short of its atom: one storing no
    // labels at all, and one storing a label without the atom.
    const HELD_SOURCES = {
      "a bare document": async (runtime: Runtime, id: string) => {
        const seed = runtime.edit();
        runtime.getCell(signer.did(), id, undefined, seed).set("unendorsed");
        expect((await seed.commit().settled).error).toBeUndefined();
      },
      "a document labeled without the atom": (runtime: Runtime, id: string) =>
        seedLabeledDoc(runtime, id, "unendorsed", {}),
    };

    // Replaces the labels `id` stores, and nothing else of it.
    const relabel = async (runtime: Runtime, id: string, label: IFCLabel) => {
      const tx = runtime.edit();
      const docId = runtime.getCell(signer.did(), id, undefined, tx)
        .getAsNormalizedFullLink().id as URI;
      writeSeedEnvelopeDoc(tx, signer.did());
      seedStoredEnvelope(tx, {
        space: signer.did(),
        id: docId,
        type: "application/json",
        path: ["cfc"],
      }, {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries: [{ path: [], label }] },
      });
      expect((await tx.commit().settled).error).toBeUndefined();
    };

    // Links `sourceId` into the floored list and commits.
    const linkIntoList = async (
      runtime: Runtime,
      sourceId: string,
      sinkId: string,
    ) => {
      const tx = runtime.edit();
      const source = runtime.getCell(signer.did(), sourceId, undefined, tx);
      const sink = runtime.getCell(
        signer.did(),
        sinkId,
        LIST_FLOOR_SCHEMA,
        tx,
      );
      sink.set({ items: [source as unknown as string] });
      tx.prepareCfc();
      return (await tx.commit().settled).error;
    };

    for (const [kind, seed] of Object.entries(HELD_SOURCES)) {
      it(`rejects a link into a floored list to ${kind} as \`CfcCommitRefusalError\``, async () => {
        const storageManager = StorageManager.emulate({ as: signer });
        const runtime = makeRuntime({
          storageManager,
          cfcWriteFloor: "enforce",
        });
        try {
          await seed(runtime, "wf-verdict-list-src");
          const error = await linkIntoList(
            runtime,
            "wf-verdict-list-src",
            "wf-verdict-list-sink",
          );
          expect(error?.name).toBe("CfcCommitRefusalError");
          expect(error?.message).toContain("write floor failed at /items/0");
        } finally {
          await runtime.dispose();
          await storageManager.close();
        }
      });
    }

    it("rejects a link into a floored list to a document the transaction does not hold as a retryable `StorageTransactionAborted`", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
      try {
        const error = await linkIntoList(
          runtime,
          "wf-verdict-unheld-src",
          "wf-verdict-unheld-sink",
        );
        expect(error?.name).toBe("StorageTransactionAborted");
        expect((error as { reason?: Error } | undefined)?.reason?.message)
          .toBe("cfc-refusal-not-a-verdict");
        expect(error?.message).toContain("write floor failed at /items/0");
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    for (const held of [true, false]) {
      it(`rejects a link into a floored list through a reference the transaction stages to ${held ? "a held bare document as `CfcCommitRefusalError`" : "a document it does not hold as a retryable `StorageTransactionAborted`"}`, async () => {
        // The listed reference reaches its value through a second reference
        // the same transaction writes into its source, so the evidence the
        // floor weighs is the second reference's source.

        const storageManager = StorageManager.emulate({ as: signer });
        const runtime = makeRuntime({
          storageManager,
          cfcWriteFloor: "enforce",
        });
        try {
          if (held) await HELD_SOURCES["a bare document"](runtime, "wf-far");
          const seed = runtime.edit();
          runtime.getCell(signer.did(), "wf-near", undefined, seed).set({
            x: "plain",
          });
          expect((await seed.commit().settled).error).toBeUndefined();
          const tx = runtime.edit();
          const far = runtime.getCell(signer.did(), "wf-far", undefined, tx);
          const near = runtime.getCell<{ x: unknown }>(
            signer.did(),
            "wf-near",
            undefined,
            tx,
          );
          near.key("x").set(far);
          const sink = runtime.getCell(
            signer.did(),
            "wf-staged-sink",
            LIST_FLOOR_SCHEMA,
            tx,
          );
          sink.set({ items: [near.key("x") as unknown as string] });
          tx.prepareCfc();
          const error = (await tx.commit().settled).error;
          expect(error?.name).toBe(
            held ? "CfcCommitRefusalError" : "StorageTransactionAborted",
          );
          expect(error?.message).toContain("write floor failed at /items/0");
        } finally {
          await runtime.dispose();
          await storageManager.close();
        }
      });
    }

    for (const held of [true, false]) {
      it(`rejects a link into a floored list that reaches its value through a stored reference to ${held ? "a held bare document as `CfcCommitRefusalError`" : "a document it does not hold as a retryable `StorageTransactionAborted`"}`, async () => {
        // The listed reference's source holds, at the linked path, a
        // reference committed before this transaction, so the evidence the
        // floor weighs is the document that reference reaches, which only
        // the walk from the source visits.

        const storageManager = StorageManager.emulate({ as: signer });
        const runtime = makeRuntime({
          storageManager,
          cfcWriteFloor: "enforce",
        });
        try {
          if (held) {
            await HELD_SOURCES["a bare document"](runtime, "wf-stored-far");
          }
          const seed = runtime.edit();
          const far = runtime.getCell(
            signer.did(),
            "wf-stored-far",
            undefined,
            seed,
          );
          runtime.getCell<{ x: unknown }>(
            signer.did(),
            "wf-stored-near",
            undefined,
            seed,
          ).set({ x: far });
          expect((await seed.commit().settled).error).toBeUndefined();
          const tx = runtime.edit();
          const near = runtime.getCell<{ x: unknown }>(
            signer.did(),
            "wf-stored-near",
            undefined,
            tx,
          );
          const sink = runtime.getCell(
            signer.did(),
            "wf-stored-sink",
            LIST_FLOOR_SCHEMA,
            tx,
          );
          sink.set({ items: [near.key("x") as unknown as string] });
          tx.prepareCfc();
          const error = (await tx.commit().settled).error;
          expect(error?.name).toBe(
            held ? "CfcCommitRefusalError" : "StorageTransactionAborted",
          );
          expect(error?.message).toContain("write floor failed at /items/0");
        } finally {
          await runtime.dispose();
          await storageManager.close();
        }
      });
    }

    for (const held of [true, false]) {
      it(`rejects a link at a floored field to ${held ? "a held document without the atom as `CfcCommitRefusalError`" : "a document the transaction does not hold as a retryable `StorageTransactionAborted`"}`, async () => {
        const storageManager = StorageManager.emulate({ as: signer });
        const runtime = makeRuntime({
          storageManager,
          cfcWriteFloor: "enforce",
        });
        try {
          if (held) {
            await seedLabeledDoc(runtime, "wf-verdict-field-src", "v", {});
          }
          const tx = runtime.edit();
          const source = runtime.getCell(
            signer.did(),
            "wf-verdict-field-src",
            undefined,
            tx,
          );
          const sink = runtime.getCell(
            signer.did(),
            "wf-verdict-field-sink",
            FLOOR_SCHEMA,
            tx,
          );
          sink.set({ out: source as unknown as string });
          tx.prepareCfc();
          const error = (await tx.commit().settled).error;
          expect(error?.name).toBe(
            held ? "CfcCommitRefusalError" : "StorageTransactionAborted",
          );
          expect(error?.message).toContain("write floor failed at /out");
        } finally {
          await runtime.dispose();
          await storageManager.close();
        }
      });
    }

    it("rejects an ancestor link to a held document whose nested value lacks the atom as `CfcCommitRefusalError`", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
      try {
        await seedLabeledDoc(
          runtime,
          "wf-verdict-anc-src",
          { secret: "unendorsed" },
          {},
        );
        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "wf-verdict-anc-src",
          undefined,
          tx,
        );
        const sink = runtime.getCell(
          signer.did(),
          "wf-verdict-anc-sink",
          {
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
          } as const satisfies JSONSchema,
          tx,
        );
        sink.set({ out: source as unknown as { secret: string } });
        tx.prepareCfc();
        const error = (await tx.commit().settled).error;
        expect(error?.name).toBe("CfcCommitRefusalError");
        expect(error?.message).toContain("write floor failed at /out/secret");
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("runs a reactive writer the floor refused again once the linked document stores the atom", async () => {
      // The refusal ends the writer's retries, so only a change to what the
      // floor weighed can run it again: here, the source storing the atom.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
      try {
        await seedLabeledDoc(runtime, "wf-rerun-src", "pending", {});
        const errors: Error[] = [];
        runtime.scheduler.onError((error) => errors.push(error));
        const source = runtime.getCell(signer.did(), "wf-rerun-src");
        const sink = runtime.getCell(
          signer.did(),
          "wf-rerun-sink",
          LIST_FLOOR_SCHEMA,
        );
        let runs = 0;
        runtime.scheduler.subscribe(
          (actionTx: IExtendedStorageTransaction) => {
            runs++;
            sink.withTx(actionTx).set({ items: [source as unknown as string] });
          },
          { reads: [], shallowReads: [], writes: [] },
          { isEffect: true },
        );
        await runtime.scheduler.idleWithPendingCommits();
        expect(runs).toBe(1);
        expect(errors.map((error) => error.name)).toEqual([
          "CfcCommitRefusalError",
        ]);

        await relabel(runtime, "wf-rerun-src", { integrity: [ADMIN_ATOM] });
        await runtime.scheduler.idleWithPendingCommits();
        expect(runs).toBe(2);
        expect(errors).toHaveLength(1);
        const read = runtime.edit();
        try {
          expect(sink.withTx(read).key("items").get()).toEqual(["pending"]);
        } finally {
          read.abort();
        }
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    for (const flow of ["off", "persist"] as const) {
      it(`rejects a plain value at a floored field as \`CfcCommitRefusalError\` with flow labels \`${flow}\``, async () => {
        const storageManager = StorageManager.emulate({ as: signer });
        const runtime = makeRuntime({
          storageManager,
          cfcWriteFloor: "enforce",
          cfcFlowLabels: flow,
        });
        try {
          await seedLabeledDoc(runtime, "wf-plain-input", "unendorsed", {});
          const tx = runtime.edit();
          const input = runtime.getCell<string>(
            signer.did(),
            "wf-plain-input",
            undefined,
            tx,
          );
          const sink = runtime.getCell(
            signer.did(),
            "wf-plain-sink",
            FLOOR_SCHEMA,
            tx,
          );
          sink.set({ out: input.get() });
          tx.prepareCfc();
          const error = (await tx.commit().settled).error;
          expect(error?.name).toBe("CfcCommitRefusalError");
          expect(error?.message).toContain("write floor failed at /out");
        } finally {
          await runtime.dispose();
          await storageManager.close();
        }
      });
    }

    it("rejects a plain value at a floored field as a retryable `StorageTransactionAborted` when the transaction read a document it does not hold", async () => {
      // Under flow labels `persist` the flow join credits the value from the
      // labels of everything the transaction read, and a document it does not
      // hold may yet store some.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({
        storageManager,
        cfcWriteFloor: "enforce",
        cfcFlowLabels: "persist",
      });
      try {
        const tx = runtime.edit();
        const input = runtime.getCell<string>(
          signer.did(),
          "wf-plain-unheld-input",
          undefined,
          tx,
        );
        const sink = runtime.getCell(
          signer.did(),
          "wf-plain-unheld-sink",
          FLOOR_SCHEMA,
          tx,
        );
        sink.set({ out: input.get() ?? "unendorsed" });
        tx.prepareCfc();
        const error = (await tx.commit().settled).error;
        expect(error?.name).toBe("StorageTransactionAborted");
        expect(error?.message).toContain("write floor failed at /out");
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects a plain value at a floored field as a retryable `StorageTransactionAborted` when the transaction observed external content", async () => {
      // Under flow labels `persist` the flow join also weighs the flow of the
      // external content the transaction observed, which no document holds,
      // so no document the floor could read again decides the miss.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({
        storageManager,
        cfcWriteFloor: "enforce",
        cfcFlowLabels: "persist",
      });
      try {
        await seedLabeledDoc(runtime, "wf-plain-external-input", "plain", {});
        const tx = runtime.edit();
        const input = runtime.getCell<string>(
          signer.did(),
          "wf-plain-external-input",
          undefined,
          tx,
        );
        const sink = runtime.getCell(
          signer.did(),
          "wf-plain-external-sink",
          FLOOR_SCHEMA,
          tx,
        );
        sink.set({ out: input.get() });
        tx.recordCfcExternalContentObservation({
          source: {
            space: signer.did(),
            id: "of:wf-plain-external-content",
            scope: "space",
            path: [],
          },
          flow: { confidentiality: [], integrity: [] },
          consumed: { confidentiality: [], integrity: [] },
          locations: [],
          labeledSpaces: [],
          sources: [],
        }, runtimeWritePolicyAuthorization);
        tx.prepareCfc();
        const error = (await tx.commit().settled).error;
        expect(error?.name).toBe("StorageTransactionAborted");
        expect((error as { reason?: Error } | undefined)?.reason?.message)
          .toBe("cfc-refusal-not-a-verdict");
        expect(error?.message).toContain("write floor failed at /out");
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("leaves the refusal retryable where the schema a held source's stored envelope names cannot be loaded", async () => {
      // The source is held, but its evidence is undecided rather than short of
      // the atom: the schema document its envelope names is one this
      // transaction cannot load. The transaction is prepared through a view
      // that serves such an envelope for the source's `["cfc"]` member.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
      try {
        await HELD_SOURCES["a bare document"](runtime, "wf-unloadable-src");
        const tx = runtime.edit();
        try {
          const source = runtime.getCell(
            signer.did(),
            "wf-unloadable-src",
            undefined,
            tx,
          );
          const sourceId = source.getAsNormalizedFullLink().id;
          runtime.getCell(
            signer.did(),
            "wf-unloadable-sink",
            LIST_FLOOR_SCHEMA,
            tx,
          ).set({ items: [source as unknown as string] });
          const envelope = {
            version: 1,
            schemaHash: internSchemaAsTaggedHashString({
              title: "wf-unloadable-envelope-schema",
            }),
            labelMap: { version: 1, entries: [] },
          };
          const view = new Proxy(tx, {
            get(target, property) {
              if (property === "readOrThrow") {
                return (
                  ...args: Parameters<
                    IExtendedStorageTransaction["readOrThrow"]
                  >
                ) =>
                  args[0].id === sourceId && args[0].path[0] === "cfc"
                    ? envelope
                    : target.readOrThrow(...args);
              }
              const member = Reflect.get(target, property, target);
              return typeof member === "function"
                ? member.bind(target)
                : member;
            },
          });
          const reasons = prepareBoundaryCommit(view);
          expect(reasons).toHaveLength(1);
          expect(plainReason(reasons[0])).toContain(
            "write floor failed at /items/0",
          );
          expect(isVerdictReason(reasons[0])).toBe(false);
        } finally {
          tx.abort();
        }
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects a floored field whose links miss it as a retryable `StorageTransactionAborted` where one of them reaches a document the transaction does not hold", async () => {
      // One link reaches a held document without the atom and the other a
      // document the transaction does not hold. The refusal is a verdict only
      // once every miss is decided.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
      try {
        await seedLabeledDoc(runtime, "wf-mixed-held", "v", {});
        const tx = runtime.edit();
        const held = runtime.getCell(
          signer.did(),
          "wf-mixed-held",
          undefined,
          tx,
        );
        const unheld = runtime.getCell(
          signer.did(),
          "wf-mixed-unheld",
          undefined,
          tx,
        );
        runtime.getCell(
          signer.did(),
          "wf-mixed-sink",
          {
            type: "object",
            properties: {
              out: {
                type: "object",
                properties: { a: { type: "string" }, b: { type: "string" } },
                ifc: { requiredIntegrity: [ADMIN_ATOM] },
              },
            },
          } as const satisfies JSONSchema,
          tx,
        ).set({
          out: {
            a: held as unknown as string,
            b: unheld as unknown as string,
          },
        });
        tx.prepareCfc();
        const error = (await tx.commit().settled).error;
        expect(error?.name).toBe("StorageTransactionAborted");
        expect(error?.message).toContain("write floor failed at /out");
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("runs a reactive writer the floor refused over a plain value again once a document it read stores other labels", async () => {
      // Under flow labels `persist` the value's credit is the flow join over
      // what the writer read, so a change to those labels can run it again,
      // and here refuses it again. The writer reads the input raw, which
      // reads none of the input's labels itself.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({
        storageManager,
        cfcWriteFloor: "enforce",
        cfcFlowLabels: "persist",
      });
      try {
        await seedLabeledDoc(runtime, "wf-plain-rerun-input", "plain", {});
        const errors: Error[] = [];
        runtime.scheduler.onError((error) => errors.push(error));
        const input = runtime.getCell<string>(
          signer.did(),
          "wf-plain-rerun-input",
        );
        const sink = runtime.getCell(
          signer.did(),
          "wf-plain-rerun-sink",
          FLOOR_SCHEMA,
        );
        let runs = 0;
        runtime.scheduler.subscribe(
          (actionTx: IExtendedStorageTransaction) => {
            runs++;
            sink.withTx(actionTx).set({
              out: input.withTx(actionTx).getRaw() as string,
            });
          },
          { reads: [], shallowReads: [], writes: [] },
          { isEffect: true },
        );
        await runtime.scheduler.idleWithPendingCommits();
        expect(runs).toBe(1);
        expect(errors.map((error) => error.name)).toEqual([
          "CfcCommitRefusalError",
        ]);

        await relabel(runtime, "wf-plain-rerun-input", {
          integrity: ["other-endorsement"],
        });
        await runtime.scheduler.idleWithPendingCommits();
        expect(runs).toBe(2);
        expect(errors.map((error) => error.name)).toEqual([
          "CfcCommitRefusalError",
          "CfcCommitRefusalError",
        ]);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });
});
