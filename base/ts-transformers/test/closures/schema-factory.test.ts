import { expect } from "@std/expect";
import ts from "typescript";

import type { TransformationDiagnostic } from "../../src/core/mod.ts";
import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import { transformSource } from "../utils.ts";
import { callSchemas, callsNamed, parseModule } from "../transformed-ast.ts";
import { describe, it } from "@commonfabric/test-support/test";

async function transform(source: string): Promise<ts.SourceFile> {
  const diagnostics: TransformationDiagnostic[] = [];
  const output = await transformSource(`/// <cts-enable />\n${source}`, {
    types: COMMONFABRIC_TYPES,
    pipelineDiagnostics: diagnostics,
  });
  expect(diagnostics).toEqual([]);
  return parseModule(output);
}

/** The property names of the object literal `name` is applied to. */
function appliedKeys(root: ts.SourceFile, name: string): string[] {
  const input = callsNamed(root, name)[0]?.arguments[0];
  if (!input || !ts.isObjectLiteralExpression(input)) {
    throw new Error(`Expected ${name}({ ... })`);
  }
  return input.properties.map((property) => {
    if (!property.name || !ts.isIdentifier(property.name)) {
      throw new Error("Expected an identifier-named property");
    }
    return property.name.text;
  });
}

describe("schema-factory", () => {
  describe("createHandlerStateSchema()", () => {
    it("describes only the captures a JSX handler is applied to", async () => {
      const root = await transform(
        `import { pattern, UI, Writable } from "commonfabric";
export default pattern<{ count: Writable<number>; label: string }>(
  ({ count, label }) => ({
    [UI]: (
      <button type="button" onClick={() => count.set(1)}>
        {label}
      </button>
    ),
  }),
);`,
      );

      expect(appliedKeys(root, "__cfHandler_1")).toEqual(["count"]);
      expect(callSchemas(root, "handler")[1]).toEqual({
        type: "object",
        properties: { count: { type: "number", asCell: ["writeonly"] } },
        required: ["count"],
      });
    });
  });

  describe("createLiftAppliedInputSchema()", () => {
    /**
     * The input schema of a lift applied to `s.value`, typed `valueType`,
     * whose callback computes `body` from its parameter `v` and a capture.
     */
    async function liftInputSchema(
      valueType: string,
      body = "(v ?? 0) * m",
    ): Promise<unknown> {
      const root = await transform(
        `import { handler, lift, Writable } from "commonfabric";
export const h = handler<{ x: number }, { value${valueType}; out: Writable<number> }>(
  (e, s) => {
    const m = e.x;
    s.out.set(lift((v: number | undefined) => ${body})(s.value));
  },
);`,
      );
      expect(appliedKeys(root, "__cfLift_1")).toEqual(["value", "m"]);
      return callSchemas(root, "lift")[0];
    }

    it("leaves an input read through an optional property out of `required`", async () => {
      expect(await liftInputSchema("?: number")).toEqual({
        type: "object",
        properties: { value: { type: "number" }, m: { type: "number" } },
        required: ["m"],
      });
    });

    it("leaves an optional input out of `required` when the callback reads all of it", async () => {
      // Handing `v` whole to a call leaves no narrower read to shrink the
      // input to, so only the input's own `?` makes it optional.
      const body = "JSON.stringify(v).length * m";
      expect(await liftInputSchema("?: number", body)).toEqual({
        type: "object",
        properties: { value: { type: "number" }, m: { type: "number" } },
        required: ["m"],
      });
      expect(await liftInputSchema(": number | undefined", body)).toEqual({
        type: "object",
        properties: {
          value: { type: ["number", "undefined"] },
          m: { type: "number" },
        },
        required: ["value", "m"],
      });
    });

    it("requires an input read through a required property", async () => {
      expect(await liftInputSchema(": number")).toEqual({
        type: "object",
        properties: { value: { type: "number" }, m: { type: "number" } },
        required: ["value", "m"],
      });
    });
  });
});
