import { expect } from "@std/expect";
import ts from "typescript";

import { transformCfDirective } from "../../src/mod.ts";
import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import { callsNamed, collect, parseModule } from "../transformed-ast.ts";
import { validateSource } from "../utils.ts";
import { describe, it } from "@commonfabric/test-support/test";

const HEAD = `/// <cts-enable />
import { ifElse, pattern, UI, wish } from "commonfabric";
`;

/**
 * Compiles `body` under `HEAD` and returns the parsed output together with
 * every diagnostic, each with the source text of the node it is reported on.
 */
async function compile(body: string) {
  const source = HEAD + body;
  const { diagnostics, output } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });
  const compiled = transformCfDirective(source);
  return {
    output: parseModule(output),
    diagnostics: diagnostics.map(({ type, message, start, length }) => ({
      type,
      message,
      text: compiled.slice(start, start + length),
    })),
  };
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

/** Whether `expression` is `<root>.key("<segment>")`. */
function isKeyRead(
  expression: ts.Expression,
  root: string,
  segment: string,
): boolean {
  return ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "key" &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === root &&
    expression.arguments.length === 1 &&
    ts.isStringLiteral(expression.arguments[0]!) &&
    expression.arguments[0].text === segment;
}

describe("pattern-body-reactive-root-lowering", () => {
  describe("receiver-method calls in a reactive collection callback", () => {
    it("reports `pattern-context:receiver-method-call` for a method call inside a helper", async () => {
      // The `ifElse` branch sits in the callback of a reactive `.map()`, so
      // the method call on the element's field has no site that lowers it.
      const { diagnostics } = await compile(`
interface Item { name: string; tags: string[] }
interface Input { items: Item[]; flag: boolean; }
export default pattern<Input>(({ items, flag }) => {
  const out = items.map((item) => ifElse(flag, item.name.toUpperCase(), "x"));
  return { out };
});`);

      expect(
        diagnostics.filter((d) =>
          d.type === "pattern-context:receiver-method-call"
        ),
      ).toEqual([{
        type: "pattern-context:receiver-method-call",
        message: "Method calls on opaque pattern values are not lowerable. " +
          "Move this call into computed().",
        text: "item.name.toUpperCase()",
      }]);
    });

    it("names the handler remedy for a write method spelled with a string key", async () => {
      const { diagnostics } = await compile(`
interface Item { name: string; tags: string[] }
interface Input { items: Item[]; flag: boolean; }
export default pattern<Input>(({ items, flag }) => {
  const out = items.map((item) => ifElse(flag, item.tags["push"]("x"), 0));
  return { out };
});`);

      expect(
        diagnostics.filter((d) =>
          d.type === "pattern-context:receiver-method-call"
        ),
      ).toEqual([{
        type: "pattern-context:receiver-method-call",
        message: "Method calls on opaque pattern values are not lowerable. " +
          "Writes to pattern inputs must go through a module-scope " +
          "handler<> (typed Writable<T>), not the pattern body, which runs " +
          "once at construction.",
        text: 'item.tags["push"]("x")',
      }]);
    });

    it("reports nothing for the same method call outside a helper", async () => {
      // Without the `ifElse` boundary the callback's own return site lowers
      // the call, so it is supported.
      const { diagnostics } = await compile(`
interface Item { name: string; tags: string[] }
interface Input { items: Item[]; flag: boolean; }
export default pattern<Input>(({ items }) => {
  const out = items.map((item) => item.name.toUpperCase());
  return { out };
});`);

      expect(
        diagnostics.filter((d) =>
          d.type === "pattern-context:receiver-method-call"
        ),
      ).toEqual([]);
    });
  });

  describe("method calls on a pattern input", () => {
    it("reports a write method named by a string key as a computation error", async () => {
      // The element-access spelling is the same method call as
      // `user.tags.push("y")`, not a read of a `push` field.
      const { output, diagnostics } = await compile(`
interface User { tags: string[] }
interface Input { user: User }
export default pattern<Input>(({ user }) => {
  user.tags["push"]("y");
  return { done: true };
});`);

      expect(diagnostics).toEqual([{
        type: "pattern-context:computation",
        message: "Method calls on opaque pattern values are not lowerable. " +
          "Writes to pattern inputs must go through a module-scope " +
          "handler<> (typed Writable<T>), not the pattern body, which runs " +
          "once at construction.",
        text: 'user.tags["push"]',
      }]);
      // No key read names `push` as a path segment.
      const pushSegments = collect(output, ts.isStringLiteral).filter((
        literal,
      ) => literal.text === "push");
      expect(pushSegments.length).toBe(1);
      expect(ts.isElementAccessExpression(pushSegments[0]!.parent)).toBe(true);
    });
  });

  describe("block scopes", () => {
    it("lowers an input read again after a block that shadowed it", async () => {
      // Inside the block `user` names a plain local object, so its read stays
      // a property access; after the block `user` is the pattern input again.
      const { output, diagnostics } = await compile(`
interface User { name: string }
interface Input { user: User }
export default pattern<Input>(({ user }) => {
  {
    const user = { name: "x" };
    const inner = user.name;
  }
  const outer = user.name;
  return { outer };
});`);

      expect(diagnostics).toEqual([]);
      const inner = initializerOf(output, "inner");
      expect(ts.isPropertyAccessExpression(inner)).toBe(true);
      expect(isKeyRead(initializerOf(output, "outer"), "user", "name")).toBe(
        true,
      );
    });
  });

  describe("one-line reads off a reactive-origin call", () => {
    it("lowers a string-keyed element access to a key read", async () => {
      const { output, diagnostics } = await compile(`
interface R { result: { x: number } }
export default pattern<Record<string, never>>(() => {
  const a = wish<R>({ query: "#a" })["result"];
  return { a };
});`);

      expect(diagnostics).toEqual([]);
      // `a` becomes `<root>.key("result").for("a", true)` over a fresh
      // binding of the `wish(...)` call.
      const a = initializerOf(output, "a");
      if (
        !ts.isCallExpression(a) || !ts.isPropertyAccessExpression(a.expression)
      ) {
        throw new Error("expected a .for() call");
      }
      expect(a.expression.name.text).toBe("for");
      const read = a.expression.expression;
      if (
        !ts.isCallExpression(read) ||
        !ts.isPropertyAccessExpression(read.expression)
      ) {
        throw new Error("expected a .key() call");
      }
      const root = read.expression.expression;
      if (!ts.isIdentifier(root)) throw new Error("expected an identifier");
      expect(isKeyRead(read, root.text, "result")).toBe(true);
      expect(callsNamed(initializerOf(output, root.text), "wish").length)
        .toBe(1);
    });

    it("lowers a numeric element access to a key read", async () => {
      const { output, diagnostics } = await compile(`
export default pattern<Record<string, never>>(() => {
  const first = wish<number[]>({ query: "#list" })[0];
  return { first };
});`);

      expect(diagnostics).toEqual([]);
      const first = initializerOf(output, "first");
      const reads = collect(first, ts.isCallExpression).filter((call) =>
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === "key"
      );
      expect(reads.length).toBe(1);
      const argument = reads[0]!.arguments[0]!;
      expect(ts.isStringLiteral(argument) && argument.text).toBe("0");
    });

    it("looks through parentheses and a non-null assertion on the call", async () => {
      const { output, diagnostics } = await compile(`
interface R { result: { x: number } }
export default pattern<Record<string, never>>(() => {
  const parenthesized = (wish<R>({ query: "#a" })).result;
  const asserted = wish<R>({ query: "#b" })!.result;
  return { parenthesized, asserted };
});`);

      expect(diagnostics).toEqual([]);
      for (const name of ["parenthesized", "asserted"]) {
        const reads = collect(initializerOf(output, name), ts.isCallExpression)
          .filter((call) =>
            ts.isPropertyAccessExpression(call.expression) &&
            call.expression.name.text === "key"
          );
        expect(reads).toHaveLength(1);
        const argument = reads[0]!.arguments[0]!;
        expect(ts.isStringLiteral(argument) && argument.text).toBe("result");
      }
    });

    it("leaves a declaration without an initializer untouched", async () => {
      const { output, diagnostics } = await compile(`
export default pattern<Record<string, never>>(() => {
  let pending;
  return { done: true };
});`);

      expect(diagnostics.map((d) => d.type)).toEqual([
        "pattern-context:let-declaration",
      ]);
      const pending = collect(output, ts.isVariableDeclaration).find((node) =>
        ts.isIdentifier(node.name) && node.name.text === "pending"
      );
      expect(pending?.initializer).toBeUndefined();
    });
  });
});
