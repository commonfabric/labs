import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import ts from "typescript";
import {
  isPatternFactoryCalleeExpression,
  isStructuralReactiveFactoryExpression,
  returnsReactiveResult,
} from "../../src/transformers/structural-reactive-factory.ts";
import {
  analyzeExpression,
  CELL_VARIANTS_PRELUDE,
} from "../reactive/harness.ts";

import { StaticCache } from "@commonfabric/static";

import { validateSource } from "../utils.ts";

const commonfabricTypes = await StaticCache.fromFileSystem().getText(
  "types/commonfabric.d.ts",
);
const identity =
  `function identity(v: WishState<string>): WishState<string> { return v; }`;
const factory =
  `function make(): WishState<string> { return wish<string>({ query: "#inner" }); }`;

const PRELUDE = `${CELL_VARIANTS_PRELUDE}
declare function makeCell(): Cell<number>;
declare function makeNumber(): number;
interface PatternFactory {
  (input: unknown): unknown;
  argumentSchema: unknown;
  resultSchema: unknown;
}
interface BoundPatternFactory extends PatternFactory {
  with(extra: unknown): PatternFactory;
}
declare const factory: PatternFactory;
declare const boundFactory: BoundPatternFactory;
`;

function analyzeCall(source: string) {
  const { checker, expression } = analyzeExpression(source, {
    prelude: PRELUDE,
  });
  if (!ts.isCallExpression(expression)) {
    throw new Error(`expected a call expression: ${source}`);
  }
  return { checker, call: expression };
}

