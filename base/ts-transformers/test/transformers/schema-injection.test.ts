import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import { collect, literalToValue, parseModule } from "../transformed-ast.ts";
import { transformSource, validateSource } from "../utils.ts";

/** The transformed module for `source`, parsed back into an AST. */
async function transform(source: string): Promise<ts.SourceFile> {
  return parseModule(
    await transformSource(source, { types: COMMONFABRIC_TYPES }),
  );
}

/** The initializer of the variable `name` declares in `root`. */
function initializerOf(root: ts.SourceFile, name: string): ts.Expression {
  const declaration = collect(root, ts.isVariableDeclaration).find((entry) =>
    ts.isIdentifier(entry.name) && entry.name.text === name
  );
  if (!declaration?.initializer) {
    throw new Error(`No initialized declaration of ${name}`);
  }
  return declaration.initializer;
}

/**
 * The call `name`'s initializer makes, looking through the `.for(...)` cause
 * call the pipeline appends to a reactive value.
 */
function callOf(
  root: ts.SourceFile,
  name: string,
): ts.CallExpression | ts.NewExpression {
  let expression = initializerOf(root, name);
  while (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "for"
  ) {
    expression = expression.expression.expression;
  }
  if (!ts.isCallExpression(expression) && !ts.isNewExpression(expression)) {
    throw new Error(`${name} is not initialized by a call`);
  }
  return expression;
}

/** Each argument of `call` evaluated as a literal, or `"<code>"` for code. */
function argumentValues(call: ts.CallExpression | ts.NewExpression): unknown[] {
  return (call.arguments ?? []).map((argument) => {
    try {
      return literalToValue(argument);
    } catch {
      return "<code>";
    }
  });
}

/** Whether `value` is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The output schema of the `pattern(...)` call `name`'s initializer makes. */
function patternOutputSchema(
  root: ts.SourceFile,
  name: string,
): Record<string, unknown> {
  const [, , output] = argumentValues(callOf(root, name));
  if (!isRecord(output)) throw new Error(`${name} has no output schema`);
  return output;
}

/** The `asScope(...)` arguments along the callee chain of `call`. */
function asScopes(call: ts.CallExpression | ts.NewExpression): unknown[] {
  const scopes: unknown[] = [];
  let callee: ts.Expression = call.expression;
  while (ts.isCallExpression(callee)) {
    if (
      ts.isPropertyAccessExpression(callee.expression) &&
      callee.expression.name.text === "asScope"
    ) {
      for (const scope of argumentValues(callee)) scopes.push(scope);
      callee = callee.expression.expression;
    } else {
      callee = callee.expression;
    }
  }
  return scopes;
}

