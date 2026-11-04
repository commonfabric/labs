import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";

import ts from "typescript";

import {
  classifyArrayMethodResultSinkCall,
  detectCallKind,
  isReactiveOriginCall,
} from "../../src/ast/mod.ts";
import { analyzeExpression } from "./harness.ts";

function getCallExpression(
  source: string,
  options?: Parameters<typeof analyzeExpression>[1],
) {
  const { expression, checker } = analyzeExpression(source, options);
  assert(ts.isCallExpression(expression), "Expected a call expression");
  return { call: expression, checker };
}

describe("data flow analyzer", () => {
  it("marks ifElse predicate for selective rewriting", () => {
    const { analysis } = analyzeExpression(
      "ifElse(state.count > 3, 'hi', 'bye')",
    );

    assert(
      analysis.rewriteHint && analysis.rewriteHint.kind === "call-if-else",
    );
    assertEquals(
      analysis.rewriteHint.predicate.getText(),
      "state.count > 3",
    );
  });

  // A transparent wrapper is analyzed as the expression it wraps, so the hint
  // the inner analysis produced reaches the caller. A spelling not named there
  // falls to the generic child walk, which merges through `mergeAnalyses` and
  // hardcodes `rewriteHint: undefined` — the hint is lost silently.
  for (
    const [name, wrap] of Object.entries({
      parenthesized: (inner: string) => `(${inner})`,
      "as-cast": (inner: string) => `(${inner}) as never`,
      satisfies: (inner: string) => `(${inner}) satisfies unknown`,
      "non-null": (inner: string) => `(${inner})!`,
    })
  ) {
    it(`keeps the ifElse hint through a ${name} wrapper`, () => {
      const { analysis } = analyzeExpression(
        wrap("ifElse(state.count > 3, 'hi', 'bye')"),
      );

      assert(
        analysis.rewriteHint && analysis.rewriteHint.kind === "call-if-else",
      );
      assertEquals(analysis.rewriteHint.predicate.getText(), "state.count > 3");
    });
  }

  it("identifies array map calls that should skip wrapping", () => {
    const { analysis } = analyzeExpression(
      "state.items.map(item => item + state.count)",
    );

    assert(
      analysis.rewriteHint && analysis.rewriteHint.kind === "skip-call-rewrite",
    );
    assertEquals(analysis.rewriteHint.reason, "array-method");
  });

  it("does not treat custom map methods as array-method rewrite hints", () => {
    const { analysis } = analyzeExpression(
      "collection.map((item) => item + state.count)",
      {
        prelude: `
declare const collection: {
  map<T>(fn: (item: number) => T): T[];
};
        `,
      },
    );

    assertEquals(analysis.rewriteHint, undefined);
  });

  it("recognizes ifElse when called via alias", () => {
    const { analysis } = analyzeExpression(
      "aliasIfElse(state.count > 3, 'hi', 'bye')",
      { prelude: "declare const aliasIfElse: typeof ifElse;" },
    );

    assert(
      analysis.rewriteHint && analysis.rewriteHint.kind === "call-if-else",
    );
  });

  it("recognizes builders when called via alias", () => {
    const { analysis } = analyzeExpression(
      "aliasPattern(() => state.count)",
      { prelude: "declare const aliasPattern: typeof pattern;" },
    );

    assert(
      analysis.rewriteHint && analysis.rewriteHint.kind === "skip-call-rewrite",
    );
    assertEquals(analysis.rewriteHint.reason, "builder");
  });

  it("does not classify a shadowed local derive helper as reactive", () => {
    const { call, checker } = getCallExpression(
      "derive(() => 1)",
      {
        prelude: "function derive<T>(fn: () => T): T { return fn(); }",
      },
    );

    assertEquals(detectCallKind(call, checker), undefined);
    assertEquals(isReactiveOriginCall(call, checker), false);
  });

  it("does not classify a shadowed property helper named ifElse", () => {
    const { call, checker } = getCallExpression(
      "helpers.ifElse(state.count > 3, 'hi', 'bye')",
      {
        prelude: `
declare const helpers: {
  ifElse<T>(predicate: boolean, whenTrue: T, whenFalse: T): T;
};
        `,
      },
    );

    assertEquals(detectCallKind(call, checker), undefined);
  });

  it("does not classify plain object map methods as reactive array calls", () => {
    const { call, checker } = getCallExpression(
      "collection.map((item) => item + 1)",
      {
        prelude: `
declare const collection: {
  map<T>(fn: (item: number) => T): T[];
};
        `,
      },
    );

    assertEquals(detectCallKind(call, checker), undefined);
  });

  it("does not classify custom map(...).join(...) chains as array sinks", () => {
    const { call, checker } = getCallExpression(
      'collection.map((item) => item + 1).join(",")',
      {
        prelude: `
declare const collection: {
  map<T>(fn: (item: number) => T): {
    join(separator: string): string;
  };
};
        `,
      },
    );

    assertEquals(classifyArrayMethodResultSinkCall(call, checker), undefined);
  });

  it("recognizes a fetchJson call carrying a result argument as a reactive origin call", () => {
    const { call, checker } = getCallExpression(
      'fetchJson({ url: "https://example.com", result: [] })',
      {
        prelude:
          "declare function fetchJson<T>(args: { url: string; result: T }): T;",
      },
    );

    assertEquals(detectCallKind(call, checker)?.kind, "runtime-call");
    assertEquals(isReactiveOriginCall(call, checker), true);
  });

  for (const name of ["fetchBinary", "fetchText", "fetchJson"]) {
    it(`recognizes ${name} as a reactive origin call`, () => {
      const { call, checker } = getCallExpression(
        `${name}({ url: "https://example.com" })`,
        {
          prelude: `declare function ${name}(args: { url: string }): unknown;`,
        },
      );

      assertEquals(detectCallKind(call, checker)?.kind, "runtime-call");
      assertEquals(isReactiveOriginCall(call, checker), true);
    });
  }
});
