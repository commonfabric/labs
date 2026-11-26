import { expect } from "@std/expect";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import { callsNamed, collect, parseModule } from "../transformed-ast.ts";
import { transformSource } from "../utils.ts";
import { describe, it } from "@commonfabric/test-support/test";

const HEAD = `/// <cts-enable />
import { pattern, Writable } from "commonfabric";
`;

async function compile(
  body: string,
  options: { instanceNames?: boolean } = {},
) {
  return parseModule(
    await transformSource(HEAD + body, {
      types: COMMONFABRIC_TYPES,
      ...options,
    }),
  );
}

/** The initializer the output gives the variable named `name`. */
function initializerOf(root: ts.Node, name: string): ts.Expression {
  const declaration = collect(root, ts.isVariableDeclaration).find((node) =>
    ts.isIdentifier(node.name) && node.name.text === name
  );
  if (!declaration?.initializer) {
    throw new Error(`no initialized declaration of ${name}`);
  }
  return declaration.initializer;
}

/** The first argument of every `.for(...)` call under `root`, as text. */
function forCauseTexts(root: ts.Node): string[] {
  return collect(root, ts.isCallExpression)
    .filter((call) =>
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === "for"
    )
    .map((call) => {
      const cause = call.arguments[0]!;
      return ts.isArrayLiteralExpression(cause)
        ? cause.elements.map((e) => ts.isStringLiteral(e) ? e.text : "?")
          .join(".")
        : ts.isStringLiteral(cause)
        ? cause.text
        : "?";
    });
}

describe("reactive-variable-for", () => {
  describe("object literal properties", () => {
    it("gives no cause to a cell under a bigint property name", async () => {
      // Only names that read as a stable string join the cause path; the
      // bigint-named sibling is left alone while `a` gets `obj.a`.
      const output = await compile(`
export default pattern<Record<string, never>>(() => {
  const obj = { 1n: Writable.of(0), a: Writable.of(1) };
  return { obj };
});`);

      expect(forCauseTexts(initializerOf(output, "obj"))).toEqual(["obj.a"]);
    });
  });

  describe("sub-pattern instance names", () => {
    // `registry.for(...)` hands back a set of pattern factories, so `reg`
    // and `regKeyed` are instances whose chain carries an authored `.for()`.
    const source = `
const Child = pattern<{ value: number }>(() => ({ value: Writable.of(1) }));
declare const registry: { for(name: string): { Child: typeof Child } };
export default pattern<Record<string, never>>(() => {
  const named = Child({ value: 1 });
  const reg = registry.for("x").Child({ value: 2 });
  const regKeyed = registry["for"]("y").Child({ value: 3 });
  return { named, reg, regKeyed };
});`;

    it("names an instance that has no authored cause", async () => {
      const output = await compile(source, { instanceNames: true });

      const named = initializerOf(output, "named");
      expect(ts.isCallExpression(named) && callsNamed(named, "nameInstance"))
        .toHaveLength(1);
    });

    it("names no instance whose chain carries an authored `.for()`", async () => {
      // The `.for()` cause outranks an instance name, in either spelling of
      // the method.
      const output = await compile(source, { instanceNames: true });

      expect(callsNamed(initializerOf(output, "reg"), "nameInstance"))
        .toEqual([]);
      expect(callsNamed(initializerOf(output, "regKeyed"), "nameInstance"))
        .toEqual([]);
    });
  });
});
