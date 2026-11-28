import { expect } from "@std/expect";
import ts from "typescript";
import { StaticCache } from "@commonfabric/static";

import { CrossStageState, TransformationContext } from "../../src/core/mod.ts";
import { transformCfDirective } from "../../src/mod.ts";
import { rewritePatternCallbackBody } from "../../src/transformers/pattern-body-reactive-root-lowering.ts";
import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import { callsNamed, collect, parseModule } from "../transformed-ast.ts";
import {
  createInMemoryProgram,
  validateSource,
  withSourceText,
} from "../utils.ts";
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
  return {
    output: parseModule(output),
    diagnostics: withSourceText(source, diagnostics).map((
      { type, message, text },
    ) => ({ type, message, text })),
  };
}

const staticCache = StaticCache.fromFileSystem();
const LIBRARIES = {
  "/lib.d.ts": await staticCache.getText("types/es2023.d.ts"),
  "/jsx.d.ts": await staticCache.getText("types/jsx.d.ts"),
};

const DYNAMIC_KEY_MESSAGE = "Dynamic key access is not lowerable in pattern " +
  "context. Use a compute wrapper for dynamic traversal.";

/**
 * Runs `rewritePatternCallbackBody()` by itself, with none of the stages that
 * run before it in the pipeline, over the body of the first arrow function in
 * `body` (compiled under a `commonfabric` import), treating `roots` as the
 * opaque roots. `computeCallback` marks that arrow as a synthetic compute
 * callback first. `syntheticBody`, when given, replaces the arrow's body with
 * a block it builds, as an earlier stage would, from new nodes and nodes of
 * the source file. Returns the rewritten body printed and parsed back, and the
 * diagnostics the rewrite reported.
 */
function rewriteAlone(
  body: string,
  roots: readonly string[],
  options: {
    computeCallback?: boolean;
    syntheticBody?: (
      factory: ts.NodeFactory,
      sourceFile: ts.SourceFile,
    ) => ts.Block;
  } = {},
) {
  const source = transformCfDirective(
    `/// <cts-enable />
import { lift, pattern, Writable } from "commonfabric";
${body}`,
  );
  const program = createInMemoryProgram({
    "/test.tsx": source,
    "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    "/cfc.ts": COMMONFABRIC_TYPES["cfc.ts"]!,
    ...LIBRARIES,
  }, {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.Preserve,
    strict: true,
  });
  const sourceFile = program.getSourceFile("/test.tsx")!;
  const callback = collect(sourceFile, ts.isArrowFunction)[0];
  if (!callback) throw new Error("no arrow function");

  let printed = "";
  let diagnostics: { type: string; message: string }[] = [];
  const result = ts.transform(sourceFile, [(tsContext) => (file) => {
    const context = new TransformationContext({
      program,
      sourceFile,
      tsContext,
      options: { state: new CrossStageState() },
    });
    if (options.computeCallback) {
      context.markAsSyntheticComputeCallback(callback);
    }
    const rewritten = rewritePatternCallbackBody(
      options.syntheticBody?.(tsContext.factory, sourceFile) ??
        callback.body,
      new Set(roots),
      new Set(),
      context,
    );
    printed = ts.createPrinter().printNode(
      ts.EmitHint.Unspecified,
      rewritten,
      sourceFile,
    );
    diagnostics = context.diagnostics.map(({ type, message }) => ({
      type,
      message,
    }));
    return file;
  }]);
  result.dispose();
  return { root: parseModule(printed), diagnostics };
}

