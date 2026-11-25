/**
 * Compiles patterns whose render body holds one expression of each kind an
 * expression emitter handles, through the whole pipeline, and inspects what
 * the emitter left at the site and what it lifted.
 */
import { expect } from "@std/expect";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "../../commonfabric-test-types.ts";
import { callsNamed, collect, parseModule } from "../../transformed-ast.ts";
import { transformSource } from "../../utils.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** A pattern whose render body holds `jsx`, importing `imports` as well. */
function patternRendering(jsx: string, imports: readonly string[] = []) {
  return `/// <cts-enable />
import { ${
    ["Cell", "lift", "pattern", "UI", "VNode", ...imports].join(", ")
  } } from "commonfabric";
interface Input {
  flag: boolean;
  count: number;
  label: string;
  items: number[];
  index: number;
  base: Cell<number>;
  list: Cell<number[]>;
}
interface Output { [UI]: VNode; }
const plus = (a: number, b: number) => a + b;
export default pattern<Input, Output>(
  ({ flag, count, label, items, index, base, list }) => ({
    [UI]: <div>{${jsx}}</div>,
  }),
);`;
}

/** `source` after the whole pipeline, parsed. */
async function transform(source: string): Promise<ts.SourceFile> {
  return parseModule(
    await transformSource(source, { types: COMMONFABRIC_TYPES }),
  );
}

/** The transformed module of a pattern whose render body holds `jsx`. */
function render(jsx: string): Promise<ts.SourceFile> {
  return transform(patternRendering(jsx));
}

/** `node`, printed on one line. */
function print(node: ts.Node, root: ts.SourceFile): string {
  return ts.createPrinter({ removeComments: true })
    .printNode(ts.EmitHint.Unspecified, node, root)
    .replace(/\s+/g, " ");
}

/** The expression the first `<div>` in `root` holds, printed. */
function rendered(root: ts.SourceFile): string {
  const [div] = collect(root, ts.isJsxElement).filter((element) =>
    element.openingElement.tagName.getText(root) === "div"
  );
  const [child] = div?.children.filter(ts.isJsxExpression) ?? [];
  if (!child?.expression) throw new Error("No expression in a `<div>`.");
  return print(child.expression, root);
}

/** What one `lift` callback binds as inputs, and its body, printed. */
interface Lifted {
  readonly inputs: readonly string[];
  readonly body: string;
}

/** Every `lift` callback in `root`, in source order. */
function lifts(root: ts.SourceFile): Lifted[] {
  return callsNamed(root, "lift").map((call) => {
    const callback = call.arguments[0];
    if (!callback || !ts.isArrowFunction(callback)) {
      throw new Error(`\`${print(call, root)}\` lifts no arrow function.`);
    }
    const [parameter] = callback.parameters;
    const inputs = parameter && ts.isObjectBindingPattern(parameter.name)
      ? parameter.name.elements.map((element) => print(element.name, root))
      : [];
    return { inputs, body: print(callback.body, root) };
  });
}

