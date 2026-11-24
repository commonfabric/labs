import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import type { TransformationDiagnostic } from "../../../src/core/mod.ts";
import { COMMONFABRIC_TYPES } from "../../commonfabric-test-types.ts";
import { transformSource } from "../../utils.ts";
import {
  callsNamed,
  extractedCallbackBody,
  parseModule,
} from "../../transformed-ast.ts";

/** Transforms a pattern over `items` whose body binds `result` to `call`. */
async function transform(call: string): Promise<ts.SourceFile> {
  const diagnostics: TransformationDiagnostic[] = [];
  const output = await transformSource(
    `/// <cts-enable />
import { pattern } from "commonfabric";
interface Item { name: string; kind: string }
export default pattern<{ items: Item[]; ctx: number }>(({ items, ctx }) => {
  const result = ${call};
  return { result };
});`,
    { types: COMMONFABRIC_TYPES, pipelineDiagnostics: diagnostics },
  );
  expect(diagnostics).toEqual([]);
  return parseModule(output);
}

describe("array-method-transform", () => {
  describe("transformArrayMethodCallback()", () => {
    it("passes a `map` call's second argument through to `mapWithPattern`", async () => {
      const root = await transform("items.map((item) => item.name, ctx)");

      const [call] = callsNamed(root, "mapWithPattern");
      expect(call?.arguments.map((arg) => arg.getText(root))).toEqual([
        "__cfPattern_1",
        "{}",
        "ctx",
      ]);
    });

    it("appends a tagged `undefined` return to a selector body that ends without one", async () => {
      const root = await transform(`items.keyBy((item) => {
    item.kind;
  })`);

      const selector = extractedCallbackBody(root, "__cfPattern_1");
      if (!ts.isBlock(selector)) throw new Error("Expected a block body");
      expect(selector.statements.at(-1)?.getText(root)).toBe(
        "return __cfHelpers.tagCollectionKey(void 0);",
      );
    });
  });
});