describe("schema-injection", () => {
  describe("contextual scopes", () => {
    const child = `/// <cts-enable />
import { pattern, type PerAny, type PerSession, type PerUser } from "commonfabric";
type Label = { label: string };
const Child = pattern<Label, Label>(({ label }) => ({ label }));
`;

    it("scopes a factory call whose contextual type names a cell scope", async () => {
      const root = await transform(`${child}
export default pattern<Label>(({ label }) => {
  const user: PerUser<Label> = Child({ label });
  return { user };
});`);

      expect(asScopes(callOf(root, "user"))).toEqual(["user"]);
    });

    it("leaves a factory call unscoped where its contextual type is `PerAny`", async () => {
      // `PerAny` names no cell scope: neither its alias nor any member of its
      // scope brand's union is one.

      const root = await transform(`${child}
export default pattern<Label>(({ label }) => {
  const anywhere: PerAny<Label> = Child({ label });
  return { anywhere };
});`);

      expect(asScopes(callOf(root, "anywhere"))).toEqual([]);
    });

    it("keeps the scope an already scoped factory call names", async () => {
      const root = await transform(`${child}
export default pattern<Label>(({ label }) => {
  const scoped: PerSession<Label> = Child.asScope("user")({ label });
  return { scoped };
});`);

      expect(asScopes(callOf(root, "scoped"))).toEqual(["user"]);
    });
  });

  describe("cell constructors", () => {
    const constructors = (body: string) =>
      `/// <cts-enable />
import { type Writable, Writable as WritableConstructor } from "commonfabric";
import * as cf from "commonfabric";
export default function Cells() {
  ${body}
}`;

    it("emits the scope a `new X.perUser(...)` constructor names", async () => {
      const root = await transform(
        constructors(
          `const named = new WritableConstructor.perUser("x"); return { named };`,
        ),
      );

      expect(argumentValues(callOf(root, "named"))).toEqual([
        "x",
        { type: "string", scope: "user" },
      ]);
    });

    it("emits no scope for a `new` constructor read off a namespace", async () => {
      const root = await transform(
        constructors(`const plain = new cf.Writable("y"); return { plain };`),
      );

      expect(argumentValues(callOf(root, "plain"))).toEqual([
        "y",
        { type: "string" },
      ]);
    });

    it("emits no schema for a `new` constructor with no type argument, value or scope", async () => {
      const root = await transform(
        constructors(
          `const bare: Writable<number> = new WritableConstructor(); return { bare };`,
        ),
      );

      expect(argumentValues(callOf(root, "bare"))).toEqual([]);
    });
  });

  describe("cell factories", () => {
    const factories = (body: string) =>
      `/// <cts-enable />
import { Cell, Writable as WritableConstructor, type Writable } from "commonfabric";
import * as cf from "commonfabric";
export default function Cells() {
  ${body}
}`;

    it("emits the scope the constructor view of a `for()` call names", async () => {
      const root = await transform(factories(
        `const draft = Cell.perSession.for<string>("draft"); return { draft };`,
      ));

      expect(argumentValues(callOf(root, "draft"))).toEqual([
        { type: "string", scope: "session" },
      ]);
    });

    it("leaves a `for()` call an author wraps in `asSchema()` as written", async () => {
      const root = await transform(factories(
        `const typed = Cell.for<string>("k").asSchema({ type: "number" });
  return { typed };`,
      ));

      expect(argumentValues(callOf(root, "typed"))).toEqual([
        { type: "number" },
      ]);
      expect(
        collect(root, ts.isCallExpression).filter((call) =>
          ts.isPropertyAccessExpression(call.expression) &&
          call.expression.name.text === "asSchema"
        ),
      ).toHaveLength(1);
    });

    it("emits no scope for a `for()` call on a constructor read off a namespace", async () => {
      const root = await transform(factories(
        `const plain = cf.Cell.for<string>("k"); return { plain };`,
      ));

      expect(argumentValues(callOf(root, "plain"))).toEqual([
        { type: "string" },
      ]);
    });

    it("emits a scoped `of()` call's schema from its contextual type when it has no value", async () => {
      const root = await transform(factories(
        `const scoped: Writable<number> = WritableConstructor.perUser.of();
  return { scoped };`,
      ));

      expect(argumentValues(callOf(root, "scoped"))).toEqual([
        "<code>",
        { type: "number", scope: "user" },
      ]);
    });

    it("emits no schema for an unscoped `of()` call with no value", async () => {
      const root = await transform(factories(
        `const unscoped: Writable<number> = WritableConstructor.of();
  return { unscoped };`,
      ));

      expect(argumentValues(callOf(root, "unscoped"))).toEqual([]);
    });
  });

  describe("handlers with type arguments", () => {
    it("emits the authored event schema and narrows the state schema to its use", async () => {
      const root = await transform(`/// <cts-enable />
import { handler, Writable } from "commonfabric";
export const h = handler<{ n: number; extra: string }, { count: Writable<number>; other: Writable<number> }>(
  (e, state) => { state.count.set(e.n); },
);`);

      expect(argumentValues(callOf(root, "h")).slice(0, 2)).toEqual([
        {
          type: "object",
          properties: { n: { type: "number" }, extra: { type: "string" } },
          required: ["n", "extra"],
        },
        {
          type: "object",
          properties: { count: { type: "number", asCell: ["writeonly"] } },
          required: ["count"],
        },
      ]);
    });
  });

  describe("one-argument handlers", () => {
    const handlers = (declaration: string) =>
      `/// <cts-enable />
import { handler, Writable } from "commonfabric";
export const h = ${declaration};`;

    it("emits the state schema from the type its callback is asserted to", async () => {
      // The body leaves the state unused, so its schema is the asserted type
      // as it stands.

      const root = await transform(handlers(
        `handler(((e, state) => { console.log(e.n); }) as (e: { n: number }, state: { count: Writable<number> }) => void)`,
      ));

      expect(argumentValues(callOf(root, "h")).slice(0, 2)).toEqual([
        {
          type: "object",
          properties: { n: { type: "number" } },
          required: ["n"],
        },
        {
          type: "object",
          properties: { count: { type: "number", asCell: ["cell"] } },
          required: ["count"],
        },
      ]);
    });

    it("emits a cell state schema for a state the callback is asserted to be a cell", async () => {
      // The asserted parameter type is printed, and a printed node is read
      // whole: the cell's value type is printed from its type. The schema is
      // the one the same parameter gets written as an annotation.

      const asserted = await transform(handlers(
        `handler(((e, state) => { console.log(e.n); }) as (e: { n: number }, state: Writable<number>) => void)`,
      ));
      const annotated = await transform(handlers(
        `handler((e: { n: number }, state: Writable<number>) => { console.log(e.n); })`,
      ));

      expect(argumentValues(callOf(asserted, "h"))[1]).toEqual(
        argumentValues(callOf(annotated, "h"))[1],
      );
      expect(argumentValues(callOf(asserted, "h"))[1]).toMatchObject({
        type: "number",
      });
    });

    it("emits `unknown` for an untyped state parameter", async () => {
      const root = await transform(handlers(
        `handler((e, state) => { state.count.set(1); })`,
      ));

      expect(argumentValues(callOf(root, "h")).slice(0, 2)).toEqual([
        { type: "unknown" },
        { type: "unknown" },
      ]);
    });

    it("emits `false` for a missing state parameter", async () => {
      const root = await transform(handlers(
        `handler((e: { n: number }) => { console.log(e.n); })`,
      ));

      expect(argumentValues(callOf(root, "h")).slice(0, 2)).toEqual([
        {
          type: "object",
          properties: { n: { type: "number" } },
          required: ["n"],
        },
        false,
      ]);
    });
  });

  describe("lift", () => {
    it("emits the schemas of a lift's two type arguments", async () => {
      const root = await transform(`/// <cts-enable />
import { lift } from "commonfabric";
export const l = lift<{ a: number; b: string }, string | number>((x) => x.a);`);

      expect(argumentValues(callOf(root, "l")).slice(1)).toEqual([
        {
          type: "object",
          properties: { a: { type: "number" } },
          required: ["a"],
        },
        { type: ["number", "string"] },
      ]);
    });

    it("merges the options an authored `toSchema()` argument schema carries", async () => {
      const root = await transform(`/// <cts-enable />
import { lift, toSchema } from "commonfabric";
export const l = lift(
  toSchema<{ a: number }>({ default: { a: 1 } }),
  toSchema<number>(),
  () => 1,
);`);

      expect(argumentValues(callOf(root, "l")).slice(0, 2)).toEqual([
        {
          type: "object",
          properties: { a: { type: "number" } },
          required: ["a"],
          default: { a: 1 },
        },
        { type: "number" },
      ]);
    });

    it("leaves a lift with one type argument and a callback reference as written", async () => {
      const root = await transform(`/// <cts-enable />
import { lift } from "commonfabric";
function double(x: number) { return x * 2; }
export const l = lift<number>(double);`);

      expect(argumentValues(callOf(root, "l"))).toEqual(["<code>"]);
    });

    it("leaves a lift with only an authored argument schema as written", async () => {
      const root = await transform(`/// <cts-enable />
import { lift, toSchema } from "commonfabric";
export const l = lift(toSchema<number>());`);

      expect(argumentValues(callOf(root, "l"))).toEqual([{ type: "number" }]);
    });

    describe("applied to a cell", () => {
      const applied = (lift: string) =>
        `/// <cts-enable />
import { lift, Writable } from "commonfabric";
export function make(count: Writable<number>) {
  const x = ${lift}(count);
  return { x };
}`;

      /** The input schema of the lift `applied(lift)` hoists. */
      async function inputSchema(lift: string): Promise<unknown> {
        const root = await transform(applied(lift));
        return argumentValues(callOf(root, "__cfLift_1"))[1];
      }

      it("emits `false` as the input schema of a callback with no parameter", async () => {
        expect(await inputSchema("lift(() => 1)")).toBe(false);
      });

      it("emits a readonly cell input schema for a callback that reads the cell", async () => {
        expect(await inputSchema("lift((c) => c.get() + 1)")).toEqual({
          type: "number",
          asCell: ["readonly"],
        });
      });

      it("emits an opaque cell input schema for a callback that reads the cell only in a nested function", async () => {
        // The cell type is printed, and a printed node is read whole, never
        // taken apart for its value type.

        expect(await inputSchema("lift((c) => () => c.get())")).toEqual({
          type: "number",
          asCell: ["opaque"],
        });
      });
    });
  });

  describe("a cell parameter narrowed to the capability its callback earns", () => {
    // The cell is rewrapped in the capability its callback earns. Only a scope
    // wrapper names the cell's scope, and a generic alias of a cell writes no
    // wrapper out, so the value is read from the cell's type, one cell deep.

    const module = (declaration: string) =>
      `/// <cts-enable />
import { handler, lift, type PerUser, Writable } from "commonfabric";
type Slot<T> = Writable<T>;
type MyState = PerUser<Writable<number>>;
type Cfc<T, Meta> = T & { readonly __ct_cfc__?: { readonly meta?: Meta; readonly of?: T } };
type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;
type Owned = Confidential<Writable<string>, ["owner"]>;
export const x = ${declaration};`;

    /**
     * The schema of the cell parameter `declaration`'s callback narrows: the
     * second argument, a handler's state schema or a lift's input schema.
     */
    async function cellSchema(declaration: string): Promise<unknown> {
      return argumentValues(
        callOf(await transform(module(declaration)), "x"),
      )[1];
    }

    it("keeps a handler state cell's scope on its readonly narrowing", async () => {
      expect(
        await cellSchema(
          "handler((e: { n: number }, s: PerUser<Writable<number>>) => { console.log(e.n, s.get()); })",
        ),
      ).toEqual({
        type: "number",
        asCell: [{ kind: "readonly", scope: "user" }],
      });
    });

    it("keeps a lift argument cell's scope on its readonly narrowing", async () => {
      expect(
        await cellSchema("lift((s: PerUser<Writable<number>>) => s.get())"),
      ).toEqual({
        type: "number",
        asCell: [{ kind: "readonly", scope: "user" }],
      });
    });

    it("keeps a handler state cell's scope when an alias writes the scope wrapper", async () => {
      expect(
        await cellSchema(
          "handler((e: { n: number }, s: MyState) => { console.log(e.n, s.get()); })",
        ),
      ).toEqual({
        type: "number",
        asCell: [{ kind: "readonly", scope: "user" }],
      });
    });

    it("keeps a lift argument cell's scope when an alias writes the scope wrapper", async () => {
      expect(await cellSchema("lift((s: MyState) => s.get())")).toEqual({
        type: "number",
        asCell: [{ kind: "readonly", scope: "user" }],
      });
    });

    it("keeps a handler state cell's confidentiality label on its readonly narrowing", async () => {
      expect(
        await cellSchema(
          "handler((e: { n: number }, s: Owned) => { console.log(e.n, s.get()); })",
        ),
      ).toMatchObject({
        type: "string",
        asCell: ["readonly"],
        ifc: { confidentiality: ["owner"] },
      });
    });

    it("keeps a lift argument cell's confidentiality label on its readonly narrowing", async () => {
      expect(await cellSchema("lift((s: Owned) => s.get())")).toMatchObject({
        type: "string",
        asCell: ["readonly"],
        ifc: { confidentiality: ["owner"] },
      });
    });

    it("keeps the cell a handler state cell holds when a generic alias writes the outer one", async () => {
      const aliased = await cellSchema(
        "handler((e: { n: number }, s: Slot<Writable<number>>) => { console.log(e.n, s.get().get()); })",
      );

      expect(aliased).toEqual({ type: "number", asCell: ["readonly", "cell"] });
      expect(aliased).toEqual(
        await cellSchema(
          "handler((e: { n: number }, s: Writable<Writable<number>>) => { console.log(e.n, s.get().get()); })",
        ),
      );
    });

    it("keeps the cell a lift argument cell holds when a generic alias writes the outer one", async () => {
      expect(
        await cellSchema("lift((s: Slot<Writable<number>>) => s.get().get())"),
      ).toEqual(
        await cellSchema(
          "lift((s: Writable<Writable<number>>) => s.get().get())",
        ),
      );
    });
  });

  describe("lift applied", () => {
    /** The schema arguments of each lift `body` hoists, by hoisted name. */
    async function hoistedLiftSchemas(
      body: string,
    ): Promise<Record<string, unknown[]>> {
      const root = await transform(`/// <cts-enable />
import { lift, Writable } from "commonfabric";
function double(x: number) { return x * 2; }
export function make(count: Writable<number>) {
  ${body}
}`);
      return Object.fromEntries(
        collect(root, ts.isVariableDeclaration)
          .filter((entry) =>
            ts.isIdentifier(entry.name) &&
            entry.name.text.startsWith("__cfLift_")
          )
          .map((entry) => [
            entry.name.getText(root),
            argumentValues(callOf(root, entry.name.getText(root))).slice(1),
          ]),
      );
    }

    it("emits the type arguments' schemas for an application with no input", async () => {
      expect(
        await hoistedLiftSchemas(
          "const x = lift<number, number>((n) => n)(); return { x };",
        ),
      ).toEqual({ __cfLift_1: [{ type: "number" }, { type: "number" }] });
    });

    it("emits the type arguments' schemas for an application with an empty object and another input", async () => {
      // Only a single empty object literal input is the no-input form, whose
      // argument schema is `false`.

      expect(
        await hoistedLiftSchemas(
          "const x = lift<number, number>((n) => n)({}, count); return { x };",
        ),
      ).toEqual({ __cfLift_1: [{ type: "number" }, { type: "number" }] });
    });

    it("emits no schema for an application of a lift of a callback reference", async () => {
      expect(
        await hoistedLiftSchemas(
          "const x = lift(double)(count); return { x };",
        ),
      ).toEqual({ __cfLift_1: [] });
    });
  });

  describe("reactive conditionals", () => {
    it("leaves a conditional with another arity than its own as written", async () => {
      const root = await transform(`/// <cts-enable />
import { ifElse, pattern, when } from "commonfabric";
export default pattern<{ flag: boolean; n: number }>(({ flag, n }) => {
  const w = when(flag, n, n);
  const e = ifElse(flag, n);
  return { w, e };
});`);

      expect(argumentValues(callOf(root, "w"))).toEqual([
        "<code>",
        "<code>",
        "<code>",
      ]);
      expect(argumentValues(callOf(root, "e"))).toEqual(["<code>", "<code>"]);
    });
  });

  describe("sqliteQuery", () => {
    it("spreads an options value that is not an object literal beside the row schema", async () => {
      const root = await transform(`/// <cts-enable />
import { pattern, sqliteQuery } from "commonfabric";
export default pattern<{ db: any }>(({ db }) => {
  const rows = sqliteQuery<{ id: number }>(db.options);
  return { rows };
});`);

      const [options] = callOf(root, "rows").arguments ?? [];
      if (!options || !ts.isObjectLiteralExpression(options)) {
        throw new Error("Expected an options object literal");
      }
      const [spread, rowSchema] = options.properties;
      expect(spread && ts.isSpreadAssignment(spread)).toBe(true);
      if (!rowSchema || !ts.isPropertyAssignment(rowSchema)) {
        throw new Error("Expected a `rowSchema` property");
      }
      expect(literalToValue(rowSchema.initializer)).toEqual({
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      });
    });
  });

  describe("pattern result diagnostics", () => {
    it("reports `pattern:any-result-schema` for a callback whose authored return type is `any`", async () => {
      const { diagnostics } = await validateSource(
        `/// <cts-enable />
import { pattern } from "commonfabric";
export default pattern((s: { q: number }): any => 42);`,
        { types: COMMONFABRIC_TYPES },
      );

      expect(diagnostics.map((d) => d.type)).toContain(
        "pattern:any-result-schema",
      );
    });

    it("reports nothing for a callback whose authored return type is concrete", async () => {
      const { diagnostics } = await validateSource(
        `/// <cts-enable />
import { pattern } from "commonfabric";
export default pattern((s: { q: number }): number => 42);`,
        { types: COMMONFABRIC_TYPES },
      );

      expect(diagnostics.map((d) => d.type)).not.toContain(
        "pattern:any-result-schema",
      );
    });
  });

  describe("UI contracts", () => {
    const uiContract = (action: string) => ({
      uiContract: { helper: "UiAction", action },
    });

    it("reads a UI action from a `data-ui-action` attribute an author wrote", async () => {
      const root = await transform(`/// <cts-enable />
import { pattern, UI } from "commonfabric";
export const raw = pattern<{ title: string }>((state) => ({
  [UI]: <ct-button data-ui-action={"Submit"}>Go</ct-button>,
  title: state.title,
}));`);

      expect(patternOutputSchema(root, "raw").ifc).toEqual(
        uiContract("Submit"),
      );
    });

    it("records a UI contract on the member of an authored result type the value fills", async () => {
      const root = await transform(`/// <cts-enable />
import { pattern, UiAction, VNode } from "commonfabric";
export const annotated = pattern<{ title: string }>((state): { ui: VNode; title: string } => ({
  ui: <UiAction action="Go">Go</UiAction>,
  title: state.title,
}));`);
      const output = patternOutputSchema(root, "annotated");

      expect(output.ifc).toEqual(uiContract("Go"));
      expect(output.properties).toEqual({
        ui: {
          $ref: "https://commonfabric.org/schemas/vnode.json",
          ifc: uiContract("Go"),
        },
        title: { type: "string" },
      });
    });

    it("records a UI contract only on the whole result where the value's key is computed", async () => {
      const root = await transform(`/// <cts-enable />
import { pattern, UiAction, VNode } from "commonfabric";
export const computedKey = pattern<{ title: string }>((state): { ui: VNode; title: string } => ({
  ["ui"]: <UiAction action="Go">Go</UiAction>,
  title: state.title,
}));`);
      const output = patternOutputSchema(root, "computedKey");

      expect(output.ifc).toEqual(uiContract("Go"));
      expect(output.properties).toEqual({
        ui: { $ref: "https://commonfabric.org/schemas/vnode.json" },
        title: { type: "string" },
      });
    });
  });

  describe("result recovery for a value typed `any`", () => {
    // Each pattern returns one value a lift computes from a callback whose
    // parameter is untyped, so the value's own type is `any`, and its result
    // schema is recovered from the lift that computes it where that can be
    // done.

    /** The output schema of a pattern that computes `value` and returns it. */
    async function outputFor(value: string): Promise<Record<string, unknown>> {
      const root = await transform(`/// <cts-enable />
import { lift, pattern } from "commonfabric";
function pick(x: any) { return x.count; }
const viaFactory = lift((x) => x.count);
const viaTyped = lift<{ count: number }>((x) => x.count);
const viaRef = lift(pick);
export const p = pattern<{ count: number }>((state) => {
  const value = ${value};
  return { value };
});`);
      return patternOutputSchema(root, "p");
    }

    /** An output schema whose single property `value` is `schema`. */
    const valueSchema = (schema: unknown) => ({
      type: "object",
      properties: { value: schema },
      required: ["value"],
    });

    it("recovers the projection a lift applied in place computes from its input", async () => {
      expect(await outputFor("lift((x) => x.count)(state)")).toEqual(
        valueSchema({ type: "number" }),
      );
    });

    it("recovers the projection a lift factory with an argument type computes", async () => {
      expect(await outputFor("viaTyped(state)")).toEqual(
        valueSchema({ type: "number" }),
      );
    });

    it("recovers the input schema of a lift applied in place from the lift factory that computes its input", async () => {
      const root = await transform(`/// <cts-enable />
import { lift, pattern } from "commonfabric";
const viaTyped = lift<{ count: number }>((x) => x.count);
export const p = pattern<{ count: number }>((state) => {
  const input = viaTyped(state);
  const value = lift((x) => x)(input);
  return { value };
});`);

      expect(argumentValues(callOf(root, "__cfLift_1"))[1]).toEqual({
        type: "number",
      });
    });

    it("emits `true` for a lift of a callback reference applied in place", async () => {
      expect(await outputFor("lift(pick)(state)")).toEqual(valueSchema(true));
    });

    it("emits `true` for a lift factory with no argument type", async () => {
      expect(await outputFor("viaFactory(state)")).toEqual(valueSchema(true));
    });

    it("emits `true` for a lift factory of a callback reference", async () => {
      expect(await outputFor("viaRef(state)")).toEqual(valueSchema(true));
    });

    it("emits `true` for a callback whose body returns only from a nested block", async () => {
      expect(
        await outputFor(
          "lift((x) => { if (x) { return x.count; } })(state)",
        ),
      ).toEqual(valueSchema(true));
    });
  });

  describe("hardened callbacks", () => {
    it("emits schemas for a lift whose callback the function-hardening helper wraps", async () => {
      const root = await transform(`/// <cts-enable />
import { lift } from "commonfabric";
function __cfHardenFn<T>(fn: T): T { return fn; }
function wrap<T>(fn: T): T { return fn; }
export const hardened = lift(__cfHardenFn((x: number) => x * 2));
export const wrapped = lift(wrap((x: number) => x * 2));`);

      expect(argumentValues(callOf(root, "hardened")).slice(1)).toEqual([
        { type: "number" },
        { type: "number" },
      ]);
      expect(argumentValues(callOf(root, "wrapped"))).toEqual(["<code>"]);
    });
  });
});
