import { assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import {
  classifyArrayCallbackContainerCall,
  classifyArrayMethodCall,
  classifyArrayMethodCallSite,
  detectCallKind,
  detectNewExpressionKind,
  getCapabilitySummaryCallbackArgument,
  getLiftAppliedInputAndCallback,
  getPatternBuilderCallbackArgument,
  resolveCallbackFunctionExpression,
} from "../../src/ast/mod.ts";
import { getWithPatternHoistablePatternCall } from "../../src/ast/call-kind.ts";

function createProgram(source: string): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
} {
  const fileName = "/test.ts";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
    skipLibCheck: true,
  };

  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    compilerOptions.target!,
    true,
  );

  const host = ts.createCompilerHost(compilerOptions, true);
  host.getSourceFile = (name) => name === fileName ? sourceFile : undefined;
  host.getCurrentDirectory = () => "/";
  host.getDirectories = () => [];
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => name === fileName ? source : undefined;
  host.writeFile = () => {};
  host.useCaseSensitiveFileNames = () => true;
  host.getCanonicalFileName = (name) => name;
  host.getNewLine = () => "\n";

  const program = ts.createProgram([fileName], compilerOptions, host);
  return { sourceFile, checker: program.getTypeChecker() };
}

function findInitializer(
  sourceFile: ts.SourceFile,
  declarationName: string,
): ts.Expression {
  let found: ts.Expression | undefined;

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === declarationName &&
      node.initializer
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (!found) {
    throw new Error(`Initializer for ${declarationName} not found`);
  }

  return found;
}

