import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { OpaqueCell } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";

import type { Cell } from "../src/cell.ts";
import { getMetaLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("raw builtin back link");
const space = signer.did();

describe("raw-builtin-back-link", () => {
  // A list builtin links each cell it mints back to the result cell of the
  // piece running it, through that cell's `result` meta field. Every runtime
  // running the piece writes that field, so it has to come out the same
  // whichever way the piece was started: a client starts a new piece on a
  // result cell carrying the pattern's result schema, and a server starts a
  // stored piece on a bare link to it. Each case starts the same parent
  // pattern both ways and compares what the builtin wrote.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<
    typeof createTrustedBuilder
  >["commonfabric"]["pattern"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    ({ pattern } = createTrustedBuilder(runtime).commonfabric);
  });

  afterEach(async () => {
    if (tx.status().status === "ready") {
      runtime.prepareTxForCommit(tx);
      await tx.commit().settled;
    }
    await runtime?.dispose();
    await storageManager?.close();
  });

  type Apply = (values: OpaqueCell<number[]>, op: unknown) => unknown;

  const argumentSchema = {
    type: "object",
    properties: { values: { type: "array", items: { type: "number" } } },
    required: ["values"],
  } as const satisfies JSONSchema;

  const resultSchema = {
    type: "object",
    properties: { out: { type: "array", items: {} } },
    required: ["out"],
  } as const satisfies JSONSchema;

  /**
   * Runs `apply` over the list `[1, 2]` inside a piece started on a result
   * cell that carries `schema`, and returns that result cell once the builtin
   * has settled. Each element's op returns `{ element }`.
   */
  async function runListBuiltin(
    name: string,
    apply: Apply,
    schema: JSONSchema | undefined,
  ): Promise<Cell<{ out: unknown[] }>> {
    // deno-lint-ignore no-explicit-any
    const op = pattern(({ element }: any) => ({ element }));
    const parentPattern = pattern<{ values: number[] }>(
      ({ values }) => ({
        out: apply(values as unknown as OpaqueCell<number[]>, op),
      }),
      argumentSchema,
      resultSchema,
    );
    const resultCell = runtime.getCell<{ out: unknown[] }>(
      space,
      name,
      schema,
      tx,
    );
    const result = runtime.run(
      tx,
      parentPattern,
      { values: [1, 2] },
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    tx = runtime.edit();
    await result.pull();
    await runtime.idle();
    return result;
  }

  /**
   * The `result` back-links of the cells `apply` mints in the piece `result`:
   * its container's, and, when `element` is set, its first element's. Each
   * back-link is checked to name `result`'s piece.
   */
  function backLinkSchemas(
    result: Cell<{ out: unknown[] }>,
    element: boolean,
  ): unknown[] {
    const id = result.getAsNormalizedFullLink().id;
    const container = result.key("out").resolveAsCell();
    expect(container.get()).toHaveLength(2);
    const minted: Cell<unknown>[] = [container];
    if (element) {
      const first = container.key(0).resolveAsCell();
      expect(first.get()).toEqual({ element: 1 });
      minted.push(first);
    }
    return minted.map((cell) => {
      const backLink = getMetaLink(cell, "result");
      expect(backLink?.id).toBe(id);
      return backLink?.schema;
    });
  }

  /**
   * The schemas a piece's result cell can be started with: the pattern's
   * result schema, none, or another.
   */
  const starts = [
    { name: "with the result schema", schema: resultSchema },
    { name: "bare", schema: undefined },
    { name: "with another schema", schema: { type: "object" } as const },
  ];

  /**
   * Registers one case per start, each expecting the cells `apply` mints to
   * link back to the piece running it under the pattern's result schema. The
   * expected schema is the one on the back-link the runner writes into the
   * piece's argument cell, which it derives from the pattern's result
   * schema. `element` says whether the container holds the result cells the
   * builtin minted, whose own back-links are then checked too.
   */
  function itWritesCanonicalBackLinks(
    apply: Apply,
    { element }: { element: boolean },
  ): void {
    for (const { name, schema } of starts) {
      it(`writes back-links under the pattern's result schema when started on a result cell ${name}`, async () => {
        const result = await runListBuiltin(name, apply, schema);
        expect(result.schema).toEqual(schema);
        const argument = getMetaLink(result, "argument");
        expect(argument).toBeDefined();
        const expected = getMetaLink(
          runtime.getCellFromLink(argument!),
          "result",
        )?.schema;
        expect(expected).toBeDefined();
        expect(backLinkSchemas(result, element)).toEqual(
          element ? [expected, expected] : [expected],
        );
      });
    }
  }

  describe("map", () => {
    itWritesCanonicalBackLinks((values, op) =>
      // deno-lint-ignore no-explicit-any
      values.mapWithPattern(op as any, {}), { element: true });
  });

  describe("filter", () => {
    // A filter's container links to the elements it keeps rather than to the
    // result cells its predicate runs write, so the container is the one cell
    // here a case can reach.

    itWritesCanonicalBackLinks((values, op) =>
      // deno-lint-ignore no-explicit-any
      values.filterWithPattern(op as any, {}), { element: false });
  });

  describe("flatMap", () => {
    itWritesCanonicalBackLinks((values, op) =>
      // deno-lint-ignore no-explicit-any
      values.flatMapWithPattern(op as any, {}), { element: true });
  });
});
