/**
 * Type-level tests pinning what a serialized node's bindings can hold.
 *
 * If any assertion here is wrong, this file fails to compile.
 *
 * `Node.inputs` / `Node.outputs` and `Pattern.result` hold what
 * `withAliasBindings()` produces: a structure of `$alias` records and data
 * whose leaves include `FabricPrimitive`s. `JSONValue` cannot express a
 * `FabricPrimitive` — it is a class instance with zero enumerable own
 * properties — so declaring these fields `JSONValue` was false, and was held
 * up by `as unknown as JSONValue` casts at the producing end.
 *
 * The negative assertions are the point. A positive assertion alone would pass
 * just as well against the old `JSONValue` typing for the plain-data cases,
 * proving nothing about the change; each `@ts-expect-error` below fails to
 * compile if `JSONValue` ever does accept these, which is what makes this a
 * differential rather than a restatement.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import type { FabricExecValue, JSONValue, Node } from "../src/builder/types.ts";

describe("serialized node binding typing", () => {
  it("admits a FabricPrimitive where JSONValue cannot", () => {
    const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));

    // The honest type accepts it, bare and nested.
    const bare: FabricExecValue = bytes;
    const nested: FabricExecValue = { blob: bytes, list: [bytes] };

    // ...and `JSONValue` does not, which is what the old declaration claimed.
    // @ts-expect-error a `FabricPrimitive` is not expressible as `JSONValue`
    const _bareAsJson: JSONValue = bytes;
    // @ts-expect-error ...nor is one nested inside a container
    const _nestedAsJson: JSONValue = { blob: bytes };

    // Assert assignability rather than mutate: these values are frozen-ish
    // `FabricValue`s, and the declarations above are the actual test.
    expect(bare).toBeInstanceOf(FabricBytes);
    expect((nested as { blob: unknown }).blob).toBeInstanceOf(FabricBytes);
  });

  it("types a node's bindings as execution values", () => {
    const node: Pick<Node, "inputs" | "outputs"> = {
      inputs: { $alias: { cell: "argument", path: [] } } as FabricExecValue,
      outputs: { blob: new FabricBytes(new Uint8Array([4, 5])) },
    };

    expect((node.outputs as { blob: unknown }).blob).toBeInstanceOf(
      FabricBytes,
    );
  });
});