function findFirstArrowFunction(sourceFile: ts.SourceFile): ts.ArrowFunction {
  let found: ts.ArrowFunction | undefined;

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isArrowFunction(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (!found) {
    throw new Error("Arrow function not found");
  }

  return found;
}

Deno.test("detectCallKind keeps array-method as a family classification while call-site ownership distinguishes plain arrays", () => {
  const { sourceFile, checker } = createProgram(`
    interface Array<T> {
      map<U>(callback: (value: T) => U): U[];
    }

    const value = [1, 2, 3].map((n: number) => n + 1);
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isCallExpression(expression)) {
    throw new Error("Expected call expression initializer");
  }

  assertEquals(detectCallKind(expression, checker)?.kind, "array-method");
  assertEquals(classifyArrayMethodCallSite(expression, checker), {
    family: "map",
    lowered: false,
    ownership: "plain",
  });
  assertEquals(
    classifyArrayCallbackContainerCall(expression, checker),
    "plain-array-value",
  );
});

Deno.test("classifyArrayMethodCallSite reports reactive ownership for reactive receivers", () => {
  const { sourceFile, checker } = createProgram(`
    declare function computed<T>(callback: () => T): T;

    const value = computed(() => [1, 2, 3]).map((n: number) => n + 1);
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isCallExpression(expression)) {
    throw new Error("Expected call expression initializer");
  }

  assertEquals(classifyArrayMethodCallSite(expression, checker), {
    family: "map",
    lowered: false,
    ownership: "reactive",
  });
  assertEquals(
    classifyArrayCallbackContainerCall(expression, checker),
    "reactive-array-method",
  );
});

Deno.test("classifyArrayCallbackContainerCall downgrades reactive array callbacks consumed by terminal chains", () => {
  const { sourceFile, checker } = createProgram(`
    declare function computed<T>(callback: () => T): T;

    const value = computed(() => ["a", "b", "c"])
      .map((n: string) => n.toUpperCase())
      .join(", ");
  `);

  const expression = findInitializer(sourceFile, "value");
  if (
    !ts.isCallExpression(expression) ||
    !ts.isPropertyAccessExpression(expression.expression)
  ) {
    throw new Error("Expected join call expression initializer");
  }

  const receiver = expression.expression.expression;
  if (!ts.isCallExpression(receiver)) {
    throw new Error("Expected join receiver to be a call expression");
  }

  assertEquals(classifyArrayMethodCallSite(receiver, checker), {
    family: "map",
    lowered: false,
    ownership: "reactive",
  });
  assertEquals(
    classifyArrayCallbackContainerCall(receiver, checker),
    "plain-array-value",
  );
});

Deno.test("classifyArrayMethodCallSite treats lowered *WithPattern methods as reactive when the receiver is reactive", () => {
  const { sourceFile, checker } = createProgram(`
    declare const CELL_BRAND: unique symbol;
    type BrandedCell<T, Brand extends string> = {
      readonly [CELL_BRAND]: Brand;
    };

    interface OpaqueCell<T> extends BrandedCell<T, "opaque"> {
      mapWithPattern<U>(callback: (value: any) => U): U[];
    }

    declare const items: OpaqueCell<number[]>;

    const value = items.mapWithPattern((n: number) => n + 1);
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isCallExpression(expression)) {
    throw new Error("Expected call expression initializer");
  }

  assertEquals(classifyArrayMethodCallSite(expression, checker), {
    family: "map",
    lowered: true,
    ownership: "reactive",
  });
  assertEquals(
    classifyArrayCallbackContainerCall(expression, checker),
    "reactive-array-method",
  );
});

Deno.test("classifyArrayMethodCallSite does not mark custom lowered *WithPattern methods reactive by name alone", () => {
  const { sourceFile, checker } = createProgram(`
    declare const collection: {
      mapWithPattern<U>(callback: (value: number) => U): U[];
    };

    const value = collection.mapWithPattern((n: number) => n + 1);
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isCallExpression(expression)) {
    throw new Error("Expected call expression initializer");
  }

  assertEquals(detectCallKind(expression, checker), undefined);
  assertEquals(classifyArrayMethodCallSite(expression, checker), {
    family: "map",
    lowered: true,
    ownership: "plain",
  });
  assertEquals(
    classifyArrayCallbackContainerCall(expression, checker),
    undefined,
  );
});

Deno.test("an authored *WithPattern call on an untyped receiver keeps no call kind", () => {
  const { sourceFile, checker } = createProgram(`
    declare const collection: any;

    const value = collection.mapWithPattern((n: number) => n + 1);
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isCallExpression(expression)) {
    throw new Error("Expected call expression initializer");
  }

  // The method resolves to no symbol on \`any\`, but the node is authored
  // (parser-ranged), so the synthetic-spelling fallback must not claim it —
  // only calls the transformer itself emitted classify by spelling alone.
  assertEquals(detectCallKind(expression, checker), undefined);
  assertEquals(classifyArrayMethodCallSite(expression, checker), {
    family: "map",
    lowered: true,
    ownership: "plain",
  });
});

Deno.test("array method classification ignores prototype-key names", () => {
  const { sourceFile, checker } = createProgram(`
    declare function derive<T>(value: T): T;

    const propertyAccess = derive([1, 2, 3]).constructor((n: number) => n + 1);
    const elementAccess = derive([1, 2, 3])["constructor"]((n: number) => n + 1);
  `);

  const propertyAccess = findInitializer(sourceFile, "propertyAccess");
  const elementAccess = findInitializer(sourceFile, "elementAccess");
  if (
    !ts.isCallExpression(propertyAccess) ||
    !ts.isCallExpression(elementAccess)
  ) {
    throw new Error("Expected call expression initializers");
  }

  assertEquals(classifyArrayMethodCall(propertyAccess), undefined);
  assertEquals(classifyArrayMethodCall(elementAccess), undefined);
  assertEquals(detectCallKind(propertyAccess, checker), undefined);
  assertEquals(detectCallKind(elementAccess, checker), undefined);
});

Deno.test("constructor classification ignores non-Common-Fabric ambient classes", () => {
  const { sourceFile, checker } = createProgram(`
    declare class Stream {
      constructor(value?: unknown);
    }

    const value = new Stream("foreign");
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isNewExpression(expression)) {
    throw new Error("Expected new expression initializer");
  }

  assertEquals(detectNewExpressionKind(expression, checker), undefined);
});

Deno.test("constructor classification follows local Common-Fabric constructor aliases", () => {
  const { sourceFile, checker } = createProgram(`
    import { Writable } from "commonfabric";

    const LocalWritable = Writable;
    const value = new LocalWritable("aliased");
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isNewExpression(expression)) {
    throw new Error("Expected new expression initializer");
  }

  assertEquals(detectNewExpressionKind(expression, checker), {
    kind: "cell-factory",
    factoryName: "Writable",
  });
});

Deno.test("classifyArrayCallbackContainerCall recognizes plain value-returning non-map array callbacks", () => {
  const { sourceFile, checker } = createProgram(`
    interface Array<T> {
      find(
        callback: (value: T) => boolean,
      ): T | undefined;
    }

    const value = [1, 2, 3].find((n: number) => n > 1);
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isCallExpression(expression)) {
    throw new Error("Expected call expression initializer");
  }

  assertEquals(
    classifyArrayCallbackContainerCall(expression, checker),
    "plain-array-value",
  );
});

Deno.test("classifyArrayCallbackContainerCall recognizes plain void array callbacks", () => {
  const { sourceFile, checker } = createProgram(`
    interface Array<T> {
      forEach(callback: (value: T) => void): void;
    }

    const value = [1, 2, 3].forEach((n: number) => console.log(n));
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isCallExpression(expression)) {
    throw new Error("Expected call expression initializer");
  }

  assertEquals(
    classifyArrayCallbackContainerCall(expression, checker),
    "plain-array-void",
  );
});

Deno.test("getPatternBuilderCallbackArgument preserves unresolved property-access pattern fallback", () => {
  const { sourceFile, checker } = createProgram(`
    const builders = {} as any;
    const value = builders.pattern((input: unknown) => input);
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isCallExpression(expression)) {
    throw new Error("Expected call expression initializer");
  }

  const callback = getPatternBuilderCallbackArgument(expression, checker);
  if (!callback) {
    throw new Error("Expected pattern callback argument");
  }

  assertEquals(ts.isArrowFunction(callback), true);
});

Deno.test("getCapabilitySummaryCallbackArgument recognizes builder callback families", () => {
  const { sourceFile, checker } = createProgram(`
    declare function computed<T>(callback: () => T): T;
    declare function action<T>(callback: () => T): T;

    const third = computed(() => 1);
    const fourth = action(() => 2);
  `);

  const third = findInitializer(sourceFile, "third");
  const fourth = findInitializer(sourceFile, "fourth");

  if (
    !ts.isCallExpression(third) || !ts.isCallExpression(fourth)
  ) {
    throw new Error("Expected call expression initializers");
  }

  assertEquals(!!getCapabilitySummaryCallbackArgument(third, checker), true);
  assertEquals(!!getCapabilitySummaryCallbackArgument(fourth, checker), true);
});

Deno.test("getLiftAppliedInputAndCallback recognizes lift-applied input positions", () => {
  const { sourceFile, checker } = createProgram(`
    declare function lift<T, U>(callback: (value: T) => U): (input: T) => U;

    const first = lift((value: number) => value + 1)(1);
    const second = lift((value: number) => value + 2)(1);
    const third = lift((value: number) => value + 3);
  `);

  const first = findInitializer(sourceFile, "first");
  const second = findInitializer(sourceFile, "second");
  const third = findInitializer(sourceFile, "third");

  if (
    !ts.isCallExpression(first) ||
    !ts.isCallExpression(second) ||
    !ts.isCallExpression(third)
  ) {
    throw new Error("Expected call expression initializers");
  }

  const firstArgs = getLiftAppliedInputAndCallback(first, checker);
  const secondArgs = getLiftAppliedInputAndCallback(second, checker);
  // `third` is just `lift(cb)` — NOT applied to an input — so it is not the
  // lift-applied shape and yields undefined.
  const thirdArgs = getLiftAppliedInputAndCallback(third, checker);

  assertEquals(firstArgs?.input.getText(), "1");
  assertEquals(firstArgs?.callback.parameters[0]?.name.getText(), "value");
  assertEquals(secondArgs?.input.getText(), "1");
  assertEquals(secondArgs?.callback.parameters[0]?.name.getText(), "value");
  assertEquals(thirdArgs, undefined);
});

Deno.test("getWithPatternHoistablePatternCall returns the bare pattern call argument", () => {
  const { sourceFile, checker } = createProgram(`
    declare const items: any;
    declare const make: { pattern(body: () => number): number };

    const value = items.mapWithPattern(make.pattern(() => 1), { p: 1 });
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isCallExpression(expression)) {
    throw new Error("Expected call expression initializer");
  }

  assertEquals(
    getWithPatternHoistablePatternCall(expression, checker),
    undefined,
  );
  const synthetic = ts.factory.updateCallExpression(
    expression,
    ts.factory.createPropertyAccessExpression(
      ts.factory.createIdentifier("items"),
      "mapWithPattern",
    ),
    expression.typeArguments,
    expression.arguments,
  );
  const hoistable = getWithPatternHoistablePatternCall(synthetic, checker);
  assertEquals(hoistable?.getText(), "make.pattern(() => 1)");
});

Deno.test("getWithPatternHoistablePatternCall ignores a first argument that is not a pattern call", () => {
  const { sourceFile, checker } = createProgram(`
    declare const items: any;
    declare function plain(body: () => number): number;

    const value = items.mapWithPattern(plain(() => 1), { p: 1 });
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isCallExpression(expression)) {
    throw new Error("Expected call expression initializer");
  }

  assertEquals(
    getWithPatternHoistablePatternCall(expression, checker),
    undefined,
  );
});

Deno.test("detectCallKind resolves a pattern builder imported from commonfabric", () => {
  const { sourceFile, checker } = createProgram(`
    import { pattern } from "commonfabric";

    const value = pattern(() => 1);
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isCallExpression(expression)) {
    throw new Error("Expected call expression initializer");
  }

  const kind = detectCallKind(expression, checker);
  assertEquals(kind?.kind, "builder");
  assertEquals(
    kind?.kind === "builder" ? kind.builderName : undefined,
    "pattern",
  );
});

Deno.test("detectCallKind ignores a builder-named import from a foreign module", () => {
  const { sourceFile, checker } = createProgram(`
    import { pattern } from "other-module";

    const value = pattern(() => 1);
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isCallExpression(expression)) {
    throw new Error("Expected call expression initializer");
  }

  assertEquals(detectCallKind(expression, checker), undefined);
});

Deno.test("resolveCallbackFunctionExpression sees through a `satisfies` cast", () => {
  // `satisfies T` states a constraint and leaves the value alone, so it hides
  // a callback no more than `as T` or parentheses do. Callers that ask "is
  // this argument the callback?" must answer yes through every one of those
  // spellings, and callers that go on to use the returned node as an anchor
  // need the authored arrow itself, not a wrapper standing in front of it.
  const { sourceFile, checker } = createProgram(`
    type Handler = (event: { word: string }, state: { count: number }) => void;

    const value = ((event, state) => {}) satisfies Handler;
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isSatisfiesExpression(expression)) {
    throw new Error("Expected satisfies expression initializer");
  }

  assertEquals(
    resolveCallbackFunctionExpression(expression, checker),
    findFirstArrowFunction(sourceFile),
  );
});

Deno.test("resolveCallbackFunctionExpression sees through a `satisfies`-wrapped alias initializer", () => {
  // The alias is annotated `any`, so the type carries no call signatures and
  // the only route to the callback is the syntactic one: identifier to
  // variable initializer, then through the wrapper.
  const { sourceFile, checker } = createProgram(`
    type Handler = (event: { word: string }, state: { count: number }) => void;

    const callback: any = ((event, state) => {}) satisfies Handler;

    const value = callback;
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isIdentifier(expression)) {
    throw new Error("Expected identifier initializer");
  }

  assertEquals(
    resolveCallbackFunctionExpression(expression, checker),
    findFirstArrowFunction(sourceFile),
  );
});

Deno.test("resolveCallbackFunctionExpression takes the shared helper's whole wrapper set", () => {
  // A PartiallyEmittedExpression cannot arise here — the pipeline transforms
  // authored source through `ts.transform`, never as part of TypeScript's
  // emit — so this pins a choice rather than guards a reachable path:
  // classification reads the same wrapper set as every other resolver in the
  // package, and narrowing it back to a local subset fails here first. The
  // node is built directly because nothing in the corpus produces one.
  const { sourceFile, checker } = createProgram(`
    const value = (event, state) => {};
  `);

  const arrow = findFirstArrowFunction(sourceFile);
  const wrapped = ts.factory.createPartiallyEmittedExpression(arrow);

  assertEquals(resolveCallbackFunctionExpression(wrapped, checker), arrow);
});

describe("call-kind", () => {
  describe("a call through a binding of a `lift()` call", () => {
    // `lift-applied` describes a call whose callee is the inner `lift()` call
    // itself. Here the callee is the binding, so that kind never applies; the
    // `const` case shows the harness resolves `lift` as a builder at all.

    function findBindingCall(declarationName: string) {
      const { sourceFile, checker } = createProgram(`
        declare function lift<T, U>(
          callback: (value: T) => U,
        ): (input: T) => U;

        const constBound = lift((value: number) => value + 1);
        let letBound = lift((value: number) => value + 1);

        const viaConst = constBound(1);
        const viaLet = letBound(1);
      `);
      const call = findInitializer(sourceFile, declarationName);
      if (!ts.isCallExpression(call)) {
        throw new Error(`Expected ${declarationName} to be a call`);
      }
      return { call, checker };
    }

    it("returns the builder kind `lift` from `detectCallKind()` for a `const` binding", () => {
      const { call, checker } = findBindingCall("viaConst");
      const callKind = detectCallKind(call, checker);

      expect(callKind?.kind).toBe("builder");
      expect(callKind?.kind === "builder" ? callKind.builderName : undefined)
        .toBe("lift");
    });

    it("returns `undefined` from `detectCallKind()` for a `let` binding", () => {
      const { call, checker } = findBindingCall("viaLet");

      expect(detectCallKind(call, checker)?.kind).toBeUndefined();
    });

    it("returns `undefined` from `getLiftAppliedInputAndCallback()` for a `let` binding", () => {
      const { call, checker } = findBindingCall("viaLet");

      expect(getLiftAppliedInputAndCallback(call, checker)).toBeUndefined();
    });
  });
});
