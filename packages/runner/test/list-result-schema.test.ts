import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { exportCell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { listResultSchema } from "../src/builtins/list-result-schema.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { type FactoryInput, type JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-list-result-schema");
const space = signer.did();

describe("listResultSchema", () => {
  it("builds a plain array schema without item schema", () => {
    expect(listResultSchema()).toEqual({ type: "array" });
  });

  it("threads the item schema and hoists its $defs", () => {
    const itemSchema = {
      type: "object",
      properties: { value: { $ref: "#/$defs/v" } },
      $defs: { v: { type: "number" } },
    } as JSONSchema;
    expect(listResultSchema(itemSchema)).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { value: { $ref: "#/$defs/v" } },
      },
      $defs: { v: { type: "number" } },
    });
  });

  it("supports boolean item schemas", () => {
    expect(listResultSchema(true)).toEqual({ type: "array", items: true });
  });

  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  // The three container schemas a run of map, filter and flatMap over one
  // source array produces, as each op's own output cell reports them. The
  // pattern's argument schema is the knob: it is what the builder reads the
  // source's label off.
  const containerSchemas = async (
    argumentSchema: JSONSchema,
    cause: string,
  ): Promise<(JSONSchema | undefined)[]> => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern } = commonfabric;
    let mappedRef: any;
    let filteredRef: any;
    let flattenedRef: any;

    const tx = runtime.edit();
    const valuesCell = runtime.getCell(
      space,
      `${cause}-values`,
      { type: "array", items: { type: "number" } },
      tx,
    );
    valuesCell.set([]);

    const collectionPattern = pattern<{ values: number[] }>(({ values }) => {
      mappedRef = (values as any).mapWithPattern(
        pattern(({ element, index, array }: FactoryInput<any>) =>
          (((value: number) => value) as any)(element, index, array)
        ),
        {},
      );
      filteredRef = (values as any).filterWithPattern(
        pattern(({ element, index, array }: FactoryInput<any>) =>
          (((_value: number) => true) as any)(element, index, array)
        ),
        {},
      );
      flattenedRef = (values as any).flatMapWithPattern(
        pattern(({ element, index, array }: FactoryInput<any>) =>
          (((value: number) => [value]) as any)(element, index, array)
        ),
        {},
      );
      return {
        mapped: mappedRef,
        filtered: filteredRef,
        flattened: flattenedRef,
      };
    }, argumentSchema);

    const resultCell = runtime.getCell(
      space,
      `${cause}-result`,
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      collectionPattern,
      { values: valuesCell },
      resultCell,
    );

    await tx.commit().settled;
    await result.pull();

    return [mappedRef, filteredRef, flattenedRef].map((ref) =>
      exportCell(ref).schema
    );
  };

  it("attaches claim-free array schemas to list builtin outputs", async () => {
    // Do-not-regress for the flowPrecisionClaim removal: an unlabeled source
    // yields a plain array schema, and no op mints an ifc annotation of its
    // own. Pointwise label precision is structural (per-element ops run in
    // their own transactions reading only their element), not a minted
    // trusted claim.

    const schemas = await containerSchemas(
      {
        type: "object",
        properties: {
          values: { type: "array", items: { type: "number" } },
        },
      },
      "list-result-schema",
    );

    for (const schema of schemas) {
      expect((schema as any)?.type).toBe("array");
      expect((schema as any)?.ifc).toBeUndefined();
    }
  });

  it("carries a labeled source's confidentiality onto each container", async () => {
    // The source array is the only input any of the three ops reads, so its
    // label is the one the result container stands for. The op writes the
    // container schema over the link the node factory labeled, and this is
    // the assertion that the label survives that write.

    const schemas = await containerSchemas(
      {
        type: "object",
        properties: {
          values: {
            type: "array",
            items: { type: "number" },
            ifc: { confidentiality: ["secret"] },
          },
        },
      },
      "list-result-schema-labeled",
    );

    for (const schema of schemas) {
      expect((schema as any)?.type).toBe("array");
      expect((schema as any)?.ifc?.confidentiality).toEqual(["secret"]);
    }
  });
});
