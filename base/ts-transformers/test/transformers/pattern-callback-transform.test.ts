import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import type { TransformationDiagnostic } from "../../src/core/mod.ts";
import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import { transformSource } from "../utils.ts";
import {
  collect,
  extractedCallbackBody,
  parseModule,
  patternSchemas,
} from "../transformed-ast.ts";

async function transform(body: string): Promise<ts.SourceFile> {
  const diagnostics: TransformationDiagnostic[] = [];
  const output = await transformSource(
    `/// <cts-enable />
import { pattern, UI } from "commonfabric";
${body}`,
    { types: COMMONFABRIC_TYPES, pipelineDiagnostics: diagnostics },
  );
  expect(diagnostics).toEqual([]);
  return parseModule(output);
}

/** Each `const name = initializer` directly in `body`, as text. */
function prologue(root: ts.SourceFile, body: ts.Node): string[] {
  if (!ts.isBlock(body)) throw new Error("Expected a block body");
  return body.statements.filter(ts.isVariableStatement).flatMap((statement) =>
    statement.declarationList.declarations.map((declaration) =>
      `${declaration.name.getText(root)} = ${
        declaration.initializer?.getText(root)
      }`
    )
  );
}

describe("pattern-callback-transform", () => {
  describe("transformPatternCallback()", () => {
    it("rebinds a destructured function-expression callback's input with a key-read prologue", async () => {
      const root = await transform(`
interface S { count: number; label: string }
export default pattern<S>(function ({ count, label }) {
  return { count, label };
});`);

      const callback = collect(root, ts.isFunctionExpression).find((fn) =>
        fn.parameters[0]?.name.getText(root) === "__cf_pattern_input"
      );
      if (!callback) {
        throw new Error("Expected a rebound function-expression callback");
      }
      expect(prologue(root, callback.body)).toEqual([
        `count = __cf_pattern_input.key("count")`,
        `label = __cf_pattern_input.key("label")`,
      ]);
    });

    it("reads a plain capture by property access and an element field by key path in a map callback", async () => {
      // `plain` is an ordinary local, so the map callback reads it straight
      // off its params; the destructured element field `name` is reactive and
      // read through `.key(...)`.
      const root = await transform(`
interface Item { name: string }
interface S { items: Item[] }
export default pattern<S>(({ items }) => {
  const plain = 3;
  return {
    [UI]: <div>{items.map(({ name }) => <span>{plain}{name}</span>)}</div>,
  };
});`);

      expect(prologue(root, extractedCallbackBody(root, "__cfPattern_1")))
        .toEqual([
          `name = __cf_pattern_input.key("element", "name")`,
          "plain = __cf_pattern_input.params.plain",
        ]);
    });

    it("carries a static destructuring default into the input schema", async () => {
      const root = await transform(`
interface S { count?: number; label: string }
export default pattern<S>(({ count = 5, label }) => {
  return { count, label };
});`);

      const { input } = patternSchemas(root);
      expect(input.properties).toEqual({
        count: { type: ["number", "undefined"], default: 5 },
        label: { type: "string" },
      });
    });
  });
});
