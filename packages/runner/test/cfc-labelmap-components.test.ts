import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { internSchema } from "@commonfabric/data-model-schema";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-labelmap-components");

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

describe("CFC labelMap component origins", () => {
  // labelMap v2 components (S16 design): persisted entries carry their
  // provenance component so each can follow its own update discipline —
  // `declared` (schema store policy, monotone), `link` (reference-carried,
  // replaced when the link is rewritten), `derived` (default-transition flow
  // labels, replaced on overwrite). Effective label = join of components.

  it("tags schema-derived entries as declared", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const guarded = internSchema(
        {
          type: "object",
          properties: {
            secret: { type: "string", ifc: { confidentiality: ["secret"] } },
          },
          required: ["secret"],
        } satisfies JSONSchema,
        true,
      );

      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-components-declared",
        guarded.schema,
        tx,
      );
      cell.set({ secret: "hello" });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const persistedId = parseLink(cell.getAsLink()).id!;
      const entry = replicaEntries(storageManager, persistedId).find((e) =>
        e.path.length === 1 && e.path[0] === "secret"
      );
      expect(entry).toBeDefined();
      expect(entry!.origin).toBe("declared");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("skips the labelMap write when recomputed metadata is unchanged", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const guarded = internSchema(
        {
          type: "object",
          properties: {
            secret: { type: "string", ifc: { confidentiality: ["secret"] } },
          },
          required: ["secret"],
        } satisfies JSONSchema,
        true,
      );

      const seed = runtime.edit();
      const seedCell = runtime.getCell(
        signer.did(),
        "cfc-components-unchanged",
        guarded.schema,
        seed,
      );
      seedCell.set({ secret: "v1" });
      seed.prepareCfc();
      expect((await seed.commit()).ok).toBeDefined();

      // Re-write the labeled path through the same schema: the recomputed
      // labelMap is identical, so persistence must be a no-op — reactive
      // re-runs re-derive labels constantly and must not churn storage.
      // The mechanism is the journal's novelty diffing (value-identical
      // writes never become write details / commit ops); this pins that
      // end-to-end so a future persistence change can't regress it.
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-components-unchanged",
        guarded.schema,
        tx,
      );
      cell.set({ secret: "v2" });
      tx.prepareCfc();

      const persistedId = parseLink(cell.getAsLink()).id!;
      const cfcWrites = [...(tx.getWriteDetails?.(signer.did()) ?? [])]
        .filter((write) =>
          write.address.id === persistedId && write.address.path[0] === "cfc"
        );
      expect(cfcWrites).toEqual([]);
      expect((await tx.commit()).ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("tags link-write entries as link", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const seed = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "cfc-components-link-source",
        {
          type: "object",
          ifc: { confidentiality: ["shared-space"] },
          properties: { title: { type: "string" } },
        } satisfies JSONSchema,
        seed,
      );
      source.set({ title: "pointed-at" });
      seed.prepareCfc();
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      const linkedSource = runtime.getCell(
        signer.did(),
        "cfc-components-link-source",
        undefined,
        tx,
      );
      const holder = runtime.getCell(
        signer.did(),
        "cfc-components-link-holder",
        undefined,
        tx,
      );
      holder.set(linkedSource);
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const persistedId = holder.getAsNormalizedFullLink().id;
      const entry = replicaEntries(storageManager, persistedId).find((e) =>
        e.path.length === 0
      );
      expect(entry).toBeDefined();
      expect(entry!.origin).toBe("link");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("mints declared entries for tuple (prefixItems) slots at their index", async () => {
    // The IFC schema walk descends `prefixItems`, so an `ifc` on a tuple slot
    // mints a labelMap entry and the tuple data carries its declared taint.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const guarded = internSchema(
        {
          type: "object",
          properties: {
            pair: {
              type: "array",
              // The negated branch is deliberately NOT minted (its ifc must
              // not label real data); walking past it is pinned here.
              not: { type: "string", ifc: { confidentiality: ["negated"] } },
              prefixItems: [
                { type: "string", ifc: { confidentiality: ["secret"] } },
                { type: "number" },
              ],
            },
          },
        } satisfies JSONSchema,
        true,
      );

      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-components-tuple-slot",
        guarded.schema,
        tx,
      );
      cell.set({ pair: ["hush", 7] });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const persistedId = parseLink(cell.getAsLink()).id!;
      const entries = replicaEntries(storageManager, persistedId);
      // The slot label lands at its concrete index, not a `*` wildcard.
      const slot = entries.find((e) =>
        e.path.length === 2 && e.path[0] === "pair" && e.path[1] === "0"
      );
      expect(slot).toBeDefined();
      expect(slot!.origin).toBe("declared");
      expect(slot!.label.confidentiality).toEqual(["secret"]);
      // The unlabeled slot mints nothing.
      expect(entries.some((e) => e.path[1] === "1")).toBe(false);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a labeled items rest schema beside prefixItems keeps its wildcard entry", async () => {
    // PR #4969 review: dropping the `*` entry for the mixed tuple-plus-rest
    // shape silently dropped the tail elements' declared labels (fail-open).
    // The `*` stays — it over-taints the slots with the rest labels, the
    // fail-safe direction — and the slots still mint at their index.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const guarded = internSchema(
        {
          type: "object",
          properties: {
            pair: {
              type: "array",
              prefixItems: [
                { type: "string", ifc: { confidentiality: ["secret"] } },
              ],
              items: { type: "number", ifc: { confidentiality: ["rest"] } },
            },
          },
        } satisfies JSONSchema,
        true,
      );

      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-components-tuple-rest",
        guarded.schema,
        tx,
      );
      cell.set({ pair: ["hush", 7] });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const persistedId = parseLink(cell.getAsLink()).id!;
      const entries = replicaEntries(storageManager, persistedId);
      const slot = entries.find((e) =>
        e.path.length === 2 && e.path[0] === "pair" && e.path[1] === "0"
      );
      expect(slot).toBeDefined();
      expect(slot!.label.confidentiality).toEqual(["secret"]);
      const wildcard = entries.find((e) =>
        e.path.length === 2 && e.path[0] === "pair" && e.path[1] === "*"
      );
      expect(wildcard).toBeDefined();
      expect(wildcard!.label.confidentiality).toEqual(["rest"]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
