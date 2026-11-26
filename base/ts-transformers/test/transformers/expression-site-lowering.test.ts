import { expect } from "@std/expect";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import {
  calleeName,
  collect,
  extractedCallbackBody,
  iifeCalls,
  parseModule,
} from "../transformed-ast.ts";
import { transformSource } from "../utils.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** The initializer the output gives the variable named `name` under `root`. */
function initializerOf(root: ts.Node, name: string): ts.Expression {
  const declaration = collect(root, ts.isVariableDeclaration).find((node) =>
    ts.isIdentifier(node.name) && node.name.text === name
  );
  if (!declaration?.initializer) {
    throw new Error(`no initialized declaration of ${name}`);
  }
  return declaration.initializer;
}

describe("expression-site-lowering", () => {
  describe("cell reads in an immediately invoked function", () => {
    it("lifts a `.get()` initializer inside a reactive collection callback", async () => {
      // The function runs once per element as part of the element's pattern,
      // so the read is lifted over the element rather than read once.
      const output = parseModule(
        await transformSource(
          `/// <cts-enable />
import { pattern, UI, Writable } from "commonfabric";
interface Input { items: Writable<number>[] }
export default pattern<Input>(({ items }) => ({
  [UI]: (
    <div>
      {items.map((it) => (() => {
        const c = it.get();
        return <b>{c}</b>;
      })())}
    </div>
  ),
}));`,
          { types: COMMONFABRIC_TYPES },
        ),
      );

      const body = extractedCallbackBody(output, "__cfPattern_1");
      expect(iifeCalls(body)).toHaveLength(1);
      // `c` is `__cfLift_N({ it }).for("c", true)`.
      const c = initializerOf(body, "c");
      if (
        !ts.isCallExpression(c) || !ts.isPropertyAccessExpression(c.expression)
      ) {
        throw new Error("expected a .for() call");
      }
      const lifted = c.expression.expression;
      expect(ts.isCallExpression(lifted) && calleeName(lifted)).toMatch(
        /^__cfLift/,
      );
      expect(
        collect(body, ts.isCallExpression).some((call) =>
          ts.isPropertyAccessExpression(call.expression) &&
          call.expression.name.text === "get"
        ),
      ).toBe(false);
    });
  });
});