describe("structural-reactive-factory", () => {
  for (
    const [name, body, rejected] of [
      [
        "factory replaced by an ordinary helper",
        "let helper = make; helper = ordinary; return helper();",
        false,
      ],
      [
        "ordinary helper replaced by a factory",
        "let helper = ordinary; helper = make; return helper();",
        true,
      ],
      [
        "conditional factory replacement",
        "let helper = ordinary; if (choose) helper = make; return helper();",
        true,
      ],
      [
        "closure factory replacement",
        "let helper = ordinary; const replace = () => { helper = make; }; replace(); return helper();",
        true,
      ],
      [
        "later factory replacement",
        "let helper = ordinary; const value = helper(); helper = make; return value;",
        false,
      ],
      [
        "saved ordinary callable",
        "let helper = ordinary; const saved = helper; helper = make; return saved();",
        false,
      ],
      [
        "saved factory callable",
        "let helper = make; const saved = helper; helper = ordinary; return saved();",
        true,
      ],
      [
        "dominating ordinary replacement",
        "let helper = make; if (choose) helper = ordinary; helper = ordinary; return helper();",
        false,
      ],
      [
        "destructured replacement",
        "let helper = ordinary; ({ helper } = { helper: make }); return helper();",
        true,
      ],
      [
        "for-of replacement",
        "let helper = ordinary; for (helper of [make]) {} return helper();",
        true,
      ],
      [
        "compound replacement",
        "let helper = ordinary; helper ||= make; return helper();",
        true,
      ],
      [
        "same-statement replacement",
        "let helper = ordinary; return (helper = make, helper());",
        true,
      ],
      [
        "declaration-statement replacement",
        "let helper = ordinary, copy = (helper = make); return helper();",
        true,
      ],
      [
        "a saved factory assigned back to its original binding",
        "let helper = make; const saved = helper; helper = saved; return helper();",
        true,
      ],
      [
        "a destructured callable replacement",
        "let [helper] = [ordinary]; helper = make; return helper();",
        true,
      ],
      [
        "a conditional replacement value",
        "let helper = ordinary; helper = choose ? make : ordinary; return helper();",
        true,
      ],
      [
        "a logical replacement value",
        "let helper = ordinary; helper = (choose && make) || ordinary; return helper();",
        true,
      ],
      [
        "an indexed replacement value",
        "let helper = ordinary; helper = [make][0]!; return helper();",
        true,
      ],
    ] as const
  ) {
    it(`${rejected ? "rejects" : "allows"} a compute after ${name}`, async () => {
      const { diagnostics } = await validateSource(
        `import { pattern, computed, wish, type AsyncResult } from "commonfabric";
        export default pattern<{ choose: boolean }>(({ choose }) => ({
          value: computed(() => {
            const ordinary = (): AsyncResult<string> => "ordinary";
            const make = (): AsyncResult<string> => wish<string>({ query: "#inner" }).result;
            ${body}
          }),
        }));`,
        { types: { "commonfabric.d.ts": commonfabricTypes } },
      );
      expect(
        diagnostics.filter(({ severity }) => severity === "error")
          .map(({ type }) => type),
      ).toEqual(
        rejected ? ["compute-context:local-reactive-use"] : [],
      );
    });
  }

  for (
    const [name, helper, call] of [
      ["identity getter", identity, "identity(request)"],
      [
        "overloaded identity getter",
        `function identity(v: WishState<string>): WishState<string>;
        function identity(v: WishState<string>): WishState<string> { return v; }`,
        "identity(request)",
      ],
      [
        "constant arrow getter",
        "const identity = (v: WishState<string>): WishState<string> => v;",
        "identity(request)",
      ],
      [
        "callable getter alias",
        `${identity} const alias = identity;`,
        "alias(request)",
      ],
      [
        "delegated getter",
        `${identity} function get(v: WishState<string>): WishState<string> { return identity(v); }`,
        "get(request)",
      ],
    ]
  ) {
    it(`allows a stored Wish read via ${name}`, async () => {
      const { diagnostics } = await validateSource(
        `
        import { pattern, computed, wish, type WishState } from "commonfabric";
        ${helper}
        export default pattern(() => {
          const request = wish<string>({ query: "#outer" });
          return { value: computed(() => ${call}.result) };
        });
      `,
        { types: { "commonfabric.d.ts": commonfabricTypes } },
      );
      expect(
        diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      )
        .toEqual([]);
    });
  }

  for (
    const [name, helper, call] of [
      ["direct factory wrapper", factory, "make()"],
      ["callable factory alias", `${factory} const alias = make;`, "alias()"],
      [
        "conditional factory return",
        `function make(v: WishState<string>): WishState<string> { return true ? wish<string>({ query: "#inner" }) : v; }`,
        "make(request)",
      ],
      [
        "opaque external helper",
        `import { lookup } from "opaque-helper";`,
        "lookup()",
      ],
      [
        "opaque external alias",
        `import { lookup } from "opaque-helper"; const alias = lookup;`,
        "alias()",
      ],
      [
        "factory evaluated as a getter argument",
        `${identity} function make(): WishState<string> { return identity(wish<string>({ query: "#inner" })); }`,
        "make()",
      ],
      [
        "uninspectable multi-statement helper",
        `function get(v: WishState<string>): WishState<string> { const copy = v; return copy; }`,
        "get(request)",
      ],
      [
        "factory in a default parameter",
        `function make(v: WishState<string> = wish<string>({ query: "#inner" })): WishState<string> { return v; }`,
        "make()",
      ],
      [
        "property getter with unproven accessor provenance",
        `function get(v: { request: WishState<string> }): WishState<string> { return v.request; }`,
        "get({ request })",
      ],
      [
        "factory hidden in an argument accessor",
        `function get(v: { request: WishState<string> }): WishState<string> { return v.request; }
        const box = { get request() { return wish<string>({ query: "#inner" }); } };`,
        "get(box)",
      ],
      [
        "factory in a destructured default",
        `function get({ v = wish<string>({ query: "#inner" }) }: { v?: WishState<string> }): WishState<string> { return v; }`,
        "get({})",
      ],
      [
        "accessor evaluated by parameter destructuring",
        `function get({ request }: { request: WishState<string> }): WishState<string> { return request; }
        const box = { get request() { return wish<string>({ query: "#inner" }); } };`,
        "get(box)",
      ],
      [
        "reassigned callable alias",
        `${identity} ${factory} let alias = identity; alias = make;`,
        "alias(request)",
      ],
      [
        "mutable callable alias",
        `${identity} let alias = identity;`,
        "alias(request)",
      ],
      [
        "reassigned function declaration",
        `${identity} ${factory} identity = make;`,
        "identity(request)",
      ],
      [
        "object spread evaluated in an unused argument",
        `function get(v: WishState<string>, extra: unknown): WishState<string> { return v; }
        const box = { get request() { return wish<string>({ query: "#inner" }); } };`,
        "get(request, { ...box })",
      ],
      [
        "array spread evaluated in an unused argument",
        `function get(v: WishState<string>, extra: unknown): WishState<string> { return v; }
        const source = { *[Symbol.iterator]() { yield wish<string>({ query: "#inner" }); } };`,
        "get(request, [...source])",
      ],
      [
        "cyclic delegation",
        `function first(v: WishState<string>): WishState<string> { return second(v); }
        function second(v: WishState<string>): WishState<string> { return first(v); }`,
        "first(request)",
      ],
    ]
  ) {
    it(`reports factory placement for ${name} inside a compute`, async () => {
      const { diagnostics } = await validateSource(
        `
        import { pattern, computed, wish, type WishState } from "commonfabric";
        ${helper}
        export default pattern(() => {
          const request = wish<string>({ query: "#outer" });
          return { value: computed(() => ${call}.result) };
        });
      `,
        {
          types: {
            "commonfabric.d.ts": commonfabricTypes,
            "opaque-helper.d.ts": `declare module "opaque-helper" {
            import type { WishState } from "commonfabric";
            export function lookup(): WishState<string>;
          }`,
          },
        },
      );
      expect(
        diagnostics.filter((diagnostic) => diagnostic.severity === "error")
          .map((diagnostic) => diagnostic.type),
      )
        .toEqual(
          name === "reassigned callable alias" ||
            name === "mutable callable alias"
            ? [
              "module-scope:let-declaration",
              "compute-context:local-reactive-use",
            ]
            : ["compute-context:local-reactive-use"],
        );
    });
  }

  for (const access of [".result", '["result"]']) {
    it(`reports a Wish factory hidden behind ${access} in a helper`, async () => {
      const { diagnostics } = await validateSource(
        `
        import { pattern, computed, wish, type AsyncResult } from "commonfabric";
        function get(): AsyncResult<string> {
          return wish<string>({ query: "#inner" })${access};
        }
        export default pattern(() => ({ value: computed(() => get()) }));
        `,
        { types: { "commonfabric.d.ts": commonfabricTypes } },
      );
      expect(
        diagnostics.filter((item) => item.severity === "error")
          .map((item) => item.type),
      )
        .toEqual(["compute-context:local-reactive-use"]);
    });
  }

  for (const mutatesGetter of [true, false]) {
    it(`${mutatesGetter ? "rejects" : "allows"} a stored Wish getter when a handler mutates ${mutatesGetter ? "that getter" : "an unrelated helper"}`, async () => {
      const { diagnostics } = await validateSource(
        `
        import { pattern, computed, handler, wish, type WishState } from "commonfabric";
        ${identity}
        ${factory}
        function other(v: WishState<string>): WishState<string> { return v; }
        const update = handler<void, {}>(() => {
          for (${mutatesGetter ? "identity" : "other"} of [make]) {}
        });
        export default pattern(() => {
          const request = wish<string>({ query: "#outer" });
          return { value: computed(() => identity(request).result) };
        });
        `,
        { types: { "commonfabric.d.ts": commonfabricTypes } },
      );
      expect(
        diagnostics.filter((item) => item.severity === "error")
          .map((item) => item.type),
      )
        .toEqual(mutatesGetter ? ["compute-context:local-reactive-use"] : []);
    });
  }

  for (const mutation of ["assignment", "for-of"]) {
    for (const mutatesGetter of [true, false]) {
      it(`${mutatesGetter ? "rejects" : "allows"} a Wish getter after ${mutation} destructures into ${mutatesGetter ? "that getter" : "another callable"}`, async () => {
        const target = mutatesGetter ? "identity" : "other";
        const write = mutation === "assignment"
          ? `({ target: ${target} } = { target: make });`
          : `for ({ target: ${target} } of [{ target: make }]) {}`;
        const { diagnostics } = await validateSource(
          `
          import { pattern, computed, handler, wish, type WishState } from "commonfabric";
          ${identity}
          ${factory}
          function other(v: WishState<string>): WishState<string> { return v; }
          const update = handler<void, {}>(() => { ${write} });
          export default pattern(() => {
            const request = wish<string>({ query: "#outer" });
            return { value: computed(() => identity(request).result) };
          });
          `,
          { types: { "commonfabric.d.ts": commonfabricTypes } },
        );
        expect(
          diagnostics.filter(({ severity }) => severity === "error")
            .map(({ type }) => type),
        ).toEqual(
          mutatesGetter ? ["compute-context:local-reactive-use"] : [],
        );
      });
    }
  }
  describe("returnsReactiveResult()", () => {
    it("returns true for a call whose result type is a cell", () => {
      const { checker, call } = analyzeCall("makeCell()");
      expect(returnsReactiveResult(call, checker)).toBe(true);
    });

    it("returns false for a call whose result type is a plain value", () => {
      const { checker, call } = analyzeCall("makeNumber()");
      expect(returnsReactiveResult(call, checker)).toBe(false);
    });
  });

  describe("isStructuralReactiveFactoryExpression()", () => {
    it("returns true for a call whose result type is a cell", () => {
      // `makeCell` is no builder or runtime export, so only the call's cell
      // result type marks it as a reactive factory.
      const { checker, call } = analyzeCall("makeCell()");
      expect(isStructuralReactiveFactoryExpression(call, checker)).toBe(true);
    });

    it("returns false for a call whose result type is a plain value", () => {
      const { checker, call } = analyzeCall("makeNumber()");
      expect(isStructuralReactiveFactoryExpression(call, checker)).toBe(
        false,
      );
    });
  });

  describe("isPatternFactoryCalleeExpression()", () => {
    it("returns true for a callable with argument and result schemas", () => {
      const { checker, call } = analyzeCall("factory({})");
      expect(isPatternFactoryCalleeExpression(call.expression, checker)).toBe(
        true,
      );
    });

    it("returns false for a callable that also has a `with` member", () => {
      const { checker, call } = analyzeCall("boundFactory({})");
      expect(isPatternFactoryCalleeExpression(call.expression, checker)).toBe(
        false,
      );
    });

    it("returns false for a callable without schemas", () => {
      const { checker, call } = analyzeCall("makeNumber()");
      expect(isPatternFactoryCalleeExpression(call.expression, checker)).toBe(
        false,
      );
    });
  });
});
