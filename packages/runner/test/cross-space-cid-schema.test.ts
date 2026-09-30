/**
 * Cross-space reads resolve link schemas in the declaring space. Referenced
 * declarations preserve reader precedence in either space; malformed ones
 * hide data only from readers that adopt them.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { EntityDocument } from "@commonfabric/memory/v2";

import type { Cell } from "../src/cell.ts";
import {
  SEED_ENVELOPE_SCHEMA,
  SEED_ENVELOPE_SCHEMA_HASH,
  storedReferenceEnvelope,
} from "./cfc-seed-envelope.ts";
import { resolveLink } from "../src/link-resolution.ts";
import { Runtime } from "../src/runtime.ts";
import { decomposeSchema } from "../src/schema-decompose.ts";
import { registerSchemaDocument } from "../src/schema-registry.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { URI } from "../src/storage/interface.ts";

describe("cross-space-cid-schema", () => {
  for (
    const route of [
      "value",
      "whole document",
      "path",
      "cell",
      "array cell",
      "reader schema",
      "carried reader schema",
      "same-space carried reader schema",
      "malformed declaration",
      "shaped reader over malformed declaration",
      "two space crossings",
    ] as const
  ) {
    const description = route === "malformed declaration"
      ? "returns a rejecting schema for a malformed link declaration"
      : `reads through ${route} using schema documents held only in the source space`;
    it(description, async () => {
      const signer = await Identity.fromPassphrase("cid schema source");
      const sourceSpace = signer.did();
      const carriesReader = route === "carried reader schema" ||
        route === "same-space carried reader schema";
      const shapedReader = route === "reader schema" ||
        route === "shaped reader over malformed declaration";
      const targetSpace = route === "same-space carried reader schema"
        ? sourceSpace
        : (await Identity.fromPassphrase("cid schema target")).did();
      const finalSpace = (await Identity.fromPassphrase("cid schema final"))
        .did();
      const manager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        storageManager: manager,
        apiUrl: new URL(import.meta.url),
      });
      const decomposed = decomposeSchema(
        carriesReader ? {} : {
          type: "object",
          properties: { name: { $ref: "#/$defs/Name" } },
          required: ["name"],
          $defs: { Name: { type: "string" } },
        },
      );
      const sourceId = "of:cid-schema-source" as URI;
      const targetId = "of:cid-schema-target" as URI;
      const source = {
        value: {
          target: {
            "/": {
              [LINK_V1_TAG]: {
                space: targetSpace,
                id: targetId,
                path: [],
                schema: { $ref: decomposed.rootRef },
              },
            },
          },
        },
      };
      const readerSchema = decomposeSchema({
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      });
      const sourceDocs = new Map<string, EntityDocument>([
        [sourceId, source],
        ...[...decomposed.documents].map(([hash, schema]) =>
          [`cid:${hash}`, { value: schema }] as [string, EntityDocument]
        ),
      ]);
      if (shapedReader || carriesReader) {
        for (const [hash, schema] of readerSchema.documents) {
          sourceDocs.set(`cid:${hash}`, { value: schema });
        }
      }
      if (route === "array cell") {
        sourceDocs.set(sourceId, { value: { targets: [source.value.target] } });
      }
      if (route.includes("malformed declaration")) {
        // A malformed declaration below the write API: the referenced closure
        // is complete, but a numeric definition cannot be recomposed.
        sourceDocs.set(sourceId, {
          value: {
            target: {
              "/": {
                [LINK_V1_TAG]: {
                  ...source.value.target["/"][LINK_V1_TAG],
                  schema: { $ref: decomposed.rootRef, $defs: { Invalid: 17 } },
                },
              },
            },
          },
        });
      }
      const targetDocs = new Map<string, EntityDocument>([
        [targetId, { value: { name: "Ada", extra: "outside the schema" } }],
      ]);
      if (targetSpace === sourceSpace) {
        for (const [id, doc] of targetDocs) sourceDocs.set(id, doc);
        targetDocs.clear();
      }
      const finalDocs = new Map<string, EntityDocument>();
      if (route === "two space crossings") {
        const finalId = "of:cid-schema-final" as URI;
        const targetSchema = decomposeSchema({
          type: "object",
          properties: { name: { $ref: "#/$defs/NonemptyName" } },
          required: ["name"],
          $defs: { NonemptyName: { type: "string", minLength: 1 } },
        });
        targetDocs.set(targetId, {
          value: {
            "/": {
              [LINK_V1_TAG]: {
                space: finalSpace,
                id: finalId,
                path: [],
                schema: { $ref: targetSchema.rootRef },
              },
            },
          },
        });
        for (const [hash, schema] of targetSchema.documents) {
          targetDocs.set(`cid:${hash}`, { value: schema });
        }
        finalDocs.set(finalId, { value: { name: "Ada" } });
      }
      const schemaReads: string[] = [];
      const expectedSchemaReads: string[] = [];
      for (
        const [space, docs] of [
          [sourceSpace, sourceDocs],
          [targetSpace, targetDocs],
          [finalSpace, finalDocs],
        ] as const
      ) {
        if (docs.size > 0) {
          docs.set(`cid:${SEED_ENVELOPE_SCHEMA_HASH}`, {
            value: SEED_ENVELOPE_SCHEMA,
          });
        }
        for (const id of docs.keys()) {
          if (
            id.startsWith("cid:") && id !== `cid:${SEED_ENVELOPE_SCHEMA_HASH}`
          ) expectedSchemaReads.push(`${space}/${id}`);
        }
        if (docs.size === 0) continue;
        manager.installStoreReadThrough(space, ({ id, scopeKey }) => {
          if (
            id.startsWith("cid:") && id !== `cid:${SEED_ENVELOPE_SCHEMA_HASH}`
          ) schemaReads.push(`${space}/${id}`);
          const stored = docs.get(id);
          const doc = stored !== undefined && !id.startsWith("cid:")
            ? storedReferenceEnvelope({ value: stored.value })
            : stored;
          return {
            branch: "",
            id,
            scope: "space",
            scopeKey,
            ...(doc === undefined
              ? { seq: 0, deleted: true as const }
              : { seq: 1, doc }),
          };
        });
      }
      try {
        const cell = runtime.getCellFromLink({
          space: sourceSpace,
          id: sourceId,
          path: [],
        });
        await cell.sync();
        if (route === "malformed declaration") {
          const tx = runtime.edit();
          try {
            const target = resolveLink(
              runtime,
              tx,
              cell.key("target").getAsNormalizedFullLink(),
            );
            expect(target.schema).toBe(false);
          } finally {
            tx.abort();
          }
        } else if (carriesReader) {
          const tx = runtime.edit();
          let target;
          try {
            target = runtime.getCellFromLink(resolveLink(runtime, tx, {
              ...cell.key("target").getAsNormalizedFullLink(),
              schema: { $ref: readerSchema.rootRef },
            }));
          } finally {
            tx.abort();
          }
          if (route === "same-space carried reader schema") {
            expect(target.getAsNormalizedFullLink().schema).toEqual({
              $ref: readerSchema.rootRef,
            });
          }
          const value = await target.pull() as { name: string; extra?: string };
          expect(value?.name).toBe("Ada");
          expect(value.extra).toBeUndefined();
        } else if (route === "cell") {
          const { target } = cell.asSchema({
            type: "object",
            properties: { target: { asCell: ["cell"] } },
            required: ["target"],
          }).get() as { target: Cell<{ name: string }> };
          expect((await target.pull())?.name).toBe("Ada");
        } else if (route === "array cell") {
          const { targets } = cell.asSchema({
            type: "object",
            properties: {
              targets: { type: "array", items: { asCell: ["cell"] } },
            },
            required: ["targets"],
          }).get() as { targets: Cell<{ name: string }>[] };
          expect((await targets[0].pull())?.name).toBe("Ada");
        } else if (route === "whole document") {
          const value = await cell.asSchema(true).pull() as {
            target: { name: string };
          };
          expect(value?.target?.name).toBe("Ada");
        } else if (route === "path") {
          expect(await cell.key("target").key("name").pull()).toBe("Ada");
        } else if (shapedReader) {
          const value = await cell.asSchema({
            type: "object",
            properties: { target: { $ref: readerSchema.rootRef } },
            required: ["target"],
          }).pull() as { target: { name: string; extra?: string } };
          expect(value?.target?.name).toBe("Ada");
          expect(value.target.extra).toBeUndefined();
        } else {
          const value = await cell.key("target").pull() as { name: string };
          expect(value?.name).toBe("Ada");
        }
        expect(schemaReads).toContain(`${sourceSpace}/${decomposed.rootRef}`);
        expect(new Set(schemaReads)).toEqual(new Set(expectedSchemaReads));
      } finally {
        await runtime.dispose();
        await manager.close();
      }
    });
  }

  // A same-space hop keeps a carried reader schema in reference form, so a
  // closure that is not at hand yet must stay recoverable: the read selects
  // nothing while the documents are missing, and reads once they arrive. A
  // link narrowed to `false` at resolution would stay blind after arrival.
  it("reads through a same-space carried reader schema once its missing documents arrive", async () => {
    const signer = await Identity.fromPassphrase("cid schema late closure");
    const space = signer.did();
    const manager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      storageManager: manager,
      apiUrl: new URL(import.meta.url),
    });
    const sourceId = "of:cid-schema-late-source" as URI;
    const targetId = "of:cid-schema-late-target" as URI;
    const readerSchema = decomposeSchema({
      type: "object",
      properties: { lateName: { type: "string" } },
      required: ["lateName"],
      additionalProperties: false,
    });
    const docs = new Map<string, EntityDocument>([
      [sourceId, {
        value: {
          target: {
            "/": { [LINK_V1_TAG]: { id: targetId, path: [] } },
          },
        },
      }],
      [targetId, { value: { lateName: "Ada", extra: "outside the schema" } }],
    ]);
    docs.set(`cid:${SEED_ENVELOPE_SCHEMA_HASH}`, {
      value: SEED_ENVELOPE_SCHEMA,
    });
    manager.installStoreReadThrough(space, ({ id, scopeKey }) => {
      const stored = docs.get(id);
      const doc = stored !== undefined && !id.startsWith("cid:")
        ? storedReferenceEnvelope({ value: stored.value })
        : stored;
      return {
        branch: "",
        id,
        scope: "space",
        scopeKey,
        ...(doc === undefined
          ? { seq: 0, deleted: true as const }
          : { seq: 1, doc }),
      };
    });
    try {
      const cell = runtime.getCellFromLink({ space, id: sourceId, path: [] });
      await cell.sync();
      const tx = runtime.edit();
      let target;
      try {
        target = runtime.getCellFromLink(resolveLink(runtime, tx, {
          ...cell.key("target").getAsNormalizedFullLink(),
          schema: { $ref: readerSchema.rootRef },
        }));
      } finally {
        tx.abort();
      }
      expect(target.getAsNormalizedFullLink().schema).toEqual({
        $ref: readerSchema.rootRef,
      });
      expect(await target.pull()).toBeUndefined();
      for (const [hash, schema] of readerSchema.documents) {
        registerSchemaDocument(hash, schema);
      }
      const value = await target.pull() as {
        lateName: string;
        extra?: string;
      };
      expect(value?.lateName).toBe("Ada");
      expect(value.extra).toBeUndefined();
    } finally {
      await runtime.dispose();
      await manager.close();
    }
  });
});
