import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("runner-cfc-redundant-collapse");

type StoredEntry = {
  path: string[];
  label: { confidentiality?: unknown[]; integrity?: unknown[] };
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

const newRuntime = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
) =>
  new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    // Every assertion below reads back `derived` and `structure` entries of a
    // stored label map. The persisting rung of the flow-label dial is what
    // writes those entries.
    cfcFlowLabels: "persist",
  });

// A list whose elements the schema declares `Resource(Secret)` on. The
// declared entry lands at the wildcard child path `["*"]`, which covers every
// index and `length`.
const labeledListSchema = {
  type: "array",
  items: {
    type: "string",
    ifc: { confidentiality: [cfcAtom.resource("Secret")] },
  },
} as unknown as JSONSchema;

// Seed a document carrying `confidentiality` on its `secret` field, so a
// transaction reading it takes those clauses into the per-transaction join.
const seedSource = async (
  runtime: Runtime,
  name: string,
  confidentiality: readonly FabricValue[],
  integrity: readonly FabricValue[] = [],
) => {
  const seed = runtime.edit();
  const source = runtime.getCell(signer.did(), name, {
    type: "object",
    properties: { secret: { type: "string" } },
  } as JSONSchema);
  const sourceId = source.getAsNormalizedFullLink().id;
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
          label: {
            confidentiality: [...confidentiality],
            ...(integrity.length > 0 ? { integrity: [...integrity] } : {}),
          },
        }],
      },
    },
  });
  expect((await seed.commit()).ok).toBeDefined();
};

