import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { internSchema } from "@commonfabric/data-model-schema";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { seedStoredEnvelope } from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("runner-cfc-labelmap-monotone");

describe("CFC labelMap confidentiality monotonicity", () => {
  // Regression guard for labelMap store-confidentiality monotonicity (audit
  // S9).
  //
  // A persisted path can carry confidentiality beyond what its schema declares
  // (link-derived or carried-view atoms). The persist path re-derived the label
  // from the schema alone and replaced the stored entry, dropping that extra
  // confidentiality — a non-monotone downgrade (§8.12.1: store confidentiality
  // is grow-only). A re-write must preserve it.

  it("preserves stored confidentiality beyond the schema on a re-write", async () => {
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
            secret: { type: "string", ifc: { confidentiality: ["base"] } },
          },
          required: ["secret"],
        } satisfies JSONSchema,
        true,
      );

      // Seed a stored state whose labelMap carries an extra confidentiality atom
      // ("link-derived") beyond the schema's declared ["base"].
      const seed = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "cfc-labelmap-monotone",
        undefined,
        seed,
      );
      const targetId = target.getAsNormalizedFullLink().id;
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: targetId,
        path: [],
      }, {
        value: { secret: "seeded" },
        cfc: {
          version: 1,
          schemaHash: guarded.taggedHashString,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["base", "link-derived"] },
            }],
          },
        },
      });
      seed.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: `cid:${guarded.taggedHashString}`,
        path: [],
      }, { value: guarded.schema });
      expect((await seed.commit()).ok).toBeDefined();

      // Re-write the path through its schema (which declares only ["base"]).
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-labelmap-monotone",
        guarded.schema,
        tx,
      );
      cell.set({ secret: "updated" });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const persistedId = parseLink(cell.getAsLink()).id!;
      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          cfc?: {
            labelMap?: {
              entries: Array<
                { path: string[]; label: { confidentiality?: string[] } }
              >;
            };
          };
        } | undefined;
      };
      const entry = replica.getDocument(persistedId)?.cfc?.labelMap?.entries
        .find((e) => e.path.length === 1 && e.path[0] === "secret");
      expect(entry).toBeDefined();
      expect([...(entry!.label.confidentiality ?? [])].sort()).toEqual(
        ["base", "link-derived"],
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("preserves ancestor confidentiality when re-writing a child path", async () => {
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
            obj: {
              type: "object",
              properties: {
                field: { type: "string", ifc: { confidentiality: ["base"] } },
              },
              required: ["field"],
            },
          },
          required: ["obj"],
        } satisfies JSONSchema,
        true,
      );

      // Seed an ANCESTOR-path labelMap entry (at ["obj"]) carrying extra
      // confidentiality beyond the schema.
      const seed = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "cfc-labelmap-monotone-ancestor",
        undefined,
        seed,
      );
      const targetId = target.getAsNormalizedFullLink().id;
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: targetId,
        path: [],
      }, {
        value: { obj: { field: "seeded" } },
        cfc: {
          version: 1,
          schemaHash: guarded.taggedHashString,
          labelMap: {
            version: 1,
            entries: [{
              path: ["obj"],
              label: { confidentiality: ["ancestor-secret"] },
            }],
          },
        },
      });
      seed.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: `cid:${guarded.taggedHashString}`,
        path: [],
      }, { value: guarded.schema });
      expect((await seed.commit()).ok).toBeDefined();

      // Re-write the CHILD path; its new entry must not shadow (drop) the
      // ancestor's confidentiality under longest-prefix reads.
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-labelmap-monotone-ancestor",
        guarded.schema,
        tx,
      );
      cell.set({ obj: { field: "updated" } });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const persistedId = parseLink(cell.getAsLink()).id!;
      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          cfc?: {
            labelMap?: {
              entries: Array<
                { path: string[]; label: { confidentiality?: string[] } }
              >;
            };
          };
        } | undefined;
      };
      const entries =
        replica.getDocument(persistedId)?.cfc?.labelMap?.entries ??
          [];
      const child = entries.find((e) =>
        e.path.length === 2 && e.path[0] === "obj" && e.path[1] === "field"
      );
      expect(child).toBeDefined();
      expect([...(child!.label.confidentiality ?? [])].sort()).toEqual(
        ["ancestor-secret", "base"],
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
