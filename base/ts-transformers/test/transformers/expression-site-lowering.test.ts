import { expect } from "@std/expect";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import {
  calleeName,
  callsMatching,
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

/** True for a `__cfLift_N(...)` call, with or without a `.for(cause, true)`. */
function isLift(expression: ts.Expression | undefined): boolean {
  if (!expression || !ts.isCallExpression(expression)) return false;
  const callee = expression.expression;
  const lift = ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "for" && ts.isCallExpression(callee.expression)
    ? callee.expression
    : expression;
  return /^__cfLift/.test(calleeName(lift) ?? "");
}

function transform(source: string): Promise<string> {
  return transformSource(source, { types: COMMONFABRIC_TYPES });
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

  it("leaves a `.get()` on a receiver that is not reactive as a plain call", async () => {
    // Inside the function only `count` and `local` are reactive: a cell the
    // pattern body creates is a data flow like an input cell. The `Map` read
    // has no data flow to lift over, so it stays as written; lifting it would
    // make the `Map` a lift input, which is not serializable.
    const output = parseModule(
      await transform(`/// <cts-enable />
import { pattern, UI, Writable } from "commonfabric";
interface Input { count: Writable<number> }
export default pattern<Input>(({ count }) => {
  const local = Writable.of(0);
  return {
    [UI]: (
      <div>
        {(() => {
          const m = new Map<string, number>([["a", 1]]);
          const v = m.get("a");
          const c = count.get();
          const l = local.get();
          return <i>{v}{c}{l}</i>;
        })()}
      </div>
    ),
  };
});`),
    );

    const v = initializerOf(output, "v");
    expect(
      ts.isCallExpression(v) && ts.isPropertyAccessExpression(v.expression) &&
        ts.isIdentifier(v.expression.expression) &&
        v.expression.expression.text === "m" &&
        v.expression.name.text === "get",
    ).toBe(true);
    expect(isLift(initializerOf(output, "c"))).toBe(true);
    expect(isLift(initializerOf(output, "l"))).toBe(true);
  });

  describe("passthrough containers of element reads in a collection callback", () => {
    const source = (body: string) =>
      `/// <cts-enable />
import { pattern, UI } from "commonfabric";
interface Item { name: string; tags: string[] }
interface Input { items: Item[]; label: string }
export default pattern<Input>(({ items, label }) => ({
  [UI]: (
    <div>
      {items.map((it) => {
        let j = 0;
        j = j + 1;
        ${body}
      })}
    </div>
  ),
}));`;

    it("keeps an array literal of element reads and lifts the computed read inside it", async () => {
      const body = extractedCallbackBody(
        parseModule(
          await transform(source(`const a = [it.tags[j], it.name];
        return <b>{a}</b>;`)),
        ),
        "__cfPattern_1",
      );
      const a = initializerOf(body, "a");
      if (!ts.isArrayLiteralExpression(a)) {
        throw new Error("expected the array literal to survive");
      }
      expect(a.elements).toHaveLength(2);
      // The dynamic index read is lifted on its own; the static field read is
      // a plain path read on the element.
      expect(isLift(a.elements[0])).toBe(true);
      const [, name] = a.elements;
      expect(
        !!name && ts.isCallExpression(name) && calleeName(name) === "key",
      ).toBe(true);
    });

    it("lifts the whole literal when it also reads a value from outside the element", async () => {
      const body = extractedCallbackBody(
        parseModule(
          await transform(source(`const a = [it.tags[j], label];
        return <b>{a}</b>;`)),
        ),
        "__cfPattern_1",
      );
      expect(isLift(initializerOf(body, "a"))).toBe(true);
    });

    it("leaves a read with no reactive input as written", async () => {
      const body = extractedCallbackBody(
        parseModule(
          await transform(source(`const arr = ["x", "y"];
        return <b>{arr[j]}</b>;`)),
        ),
        "__cfPattern_1",
      );
      const reads = collect(body, ts.isJsxExpression).map((node) =>
        node.expression
      );
      expect(reads).toHaveLength(1);
      const [read] = reads;
      expect(
        !!read && ts.isElementAccessExpression(read) &&
          ts.isIdentifier(read.expression) && read.expression.text === "arr",
      ).toBe(true);
      expect(callsMatching(body, /^__cfLift/)).toHaveLength(0);
    });
  });

  it('treats `.key()` and `["key"]()` element reads alike', async () => {
    // Both spellings name the same path read on the element, so both keep
    // the array literal and lift only the dynamic index read inside it.
    const output = parseModule(
      await transform(`/// <cts-enable />
import { pattern, UI, Writable } from "commonfabric";
interface Item { tags: string[] }
interface Input { items: Writable<Item>[] }
export default pattern<Input>(({ items }) => ({
  [UI]: (
    <div>
      {items.map((it) => {
        let j = 0;
        j = j + 1;
        const dotted = [it.key("tags")[j]];
        const bracketed = [it["key"]("tags")[j]];
        return <b>{dotted}{bracketed}</b>;
      })}
    </div>
  ),
}));`),
    );
    const body = extractedCallbackBody(output, "__cfPattern_1");
    for (const name of ["dotted", "bracketed"]) {
      const literal = initializerOf(body, name);
      if (!ts.isArrayLiteralExpression(literal)) {
        throw new Error(`expected ${name} to stay an array literal`);
      }
      expect(literal.elements).toHaveLength(1);
      expect(isLift(literal.elements[0])).toBe(true);
    }
  });

  it("lowers an array method used as a statement in place", async () => {
    // The statement's map is lowered to its reactive form where it stands;
    // a statement that is not an array method is lifted as a whole.
    const output = parseModule(
      await transform(`/// <cts-enable />
import { pattern, UI } from "commonfabric";
interface Item { name: string; tags: string[] }
interface Input { items: Item[] }
export default pattern<Input>(({ items }) => ({
  [UI]: (
    <div>
      {items.map((it) => {
        it.tags.map((t) => t + "!");
        console.log(it.name);
        return <b>{it.name}</b>;
      })}
    </div>
  ),
}));`),
    );
    const body = extractedCallbackBody(output, "__cfPattern_2");
    if (!ts.isBlock(body)) throw new Error("expected a block body");
    const statements = body.statements
      .filter(ts.isExpressionStatement)
      .map((statement) => statement.expression);
    expect(statements).toHaveLength(2);
    const [mapped, logged] = statements;
    expect(
      !!mapped && ts.isCallExpression(mapped) &&
        calleeName(mapped) === "mapWithPattern",
    ).toBe(true);
    expect(isLift(logged)).toBe(true);
  });
});
