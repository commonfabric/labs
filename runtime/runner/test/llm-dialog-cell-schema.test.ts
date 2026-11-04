import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type Pattern } from "../src/builder/types.ts";
import { resolvedSchema } from "./schema-ref-helpers.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { trustExecutable } from "./support/trusted-builder.ts";
import { llmDialogTestHelpers } from "../src/builtins/llm-dialog.ts";

const { getCellSchema } = llmDialogTestHelpers;

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("getCellSchema", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  const resultSchema = {
    type: "object",
    description: "A #doubler piece.",
    properties: {
      doubled: { type: "number", description: "the doubled #value" },
    },
  } as const satisfies JSONSchema;
  const pattern: Pattern = {
    argumentSchema: {
      type: "object",
      properties: { value: { type: "number" } },
    },
    resultSchema,
    result: { doubled: { $alias: { partialCause: "doubled", path: [] } } },
    nodes: [
      {
        module: {
          type: "javascript",
          implementation: (v: number) => v * 2,
        },
        inputs: { $alias: { cell: "argument", path: ["value"] } },
        outputs: { $alias: { partialCause: "doubled", path: [] } },
      },
    ],
  };

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  async function runPiece() {
    const resultCell = runtime.getCell(space, "get-cell-schema-piece");
    const result = await runtime.runSynced(
      resultCell,
      trustExecutable(runtime, pattern),
      { value: 21 },
    );
    await result.pull();
    await runtime.idle();
    await tx.commit().settled;
    tx = runtime.edit();
    return result;
  }

  it("recovers resultSchema from result doc meta for a schemaless cell", async () => {
    const result = await runPiece();

    const bare = (result as any).asSchema(undefined);
    const schema = getCellSchema(bare) as any;

    expect(schema?.description).toBe("A #doubler piece.");
    expect(schema?.properties?.doubled?.type).toBe("number");
  });

  it("recovers field schema from meta projection for a schemaless child cell", async () => {
    const result = await runPiece();

    const bareField = (result as any).asSchema(undefined).key("doubled");
    const schema = getCellSchema(bareField) as any;

    expect(schema?.type).toBe("number");
    expect(schema?.description).toBe("the doubled #value");
  });

  it("returns the link-embedded schema for a reference written under one", async () => {
    const result = await runPiece();

    const holderSchema = {
      type: "object",
      properties: { ref: { asCell: ["cell"] } },
    } as const satisfies JSONSchema;
    const minimalView = (result as any).asSchema({
      type: "object",
      properties: { name: { type: "string" } },
    });
    const holder = runtime.getCell(
      space,
      "get-cell-schema-holder",
      holderSchema as any,
      tx,
    );
    (holder as any).key("ref").set(minimalView);
    await tx.commit().settled;
    tx = runtime.edit();

    const bareRef = runtime
      .getCell(space, "get-cell-schema-holder", undefined, tx)
      .key("ref");
    const schema = resolvedSchema(getCellSchema(bareRef as any)) as any;

    expect(schema?.properties?.name?.type).toBe("string");
  });

  it("recovers resultSchema from meta of a resolved reference target", async () => {
    const result = await runPiece();

    const holderSchema = {
      type: "object",
      properties: { ref: { asCell: ["cell"] } },
    } as const satisfies JSONSchema;
    const holder = runtime.getCell(
      space,
      "get-cell-schema-resolved-holder",
      holderSchema as any,
      tx,
    );
    // Store a schema-cleared reference so the link embeds no schema: the
    // schema can then only be recovered by resolving the reference to the
    // result document and reading its meta "schema".
    (holder as any).key("ref").set((result as any).asSchema(undefined));
    await tx.commit().settled;
    tx = runtime.edit();

    const bareRef = runtime
      .getCell(space, "get-cell-schema-resolved-holder", undefined, tx)
      .key("ref");
    // The reference carries no schema in the link or the holder document,
    // so recovery must follow the reference to the result document's meta.
    const linkSchema = (bareRef as any).asSchemaFromLinks()
      .getAsNormalizedFullLink().schema;
    expect(linkSchema).toBeUndefined();
    const schema = resolvedSchema(getCellSchema(bareRef as any)) as any;

    expect(schema?.description).toBe("A #doubler piece.");
    expect(schema?.properties?.doubled?.type).toBe("number");
  });

  it("falls back to a value-derived schema when no schema is recorded", async () => {
    const plain = runtime.getCell<{ alpha: number; beta: string }>(
      space,
      "get-cell-schema-plain",
      undefined,
      tx,
    );
    plain.set({ alpha: 1, beta: "two" });
    await tx.commit().settled;
    tx = runtime.edit();

    const bare = runtime.getCell(space, "get-cell-schema-plain", undefined, tx);
    const schema = getCellSchema(bare as any) as any;

    // No pattern schema and no meta "schema": getCellSchema derives a minimal
    // object schema listing the present keys.
    expect(schema?.type).toBe("object");
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual([
      "alpha",
      "beta",
    ]);
  });
});
