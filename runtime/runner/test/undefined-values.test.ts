import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { getCellWithStatus } from "../src/cell.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { wishStateSchemaForResult } from "../src/builtins/wish-schema.ts";
import { ContextualFlowControl } from "../src/cfc.ts";
import { pruneCfcSchemaDefinitions } from "../src/cfc/schema-refs.ts";

const signer = await Identity.fromPassphrase("undefined values");
const space = signer.did();

Deno.test("explicit undefined object properties are preserved", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  let tx: IExtendedStorageTransaction = runtime.edit();

  try {
    const cell = runtime.getCell<{ a?: number; b: number }>(
      space,
      "undefined-values-object",
      undefined,
      tx,
    );

    cell.set({ a: undefined, b: 2 });
    await tx.commit().settled;
    tx = runtime.edit();

    const value = cell.get() as Record<string, unknown>;
    assertEquals(Object.hasOwn(value, "a"), true);
    assertEquals(value.a, undefined);
    assertEquals(value.b, 2);
  } finally {
    await tx.commit().settled;
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("required undefined survives a schema-aware cell round trip", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const schema = {
    type: "object",
    properties: {
      result: {
        anyOf: [
          { type: "undefined" },
          { type: "object", asCell: ["cell"] },
        ],
      },
      candidates: { type: "array", items: true },
    },
    required: ["result", "candidates"],
  } as const;

  let tx: IExtendedStorageTransaction = runtime.edit();
  try {
    const cell = runtime.getCell<{
      result: unknown | undefined;
      candidates: unknown[];
    }>(space, "undefined-values-schema-aware", schema, tx);
    cell.set({ result: undefined, candidates: [] });
    await tx.commit().settled;
    tx = runtime.edit();

    const raw = cell.getRaw() as Record<string, unknown>;
    assertEquals(Object.hasOwn(raw, "result"), true);
    const value = cell.get() as Record<string, unknown>;
    assertEquals(Object.hasOwn(value, "result"), true);
    assertEquals(value.result, undefined);
    assertEquals(value.candidates, []);
  } finally {
    await tx.commit().settled;
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("required undefined survives source and target schema combination", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const stateSchema = {
    type: "object",
    properties: {
      result: {
        anyOf: [
          { type: "undefined" },
          { type: "object", asCell: ["cell"] },
        ],
      },
      candidates: { type: "array", items: true },
      "$UI": true,
    },
    required: ["result", "candidates"],
  } as const;
  const captureSchema = {
    type: "object",
    properties: {
      wishResult: {
        type: "object",
        properties: {
          result: {
            anyOf: [
              { type: "undefined" },
              {
                type: "object",
                properties: {
                  auth: {
                    anyOf: [
                      { type: "undefined" },
                      { type: "object", asCell: ["cell"] },
                    ],
                  },
                },
              },
            ],
          },
          candidates: { type: "array", items: { type: "object" } },
          "$UI": true,
        },
        required: ["result", "candidates", "$UI"],
      },
    },
    required: ["wishResult"],
  } as const;

  let tx: IExtendedStorageTransaction = runtime.edit();
  try {
    const target = runtime.getCell<{
      result: unknown | undefined;
      candidates: unknown[];
      $UI: unknown;
    }>(space, "undefined-values-combined-target", stateSchema, tx);
    target.set({ result: undefined, candidates: [], $UI: { type: "vnode" } });
    const holder = runtime.getCell<{ wishResult: unknown }>(
      space,
      "undefined-values-combined-holder",
      undefined,
      tx,
    );
    holder.set({ wishResult: target.getAsLink() });
    await tx.commit().settled;
    tx = runtime.edit();

    const raw = target.getRaw() as Record<string, unknown>;
    assertEquals(Object.hasOwn(raw, "result"), true);
    const captured = holder.asSchema(captureSchema).get() as {
      wishResult: Record<string, unknown>;
    };
    assertEquals(Object.hasOwn(captured.wishResult, "result"), true);
    assertEquals(captured.wishResult.result, undefined);
  } finally {
    await tx.commit().settled;
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("wish output schema preserves undefined through its result redirect", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const pieceSchema = {
    type: "object",
    properties: {
      auth: {
        anyOf: [
          { type: "undefined" },
          { type: "object", asCell: ["cell"] },
        ],
      },
    },
  } as const;
  const stateSchema = wishStateSchemaForResult(pieceSchema)!;
  const captureSchema = {
    type: "object",
    properties: {
      wishResult: {
        type: "object",
        properties: {
          result: {
            anyOf: [
              { type: "undefined" },
              pieceSchema,
            ],
          },
          candidates: { type: "array", items: pieceSchema },
          error: true,
          "$UI": true,
        },
        required: ["result", "candidates", "$UI"],
      },
    },
    required: ["wishResult"],
  } as const;

  let tx: IExtendedStorageTransaction = runtime.edit();
  const frame = pushFrame({ runtime, space });
  try {
    const { commonfabric } = createBuilder();
    const graph = commonfabric.pattern(() => ({
      wishResult: commonfabric.wish(
        { query: "#missing" },
        pieceSchema as JSONSchema,
      ),
    }));
    const outputSchema = (graph.nodes[0].module as {
      resultSchema?: JSONSchema;
    }).resultSchema;
    assertEquals(outputSchema, stateSchema);

    const target = runtime.getCell<{
      result: unknown | undefined;
      candidates: unknown[];
      $UI: unknown;
    }>(space, "undefined-values-wish-target", stateSchema, tx);
    target.set({
      result: undefined,
      candidates: [],
      $UI: { type: "vnode" },
    });
    const resultRedirect = runtime.getCell(
      space,
      "undefined-values-wish-result-redirect",
      outputSchema,
      tx,
    );
    resultRedirect.setRaw(
      target.getAsWriteRedirectLink({ includeSchema: true }),
    );
    const holder = runtime.getCell<{ wishResult: unknown }>(
      space,
      "undefined-values-wish-holder",
      undefined,
      tx,
    );
    holder.set({
      wishResult: resultRedirect.getAsLink({ includeSchema: true }),
    });
    await tx.commit().settled;
    tx = runtime.edit();

    const captured = getCellWithStatus(holder.asSchema(captureSchema));
    if ("error" in captured) throw captured.error;
    const wishResult = captured.ok.wishResult as Record<string, unknown>;
    assertEquals(Object.hasOwn(wishResult, "result"), true);
    assertEquals(wishResult.result, undefined);
    assertEquals(wishResult.candidates, []);
  } finally {
    popFrame(frame);
    await tx.commit().settled;
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("wish output schema preserves local defs through result paths", () => {
  const pieceSchema = {
    type: "object",
    properties: {
      allPieces: {
        type: "array",
        items: { $ref: "#/$defs/MinimalPiece" },
        asCell: ["cell"],
      },
    },
    required: ["allPieces"],
    $defs: {
      MinimalPiece: {
        type: "object",
        properties: { "$NAME": { type: "string" } },
      },
    },
  } as const;

  // Watch selectors prune definitions independently at every nested schema
  // boundary. schemaAtPath must therefore adopt the selected anyOf branch's
  // local definition scope rather than relying on a duplicate root $defs map.
  const stateSchema = pruneCfcSchemaDefinitions(
    wishStateSchemaForResult(pieceSchema)!,
  );
  const allPiecesSchema = ContextualFlowControl.schemaAtPath(
    stateSchema,
    ["result", "allPieces"],
  );

  assertEquals(
    (allPiecesSchema as { $defs?: unknown }).$defs,
    pieceSchema.$defs,
  );
  ContextualFlowControl.joinSchema(new Set(), allPiecesSchema);
});

Deno.test("removed keys are deleted, not left as undefined", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  let tx: IExtendedStorageTransaction = runtime.edit();

  try {
    const cell = runtime.getCell<{ a?: number; b: number }>(
      space,
      "undefined-values-removed-key",
      undefined,
      tx,
    );

    cell.set({ a: 1, b: 2 });
    await tx.commit().settled;
    tx = runtime.edit();

    cell.withTx(tx).set({ b: 2 });
    await tx.commit().settled;
    tx = runtime.edit();

    const value = cell.get() as Record<string, unknown>;
    assertEquals(Object.hasOwn(value, "a"), false);
    assertEquals(Object.keys(value), ["b"]);
  } finally {
    await tx.commit().settled;
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("overwriting a value with undefined keeps the key present", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  let tx: IExtendedStorageTransaction = runtime.edit();

  try {
    const cell = runtime.getCell<{ a?: number; b: number }>(
      space,
      "undefined-values-overwrite",
      undefined,
      tx,
    );

    cell.set({ a: 1, b: 2 });
    await tx.commit().settled;
    tx = runtime.edit();

    cell.withTx(tx).set({ a: undefined, b: 2 });
    await tx.commit().settled;
    tx = runtime.edit();

    const value = cell.get() as Record<string, unknown>;
    assertEquals(Object.hasOwn(value, "a"), true);
    assertEquals(value.a, undefined);
  } finally {
    await tx.commit().settled;
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("array elements set to undefined stay present-but-undefined", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  let tx: IExtendedStorageTransaction = runtime.edit();

  try {
    const cell = runtime.getCell<{ list: (number | undefined)[] }>(
      space,
      "undefined-values-array",
      undefined,
      tx,
    );

    cell.set({ list: [1, 2, 3] });
    await tx.commit().settled;
    tx = runtime.edit();

    cell.withTx(tx).set({ list: [1, undefined, 3] });
    await tx.commit().settled;
    tx = runtime.edit();

    const value = cell.get() as { list: (number | undefined)[] };
    assertEquals(value.list.length, 3);
    assertEquals(1 in value.list, true);
    assertEquals(value.list[1], undefined);
    assertEquals(value.list[0], 1);
    assertEquals(value.list[2], 3);
  } finally {
    await tx.commit().settled;
    await runtime.dispose();
    await storageManager.close();
  }
});