/** The lift calls (`__cfHelpers.lift(...)`) in `root`. */
function lifts(root: ts.Node): ts.CallExpression[] {
  return callsNamed(root, "lift");
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

    it("names the computed() remedy for a method named by a numeric key", async () => {
      const { diagnostics } = await compile(`
interface Item { name: string; formats: (() => string)[] }
interface Input { items: Item[]; flag: boolean; }
export default pattern<Input>(({ items, flag }) => {
  const out = items.map((item) => ifElse(flag, item.formats[0](), "x"));
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
        text: "item.formats[0]()",
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

  describe("traversals of a dynamic key read", () => {
    it("reports the dynamic key read once although a for..of also traverses it", async () => {
      const { diagnostics } = await compile(`
interface User { tags: string[][] }
interface Input { user: User; k: number }
export default pattern<Input>(({ user, k }) => {
  for (const tag of user.tags[k]) {}
  return { done: true };
});`);

      expect(
        diagnostics.filter((d) => d.type === "pattern-context:computation"),
      ).toEqual([{
        type: "pattern-context:computation",
        message: DYNAMIC_KEY_MESSAGE,
        text: "user.tags[k]",
      }]);
    });

    it("reports each of two dynamic key reads", async () => {
      const { diagnostics } = await compile(`
interface User { tags: string[][] }
interface Input { user: User; k: number; j: number }
export default pattern<Input>(({ user, k, j }) => {
  for (const tag of user.tags[k]) {}
  for (const tag of user.tags[j]) {}
  return { done: true };
});`);

      expect(
        diagnostics.filter((d) => d.type === "pattern-context:computation"),
      ).toEqual(["user.tags[k]", "user.tags[j]"].map((text) => ({
        type: "pattern-context:computation",
        message: DYNAMIC_KEY_MESSAGE,
        text,
      })));
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

  describe("array destructuring with a hole", () => {
    it("treats the element after the hole as a plain local that shadows an input", async () => {
      const { output, diagnostics } = await compile(`
interface User { name: string }
interface Input { user: User }
export default pattern<Input>(({ user }) => {
  {
    const [, user] = [0, { name: "x" }];
    const inner = user.name;
  }
  const outer = user.name;
  return { outer };
});`);

      expect(diagnostics).toEqual([]);
      expect(ts.isPropertyAccessExpression(initializerOf(output, "inner")))
        .toBe(true);
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

  describe("run alone over a body no earlier stage lowered", () => {
    it("wraps a comparison with a dynamic key read in a lift", () => {
      const { root, diagnostics } = rewriteAlone(
        `export default pattern<{ flags: boolean[]; k: number }>((state) => {
  const dynamic = state.flags[state.k] === true;
  const fixed = state.flags[0] === true;
  return { dynamic, fixed };
});`,
        ["state"],
      );

      expect(diagnostics).toEqual([]);
      const [lift] = lifts(initializerOf(root, "dynamic"));
      const callback = lift?.arguments[0];
      if (!callback || !ts.isArrowFunction(callback)) {
        throw new Error("expected a lift of an arrow function");
      }
      expect(ts.isBinaryExpression(callback.body)).toBe(true);
      // A static key is read in place, with no wrapper.
      const fixed = initializerOf(root, "fixed");
      expect(lifts(fixed)).toEqual([]);
      expect(ts.isBinaryExpression(fixed)).toBe(true);
    });

    it("reports a dynamic key comparison moved out of a lift's arguments instead of wrapping it", () => {
      // The initializer is the authored argument of the lift call, so its
      // parent is still that call, which owns the lowering of its arguments.
      const { root, diagnostics } = rewriteAlone(
        `export default pattern<{ flags: boolean[]; k: number }>((state) =>
  lift((checked: boolean) => checked)(state.flags[state.k] === true)
);`,
        ["state"],
        {
          syntheticBody: (factory, sourceFile) => {
            const [comparison] = collect(sourceFile, ts.isBinaryExpression);
            if (!comparison) throw new Error("no comparison");
            return factory.createBlock([
              factory.createVariableStatement(
                undefined,
                factory.createVariableDeclarationList(
                  [factory.createVariableDeclaration(
                    "checked",
                    undefined,
                    undefined,
                    comparison,
                  )],
                  ts.NodeFlags.Const,
                ),
              ),
            ]);
          },
        },
      );

      expect(diagnostics).toEqual([
        {
          type: "reactive:call-argument-computation",
          message: "Reactive computation `state.flags[state.k] === true` " +
            "cannot be compiled inline in the arguments of " +
            "`lift((checked: boolean) => checked)(...)`. Hoist it to a " +
            "body-level const or computed(...) and pass that value instead.",
        },
        { type: "pattern-context:computation", message: DYNAMIC_KEY_MESSAGE },
      ]);
      expect(lifts(initializerOf(root, "checked"))).toEqual([]);
    });

    it("reports a dynamic key read that has no reactive data flow", () => {
      const { root, diagnostics } = rewriteAlone(
        `declare const k: number;
export const read = (state: { flags: boolean[] }) => {
  const checked = state.flags[k] === true;
  return checked;
};`,
        ["state"],
      );

      expect(diagnostics).toEqual([{
        type: "pattern-context:computation",
        message: DYNAMIC_KEY_MESSAGE,
      }]);
      expect(lifts(root)).toEqual([]);
    });

    it("reports a dynamic key read in JSX that has no reactive data flow", () => {
      const { root, diagnostics } = rewriteAlone(
        `declare const k: number;
export const view = (state: { items: string[] }) => <div>{state.items[k]}</div>;`,
        ["state"],
      );

      expect(diagnostics).toEqual([{
        type: "pattern-context:computation",
        message: DYNAMIC_KEY_MESSAGE,
      }]);
      expect(lifts(root)).toEqual([]);
    });

    it("wraps a dynamic key read in JSX, except in a synthetic compute callback", () => {
      const body = `declare const k: number;
export default pattern<{ items: string[] }>((state) => <div>{state.items[k]}</div>);`;

      const pattern = rewriteAlone(body, ["state"]);
      expect(pattern.diagnostics).toEqual([]);
      expect(lifts(pattern.root)).toHaveLength(1);

      const compute = rewriteAlone(body, ["state"], { computeCallback: true });
      expect(lifts(compute.root)).toEqual([]);
    });

    it("wraps a JSX read whose dynamic key sits inside the path", () => {
      const { root, diagnostics } = rewriteAlone(
        `declare const k: number;
export default pattern<{ items: { name: string }[] }>((state) => (
  <div>{state.items[k].name}{state.items[0].name}</div>
));`,
        ["state"],
      );

      expect(diagnostics).toEqual([]);
      // Only the dynamic read is wrapped; the static one becomes a key read.
      expect(lifts(root)).toHaveLength(1);
      const keyReads = callsNamed(root, "key").filter((call) =>
        call.arguments.map((argument) =>
          ts.isStringLiteral(argument) && argument.text
        ).join() === "items,0,name"
      );
      expect(keyReads).toHaveLength(1);
    });

    it("wraps a JSX element read off a plain value when its key reads an opaque root", () => {
      const { root, diagnostics } = rewriteAlone(
        `declare const plain: string[];
export const view = (state: { idx: number }) => <div>{plain[state.idx]}</div>;`,
        ["state"],
      );

      expect(diagnostics).toEqual([]);
      const [lift] = lifts(root);
      if (!lift) throw new Error("expected a lift");
      // The key is lowered to a key read inside the wrapper.
      expect(callsNamed(lift, "key")).toHaveLength(1);
    });

    it("leaves a JSX element read off a plain value with a plain key", () => {
      const { root, diagnostics } = rewriteAlone(
        `declare const plain: string[];
declare const k: number;
export const view = (state: { idx: number }) => <div>{plain[k]}</div>;`,
        ["state"],
      );

      expect(diagnostics).toEqual([]);
      expect(lifts(root)).toEqual([]);
    });

    it("wraps a cell \`.get()\` in JSX only when it has a reactive data flow", () => {
      const cell = rewriteAlone(
        `declare const count: Writable<string>;
export default pattern<{ idx: number }>((state) => <div>{count.get()}</div>);`,
        ["state"],
      );
      expect(cell.diagnostics).toEqual([]);
      expect(lifts(cell.root)).toHaveLength(1);

      const plain = rewriteAlone(
        `export const view = (state: { count: { get(): string } }) => (
  <div>{state.count.get()}</div>
);`,
        ["state"],
      );
      expect(plain.diagnostics).toEqual([]);
      expect(lifts(plain.root)).toEqual([]);
      expect(callsNamed(plain.root, "get")).toHaveLength(1);
    });

    it("reports each synthesized dynamic key read once although a for..of also traverses it", () => {
      const { diagnostics } = rewriteAlone(
        `declare const k: number;
export default pattern<{ tags: string[][] }>((state) => 0);`,
        ["state"],
        {
          syntheticBody: (factory) => {
            const loop = () =>
              factory.createForOfStatement(
                undefined,
                factory.createVariableDeclarationList(
                  [factory.createVariableDeclaration("tag")],
                  ts.NodeFlags.Const,
                ),
                factory.createElementAccessExpression(
                  factory.createIdentifier("state"),
                  factory.createIdentifier("k"),
                ),
                factory.createBlock([]),
              );
            return factory.createBlock([loop(), loop()]);
          },
        },
      );

      // One report for each of the two reads, none for either for..of.
      expect(diagnostics).toEqual([
        { type: "pattern-context:computation", message: DYNAMIC_KEY_MESSAGE },
        { type: "pattern-context:computation", message: DYNAMIC_KEY_MESSAGE },
      ]);
    });
  });
});