describe("CFC redundant entry collapse", () => {
  // A `derived` or `structure` entry whose clauses the declared component
  // already carries at the same path adds nothing to the label a boundary
  // resolves: `labelForEntriesAtPath` resolves each component separately and
  // joins the results, and the join deduplicates clauses structurally. Such
  // an entry is dropped at persist time (spec §4.6.4).

  it("holds a labeled list's label map at its declared entry across appends", async () => {
    // Appending reads the list through its own element declaration, so the
    // transaction's join is that declaration. Stamping the join onto the new
    // index would record there what the `["*"]` entry already says, and the
    // metadata templates derived from those stamps would follow — five
    // entries per element, for the life of the list.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      const seeded = runtime.edit();
      runtime.getCell<string[]>(
        signer.did(),
        "collapse-labeled-list",
        labeledListSchema,
        seeded,
      ).set(["seed"]);
      seeded.prepareCfc();
      expect((await seeded.commit()).ok).toBeDefined();

      const listId = runtime
        .getCell<string[]>(
          signer.did(),
          "collapse-labeled-list",
          labeledListSchema,
        )
        .getAsNormalizedFullLink().id;
      const seededEntries = replicaEntries(storageManager, listId);
      expect(seededEntries).toEqual([{
        path: ["*"],
        label: { confidentiality: [cfcAtom.resource("Secret")] },
        origin: "declared",
      }]);

      for (const element of ["A", "B", "C"]) {
        const tx = runtime.edit();
        runtime.getCell<string[]>(
          signer.did(),
          "collapse-labeled-list",
          labeledListSchema,
          tx,
        ).push(element);
        tx.prepareCfc();
        // Nothing to say about the envelope means no envelope write: the
        // SC-11 canonical comparison finds the recomputed metadata identical
        // and the append leaves the `["cfc"]` document alone.
        expect(
          [...(tx.getWriteDetails?.(signer.did()) ?? [])].filter((write) =>
            write.address.id === listId && write.address.path[0] === "cfc"
          ),
        ).toEqual([]);
        expect((await tx.commit()).ok).toBeDefined();
      }

      expect(replicaEntries(storageManager, listId)).toEqual(seededEntries);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps a stamp carrying a clause the declared component does not", async () => {
    // The join of an append that also read an unrelated labeled source
    // carries a clause the element declaration does not, so the stamp is
    // the only place that clause is recorded at the appended index. The
    // source's clause names the space every document here lives in, which
    // §8.12.4 residency admits into the list's write ceiling.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSource(runtime, "collapse-foreign-source", [
        cfcAtom.space(signer.did()),
      ]);

      const seeded = runtime.edit();
      runtime.getCell<string[]>(
        signer.did(),
        "collapse-mixed-list",
        labeledListSchema,
        seeded,
      ).set(["seed"]);
      seeded.prepareCfc();
      expect((await seeded.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "collapse-foreign-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      runtime.getCell<string[]>(
        signer.did(),
        "collapse-mixed-list",
        labeledListSchema,
        tx,
      ).push(`${raw.secret}!`);
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const listId = runtime
        .getCell<string[]>(
          signer.did(),
          "collapse-mixed-list",
          labeledListSchema,
        )
        .getAsNormalizedFullLink().id;
      const stamped = replicaEntries(storageManager, listId).filter((entry) =>
        entry.origin === "derived" && entry.path.join("/") === "1"
      );
      expect(stamped.length).toBeGreaterThan(0);
      for (const entry of stamped) {
        expect(entry.label.confidentiality).toContainEqual(
          cfcAtom.space(signer.did()),
        );
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps a stamp carrying integrity where the declaration covers its clauses", async () => {
    // Integrity is never unioned across components, so a declared entry
    // stating the same confidentiality does not stand in for one. The
    // confidentiality-only existence stamp beside it is covered and goes.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      const certified = {
        type: CFC_ATOM_TYPE.PolicyCertified,
        policy: "collapse-policy",
      };
      await seedSource(
        runtime,
        "collapse-certified-source",
        [cfcAtom.resource("Shared")],
        [certified],
      );

      // The target carries the same certification, so the write's read of
      // its prior value does not empty the weakest-link integrity meet.
      const targetSchema = {
        type: "object",
        properties: { copied: { type: "string" } },
        ifc: { confidentiality: [cfcAtom.resource("Shared")] },
      } as unknown as JSONSchema;
      const targetId = runtime
        .getCell(signer.did(), "collapse-certified-target", targetSchema)
        .getAsNormalizedFullLink().id;
      const seedTarget = runtime.edit();
      writeSeedEnvelopeDoc(seedTarget, signer.did());
      seedStoredEnvelope(seedTarget, {
        space: signer.did(),
        scope: "space",
        id: targetId,
        path: [],
      }, {
        value: {},
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: {
                confidentiality: [cfcAtom.resource("Shared")],
                integrity: [certified],
              },
              origin: "declared",
            }],
          },
        },
      });
      expect((await seedTarget.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "collapse-certified-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      runtime.getCell<{ copied?: string }>(
        signer.did(),
        "collapse-certified-target",
        targetSchema,
        tx,
      ).set({ copied: `${raw.secret}!` });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const entries = replicaEntries(storageManager, targetId);
      const stamps = entries.filter((entry) => entry.origin === "derived");
      expect(stamps.length).toBeGreaterThan(0);
      for (const entry of stamps) {
        expect(entry.label.integrity).toContainEqual(certified);
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps a stamp whose own component carries integrity above it", async () => {
    // Replace-down picks one entry per component, so a child stamp hides its
    // ancestor's whole label. Dropping the child would hand reads at its path
    // the ancestor's integrity — certification for content derived from none
    // — which is the over-claim §8.9.3's weakest-link meet exists to refuse.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      const certified = {
        type: CFC_ATOM_TYPE.PolicyCertified,
        policy: "collapse-shadowed",
      };
      const mapSchema = {
        type: "object",
        properties: {
          retained: {
            type: "object",
            additionalProperties: {
              type: "string",
              ifc: { confidentiality: [cfcAtom.resource("Shared")] },
            },
          },
          added: { type: "string" },
        },
      } as unknown as JSONSchema;
      type MapValue = { retained: Record<string, string>; added?: string };
      const mapId = runtime
        .getCell<MapValue>(
          signer.did(),
          "collapse-shadowed-map",
          mapSchema,
        )
        .getAsNormalizedFullLink().id;

      // A retained subtree carries a parent certification and a child that
      // shadows it. A disjoint sibling write leaves that attestation valid.
      const seed = runtime.edit();
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: mapId,
        path: [],
      }, {
        value: { retained: { kept: "1" } },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [
              {
                path: ["retained", "*"],
                label: { confidentiality: [cfcAtom.resource("Shared")] },
                origin: "declared",
              },
              {
                path: ["retained"],
                label: {
                  confidentiality: [cfcAtom.resource("Shared")],
                  integrity: [certified],
                },
                origin: "derived",
                observes: "value",
              },
              {
                path: ["retained", "kept"],
                label: { confidentiality: [cfcAtom.resource("Shared")] },
                origin: "derived",
                observes: "value",
              },
            ],
          },
        },
        // deno-lint-ignore no-explicit-any
      } as any);
      expect((await seed.commit()).ok).toBeDefined();

      // Rebuilding metadata runs collapse over carried entries. This write
      // is outside the certified subtree, so it does not expire its stamp.
      const tx = runtime.edit();
      runtime.getCell<MapValue>(
        signer.did(),
        "collapse-shadowed-map",
        mapSchema,
        tx,
      ).key("added").set("2");
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const entries = replicaEntries(storageManager, mapId);
      const child = entries.find((entry) =>
        entry.origin === "derived" &&
        entry.path.join("/") === "retained/kept"
      );
      expect(child).toBeDefined();
      expect(child!.label.integrity ?? []).toEqual([]);
      const parent = entries.find((entry) =>
        entry.origin === "derived" && entry.path.join("/") === "retained"
      );
      expect(parent).toBeDefined();
      expect(parent!.label.integrity).toEqual([certified]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps a wildcard-path stamp a declaration at the same pattern covers", async () => {
    // A `*` path stands for many concrete paths, and the declared component
    // can resolve differently at some of them, so the resolution computed at
    // the pattern itself does not settle the question the collapse asks.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      const mapSchema = {
        type: "object",
        additionalProperties: {
          type: "string",
          ifc: { confidentiality: [cfcAtom.resource("Shared")] },
        },
      } as unknown as JSONSchema;
      const mapId = runtime
        .getCell<Record<string, string>>(
          signer.did(),
          "collapse-template-map",
          mapSchema,
        )
        .getAsNormalizedFullLink().id;

      // A `*`-child class template of the kind a declared coordinator
      // container is stamped with, carrying exactly what the declaration
      // beside it carries.
      const seed = runtime.edit();
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: mapId,
        path: [],
      }, {
        value: { kept: "1" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [
              {
                path: ["*"],
                label: { confidentiality: [cfcAtom.resource("Shared")] },
                origin: "declared",
              },
              {
                path: ["*"],
                label: { confidentiality: [cfcAtom.resource("Shared")] },
                origin: "structure",
                observes: "shape",
              },
            ],
          },
        },
        // deno-lint-ignore no-explicit-any
      } as any);
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      runtime.getCell<Record<string, string>>(
        signer.did(),
        "collapse-template-map",
        mapSchema,
        tx,
      ).key("added").set("2");
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const entries = replicaEntries(storageManager, mapId);
      expect(
        entries.some((entry) =>
          entry.origin === "structure" && entry.path.join("/") === "*"
        ),
      ).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps the root stamps a wildcard child declaration does not reach", async () => {
    // A declared entry at `["*"]` covers the children and not the container
    // node they hang off, so the stamps recording what the container's own
    // write derived from stay where they are. The source's clause names the
    // space every document here lives in, which §8.12.4 residency admits into
    // the map's write ceiling.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSource(runtime, "collapse-container-source", [
        cfcAtom.space(signer.did()),
      ]);

      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "collapse-container-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      const map = runtime.getCell<Record<string, string>>(
        signer.did(),
        "collapse-container-map",
        {
          type: "object",
          additionalProperties: {
            type: "string",
            ifc: { confidentiality: [cfcAtom.resource("Secret")] },
          },
        } as unknown as JSONSchema,
        tx,
      );
      map.set({ first: `${raw.secret}!` });
      const mapId = map.getAsNormalizedFullLink().id;
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const entries = replicaEntries(storageManager, mapId);
      expect(
        entries.some((entry) =>
          entry.origin === "declared" && entry.path.join("/") === "*"
        ),
      ).toBe(true);
      const rootStamps = entries.filter((entry) =>
        entry.origin === "derived" && entry.path.length === 0
      );
      expect(rootStamps.length).toBeGreaterThan(0);
      for (const entry of rootStamps) {
        expect(entry.label.confidentiality).toContainEqual(
          cfcAtom.space(signer.did()),
        );
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps a stamp a more specific declared entry sits below", async () => {
    // The declared component resolves by longest matching prefix, so the
    // `["inner"]` declaration replaces the root declaration for reads at that
    // path. A root stamp the root declaration covers is therefore not covered
    // one segment down, and dropping it would lower the label there.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSource(runtime, "collapse-nested-source", [
        cfcAtom.resource("Outer"),
      ]);

      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "collapse-nested-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      const target = runtime.getCell<{ inner?: string }>(
        signer.did(),
        "collapse-nested-target",
        {
          type: "object",
          properties: {
            inner: {
              type: "string",
              ifc: { confidentiality: [cfcAtom.resource("Inner")] },
            },
          },
          ifc: { confidentiality: [cfcAtom.resource("Outer")] },
        } as unknown as JSONSchema,
        tx,
      );
      target.set({ inner: `${raw.secret}!` });
      const targetId = target.getAsNormalizedFullLink().id;
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const entries = replicaEntries(storageManager, targetId);
      const rootStamps = entries.filter((entry) =>
        entry.origin === "derived" && entry.path.length === 0
      );
      expect(rootStamps.length).toBeGreaterThan(0);
      for (const entry of rootStamps) {
        expect(entry.label.confidentiality).toEqual([
          cfcAtom.resource("Outer"),
        ]);
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
