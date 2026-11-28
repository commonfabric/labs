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
import { describe, it } from "@commonfabric/test-support/test";

async function transformWithDiagnostics(
  body: string,
): Promise<{ root: ts.SourceFile; diagnostics: TransformationDiagnostic[] }> {
  const diagnostics: TransformationDiagnostic[] = [];
  const output = await transformSource(
    `/// <cts-enable />
import { pattern, UI } from "commonfabric";
${body}`,
    { types: COMMONFABRIC_TYPES, pipelineDiagnostics: diagnostics },
  );
  return { root: parseModule(output), diagnostics };
}

async function transform(body: string): Promise<ts.SourceFile> {
  const { root, diagnostics } = await transformWithDiagnostics(body);
  expect(diagnostics).toEqual([]);
  return root;
}

/** The callback handed to the module's single `pattern(...)` call. */
function patternCallback(root: ts.SourceFile): ts.ArrowFunction {
  const [call] = collect(
    root,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) && node.expression.getText(root) === "pattern",
  );
  const callback = call?.arguments[0];
  if (!callback || !ts.isArrowFunction(callback)) {
    throw new Error("Expected an arrow callback passed to pattern()");
  }
  return callback;
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

    it("keeps an identifier input parameter and reads its fields by key", async () => {
      const root = await transform(`
interface S { count: number; label: string }
export default pattern<S>((input) => {
  return { count: input.count, label: input.label };
});`);

      const callback = patternCallback(root);
      expect(callback.parameters.map((param) => param.name.getText(root)))
        .toEqual(["input"]);
      expect(callback.body.getText(root)).toContain(
        `{ count: input.key("count"), label: input.key("label") }`,
      );
    });

    it("reports rest destructuring and leaves the callback unrewritten", async () => {
      const { root, diagnostics } = await transformWithDiagnostics(`
interface S { count: number; label: string }
export default pattern<S>(({ count, ...rest }) => {
  return { count, rest };
});`);

      expect(diagnostics.map(({ type, message }) => ({ type, message })))
        .toEqual([{
          type: "pattern-context:computation",
          message:
            "Rest destructuring is not lowerable in pattern context; avoid ...rest in pattern parameters.",
        }]);
      const callback = patternCallback(root);
      expect(callback.parameters.map((param) => param.name.getText(root)))
        .toEqual(["{ count, ...rest }"]);
      expect(callback.body.getText(root)).not.toContain("__cf_pattern_input");
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
