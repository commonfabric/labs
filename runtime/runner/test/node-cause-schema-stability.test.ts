/**
 * The ids a node mints do not move when a schema around it changes.
 *
 * A node's bound inputs carry links annotated with the schema the node reads
 * through, and its cause is built from those same inputs. Only the addresses
 * are causal, so `causalFormOfBinding()` reduces the links on the way into the
 * cause. What that buys is checked here end to end: the same pattern under a
 * widened argument schema anchors its array elements at the same entity ids,
 * so a piece that gains an optional field keeps the documents it had.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createBuilder } from "../src/builder/factory.ts";
import { type JSONSchema } from "../src/builder/types.ts";
import { getMetaCell, parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

/**
 * The element schema, and the same one with an optional field added. Widening
 * is the change a piece actually undergoes between pattern versions, and it
 * leaves every existing element valid -- so nothing about the elements written
 * below has moved.
 */
const narrowElement = {
  type: "object",
  properties: { label: { type: "string" } },
  required: ["label"],
} as const satisfies JSONSchema;

const widerElement = {
  type: "object",
  properties: { label: { type: "string" }, note: { type: "string" } },
  required: ["label"],
} as const satisfies JSONSchema;

describe("node-cause-schema-stability", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commonfabric"]["lift"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    ({ lift, pattern } = createTrustedBuilder(runtime).commonfabric);
  });

  async function commitTx() {
    if (tx.status().status !== "ready") return;
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
  }

  afterEach(async () => {
    await commitTx();
    await runtime?.dispose();
    await storageManager?.close();
  });

  /**
   * Runs a pattern whose lift writes two objects into a writable array, and
   * returns the entity id each element was anchored at. Writing objects into
   * an array is what routes through `anchorValueAsEntity`, whose derivation
   * folds in the frame cause -- the bound inputs of the lift doing the write.
   */
  async function anchoredIds(element: JSONSchema): Promise<string[]> {
    const argumentSchema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: element,
          default: [],
          asCell: ["cell"],
        },
      },
      required: ["items"],
    } as const satisfies JSONSchema;

    // The lift takes the array as a writable cell, which is what routes its
    // write through the frame -- and so through the cause under test.
    const seed = lift(
      // deno-lint-ignore no-explicit-any
      (state: any) => {
        state.items.set([{ label: "first" }, { label: "second" }]);
        return null;
      },
      argumentSchema,
    );

    const seeder = pattern(
      // deno-lint-ignore no-explicit-any
      ({ items }: any) => ({ seeded: seed({ items }) }),
      argumentSchema,
      { type: "object" } as const satisfies JSONSchema,
    );

    // A fixed cause, so the result cell is the same document across both runs
    // and only the schema differs between them.
    const resultCell = runtime.getCell(space, "seeder result", undefined, tx);
    const result = runtime.run(tx, seeder, {}, resultCell);
    await commitTx();
    tx = runtime.edit();
    await result.pull();

    // Read the argument's stored array RAW: each element is a link to the
    // document it was anchored at, and resolving them would read through to
    // the contents instead.
    const items = getMetaCell(resultCell, "argument", tx).key("items");
    const stored = items.getRaw() as unknown[] | undefined;
    return (stored ?? []).map((entry) => parseLink(entry)?.id ?? "unlinked");
  }

  it("anchors array elements at the same ids under a widened element schema", async () => {
    const narrow = await anchoredIds(narrowElement);
    const wider = await anchoredIds(widerElement);

    // Both runs actually anchored -- otherwise two empty lists would compare
    // equal and the test would pass having checked nothing.
    expect(narrow).toHaveLength(2);
    expect(narrow.every((id) => id.startsWith("of:"))).toBe(true);

    expect(wider).toEqual(narrow);
  });
});