describe("emitters", () => {
  describe("emitPrefixUnaryExpression()", () => {
    it("lifts a negation of a reactive value over the value it negates", async () => {
      const root = await render("!flag");

      expect(lifts(root)).toEqual([{ inputs: ["flag"], body: "!flag" }]);
      expect(rendered(root)).toBe("__cfLift_1({ flag: flag })");
    });
  });

  describe("emitPropertyAccess()", () => {
    it("lifts a property read off a reactive value", async () => {
      const root = await render("[count].length");

      expect(lifts(root)).toEqual([
        { inputs: ["count"], body: "[count].length" },
      ]);
      expect(rendered(root)).toBe("__cfLift_1({ count: count })");
    });

    it("lifts a method call on a reactive value as a whole, not the method it calls", async () => {
      const root = await render("[count].concat([1])");

      expect(lifts(root)).toEqual([
        { inputs: ["count"], body: "[count].concat([1])" },
      ]);
    });
  });

  describe("emitElementAccessExpression()", () => {
    it("lifts a dynamic index into a reactive value over the value and the index", async () => {
      const root = await render("items[index]");

      expect(lifts(root)).toEqual([
        { inputs: ["items", "index"], body: "items[index]" },
      ]);
      expect(rendered(root)).toBe(
        "__cfLift_1({ items: items, index: index })",
      );
    });

    it("reads a static index as a key of the reactive value", async () => {
      const root = await render("items[0]");

      expect(lifts(root)).toEqual([]);
      expect(rendered(root)).toBe('items.key("0")');
    });
  });

  describe("emitTemplateExpression()", () => {
    it("lifts a template over a reactive value", async () => {
      const root = await render("`${label}!`");

      expect(lifts(root)).toEqual([{ inputs: ["label"], body: "`${label}!`" }]);
      expect(rendered(root)).toBe("__cfLift_1({ label: label })");
    });
  });

  describe("emitConditionalExpression()", () => {
    /** The last three arguments of the `ifElse()` call `root` renders. */
    function ifElseOperands(root: ts.SourceFile): string[] {
      const [call] = callsNamed(root, "ifElse");
      if (!call) throw new Error("No `ifElse()` call.");
      return call.arguments.slice(-3).map((argument) => print(argument, root));
    }

    it("passes a reactive condition and both branches to `ifElse()` as they are", async () => {
      const root = await render("flag ? count : label");

      expect(ifElseOperands(root)).toEqual(["flag", "count", "label"]);
      expect(lifts(root)).toEqual([]);
    });

    it("lifts a condition computed from a reactive value", async () => {
      const root = await render("count > 1 ? count : label");

      expect(ifElseOperands(root)).toEqual([
        "__cfLift_1({ count: count })",
        "count",
        "label",
      ]);
      expect(lifts(root)).toEqual([{ inputs: ["count"], body: "count > 1" }]);
    });
  });

  describe("emitBinaryExpression()", () => {
    it("leaves a fallback over a cell in place as the receiver of a `.map()`", async () => {
      const root = await render("(list ?? []).map((x) => x + 1)");

      expect(rendered(root)).toBe(
        "(list ?? []).mapWithPattern(__cfPattern_1, {})",
      );
      expect(lifts(root)).toEqual([{ inputs: ["x"], body: "x + 1" }]);
    });

    it("lifts a fallback over a call as the receiver of a `.map()`", async () => {
      const root = await render("(list.get() ?? []).map((x) => x + 1)");

      expect(rendered(root)).toBe(
        "(__cfLift_1({ list: list })).mapWithPattern(__cfPattern_1, {})",
      );
      expect(lifts(root)).toEqual([
        { inputs: ["list"], body: "list.get() ?? []" },
        { inputs: ["x"], body: "x + 1" },
      ]);
    });
  });

  describe("emitCallExpression()", () => {
    it("lifts a call over a reactive value", async () => {
      const root = await render("plus(count, 1)");

      expect(lifts(root)).toEqual([
        { inputs: ["count"], body: "plus(count, 1)" },
      ]);
      expect(rendered(root)).toBe("__cfLift_1({ count: count })");
    });

    it("leaves a builder call in place", async () => {
      const root = await render("lift(() => count + 1)");
      const [call] = callsNamed(root, "lift");

      expect(call && print(call, root)).toBe(rendered(root));
      expect(call && print(call.arguments[0]!, root)).toBe("() => count + 1");
    });

    describe("an authored `when()`", () => {
      /** The last two arguments of the `when()` call `root` renders. */
      function whenOperands(root: ts.SourceFile): string[] {
        const [call] = callsNamed(root, "when");
        if (!call) throw new Error("No `when()` call.");
        return call.arguments.slice(-2).map((argument) =>
          print(argument, root)
        );
      }

      it("lifts a value argument computed from a reactive value", async () => {
        const root = await transform(
          patternRendering("when(flag, count + 1)", ["when"]),
        );

        expect(whenOperands(root)).toEqual([
          "flag",
          "__cfLift_1({ count: count })",
        ]);
        expect(lifts(root)).toEqual([{ inputs: ["count"], body: "count + 1" }]);
      });

      it("leaves arguments that need no rewrite as authored", async () => {
        const root = await transform(
          patternRendering("when(flag, 1)", ["when"]),
        );

        expect(whenOperands(root)).toEqual(["flag", "1"]);
        expect(lifts(root)).toEqual([]);
      });
    });

    describe("inputs of a lifted call", () => {
      // The lift binds each name the call reads from the enclosing pattern
      // body as an input, and only those.

      /** The inputs of the one lift around `call` in a pattern body. */
      async function liftInputs(call: string): Promise<readonly string[]> {
        const root = await transform(`/// <cts-enable />
import { pattern, UI, VNode } from "commonfabric";
const { factor } = { factor: 2 };
const plus = (a: number, _b: unknown) => a;
interface Output { [UI]: VNode; }
export default pattern<{ count: number }, Output>(({ count }) => {
  const Badge = () => null;
  const local = 3;
  return { [UI]: <div>{${call}}</div> };
});`);
        const lifted = lifts(root);

        expect(lifted.map(({ body }) => body)).toEqual([call]);
        return lifted[0]!.inputs;
      }

      it("binds a name the enclosing function declares", async () => {
        expect(await liftInputs("plus(count, local)")).toEqual([
          "count",
          "local",
        ]);
      });

      it("binds no name destructured at module scope", async () => {
        expect(await liftInputs("plus(count, factor)")).toEqual(["count"]);
      });

      it("binds no JSX tag name", async () => {
        expect(await liftInputs("plus(count, [<Badge />].length)")).toEqual([
          "count",
        ]);
      });

      it("binds no property name a binding pattern reads", async () => {
        expect(await liftInputs("plus(count, (({ a: z }) => z)({ a: 1 }))"))
          .toEqual(["count"]);
      });
    });

    describe("zero-argument IIFEs", () => {
      it("keeps the IIFE and lifts a captured cell read inside it", async () => {
        const root = await render("(() => base.get() + 1)()");

        expect(rendered(root)).toBe("(() => __cfLift_1({ base: base }))()");
        expect(lifts(root)).toEqual([
          { inputs: ["base"], body: "base.get() + 1" },
        ]);
      });

      it("keeps the IIFE and lifts a read of a cell held in its own local over the local", async () => {
        const root = await render(
          "(() => { const local = base; return local.get(); })()",
        );

        expect(rendered(root)).toBe(
          "(() => { const local = base; return __cfLift_1({ local: local }); })()",
        );
        expect(lifts(root)).toEqual([
          { inputs: ["local"], body: "local.get()" },
        ]);
      });

      it("keeps the IIFE and lifts a call of a nested function that reads a cell over the function", async () => {
        const root = await render(
          "(() => { const read = () => base.get(); return count + read(); })()",
        );

        expect(lifts(root)).toEqual([
          { inputs: ["count", "read"], body: "count + read()" },
        ]);
      });
    });
  });
});
