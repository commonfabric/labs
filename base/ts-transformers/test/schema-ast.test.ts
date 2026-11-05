import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import ts from "typescript";

import { createSchemaAst } from "../src/transformers/schema-generator.ts";

Deno.test("schema AST preserves __proto__ as an own data property", async () => {
  const schema = {
    kind: "pattern",
    argumentSchema: {
      type: "object",
      properties: {
        ["__proto__"]: { type: "string" },
      },
    },
    resultSchema: true,
  };
  const expression = createSchemaAst(schema, ts.factory);
  const sourceFile = ts.createSourceFile(
    "/schema.ts",
    "",
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const printed = ts.createPrinter().printNode(
    ts.EmitHint.Expression,
    expression,
    sourceFile,
  );
  assertStringIncludes(printed, '["__proto__"]');

  const moduleUrl = "data:text/javascript;charset=utf-8," +
    encodeURIComponent(`export default (${printed});`);
  const imported = await import(moduleUrl);
  const emitted = imported.default as {
    argumentSchema: { properties: Record<string, unknown> };
  };
  const properties = emitted.argumentSchema.properties;

  assert(Object.hasOwn(properties, "__proto__"));
  assertEquals(properties.__proto__, { type: "string" });
  assertEquals(Object.getPrototypeOf(properties), Object.prototype);
});
