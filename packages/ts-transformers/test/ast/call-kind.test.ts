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

function findCallInitializer(
  sourceFile: ts.SourceFile,
  declarationName: string,
): ts.CallExpression {
  const initializer = findInitializer(sourceFile, declarationName);
  if (!ts.isCallExpression(initializer)) {
    throw new Error(`Initializer for ${declarationName} is not a call`);
  }
  return initializer;
}

function findNewInitializer(
  sourceFile: ts.SourceFile,
  declarationName: string,
): ts.NewExpression {
  const initializer = findInitializer(sourceFile, declarationName);
  if (!ts.isNewExpression(initializer)) {
    throw new Error(
      `Initializer for ${declarationName} is not a new expression`,
    );
  }
  return initializer;
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

/**
 * A program holding a call through a `const` binding of a `lift()` call
 * (`viaConst`), one through a `let` binding of the same (`viaLet`), and one
 * through a `let` binding of an applied `lift()` call (`viaLetApplied`).
 */
function createLiftBindingProgram() {
  return createProgram(`
    declare function lift<T, U>(callback: (value: T) => U): (input: T) => U;

    const constBound = lift((value: number) => value + 1);
    let letBound = lift((value: number) => value + 1);

    let appliedBound = lift((value: number) => () => value)(1);

    const viaConst = constBound(1);
    const viaLet = letBound(1);
    const viaLetApplied = appliedBound();
  `);
}

describe("call-kind", () => {
  describe("detectCallKind()", () => {
    it("returns the builder kind `pattern` for a `pattern()` imported from `commonfabric`", () => {
      const { sourceFile, checker } = createProgram(`
        import { pattern } from "commonfabric";

        const value = pattern(() => 1);
      `);

      const callKind = detectCallKind(
        findCallInitializer(sourceFile, "value"),
        checker,
      );

      expect(callKind?.kind).toBe("builder");
      expect(callKind?.kind === "builder" ? callKind.builderName : undefined)
        .toBe("pattern");
    });

    it("returns `undefined` for a builder-named import from a foreign module", () => {
      const { sourceFile, checker } = createProgram(`
        import { pattern } from "other-module";

        const value = pattern(() => 1);
      `);

      expect(
        detectCallKind(findCallInitializer(sourceFile, "value"), checker)
          ?.kind,
      ).toBeUndefined();
    });

    it("returns `undefined` for an authored `*WithPattern` call on an untyped receiver", () => {
      // The method resolves to no symbol on `any`, but the node is authored
      // (parser-ranged), so the synthetic-spelling fallback must not claim it:
      // only calls the transformer itself emitted classify by spelling alone.

      const { sourceFile, checker } = createProgram(`
        declare const collection: any;

        const value = collection.mapWithPattern((n: number) => n + 1);
      `);
      const call = findCallInitializer(sourceFile, "value");

      expect(detectCallKind(call, checker)?.kind).toBeUndefined();
      expect(classifyArrayMethodCallSite(call, checker)).toEqual({
        family: "map",
        lowered: true,
        ownership: "plain",
      });
    });

    it("returns the builder kind `lift` for a call through a `const` binding of a `lift()` call", () => {
      const { sourceFile, checker } = createLiftBindingProgram();

      const callKind = detectCallKind(
        findCallInitializer(sourceFile, "viaConst"),
        checker,
      );

      expect(callKind?.kind).toBe("builder");
      expect(callKind?.kind === "builder" ? callKind.builderName : undefined)
        .toBe("lift");
    });

    it("returns `undefined` for a call through a `let` binding of a `lift()` call", () => {
      // The binding can be reassigned, so its call is not a stable builder
      // reference. `lift-applied` would claim the callee is the inner `lift()`
      // call itself, which holds for the initializer and not for this call.

      const { sourceFile, checker } = createLiftBindingProgram();

      expect(
        detectCallKind(findCallInitializer(sourceFile, "viaLet"), checker)
          ?.kind,
      ).toBeUndefined();
    });

    it("returns `undefined` for a call through a `let` binding of an applied `lift()` call", () => {
      const { sourceFile, checker } = createLiftBindingProgram();

      expect(
        detectCallKind(
          findCallInitializer(sourceFile, "viaLetApplied"),
          checker,
        )?.kind,
      ).toBeUndefined();
    });
  });

  describe("detectNewExpressionKind()", () => {
    it("returns `undefined` for an ambient class that is not Common Fabric's", () => {
      const { sourceFile, checker } = createProgram(`
        declare class Stream {
          constructor(value?: unknown);
        }

        const value = new Stream("foreign");
      `);

      expect(
        detectNewExpressionKind(
          findNewInitializer(sourceFile, "value"),
          checker,
        ),
      ).toBeUndefined();
    });

    it("returns the cell factory `Writable` through a local alias of the constructor", () => {
      const { sourceFile, checker } = createProgram(`
        import { Writable } from "commonfabric";

        const LocalWritable = Writable;
        const value = new LocalWritable("aliased");
      `);

      expect(
        detectNewExpressionKind(
          findNewInitializer(sourceFile, "value"),
          checker,
        ),
      ).toEqual({ kind: "cell-factory", factoryName: "Writable" });
    });
  });

  describe("classifyArrayMethodCall()", () => {
    it("returns `undefined` for a prototype-key name, as `detectCallKind()` does", () => {
      const { sourceFile, checker } = createProgram(`
        declare function derive<T>(value: T): T;

        const propertyAccess = derive([1, 2, 3]).constructor((n: number) => n + 1);
        const elementAccess = derive([1, 2, 3])["constructor"]((n: number) => n + 1);
      `);
      const propertyAccess = findCallInitializer(sourceFile, "propertyAccess");
      const elementAccess = findCallInitializer(sourceFile, "elementAccess");

      expect(classifyArrayMethodCall(propertyAccess)).toBeUndefined();
      expect(classifyArrayMethodCall(elementAccess)).toBeUndefined();
      expect(detectCallKind(propertyAccess, checker)?.kind).toBeUndefined();
      expect(detectCallKind(elementAccess, checker)?.kind).toBeUndefined();
    });
  });

  describe("classifyArrayMethodCallSite()", () => {
    it("returns plain ownership for a plain-array `map()` that `detectCallKind()` classifies as `array-method`", () => {
      const { sourceFile, checker } = createProgram(`
        interface Array<T> {
          map<U>(callback: (value: T) => U): U[];
        }

        const value = [1, 2, 3].map((n: number) => n + 1);
      `);
      const call = findCallInitializer(sourceFile, "value");

      expect(detectCallKind(call, checker)?.kind).toBe("array-method");
      expect(classifyArrayMethodCallSite(call, checker)).toEqual({
        family: "map",
        lowered: false,
        ownership: "plain",
      });
      expect(classifyArrayCallbackContainerCall(call, checker)).toBe(
        "plain-array-value",
      );
    });

    it("returns reactive ownership for a reactive receiver", () => {
      const { sourceFile, checker } = createProgram(`
        declare function computed<T>(callback: () => T): T;

        const value = computed(() => [1, 2, 3]).map((n: number) => n + 1);
      `);
      const call = findCallInitializer(sourceFile, "value");

      expect(classifyArrayMethodCallSite(call, checker)).toEqual({
        family: "map",
        lowered: false,
        ownership: "reactive",
      });
      expect(classifyArrayCallbackContainerCall(call, checker)).toBe(
        "reactive-array-method",
      );
    });

    it("returns reactive ownership for a lowered `*WithPattern` method on a reactive receiver", () => {
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
      const call = findCallInitializer(sourceFile, "value");

      expect(classifyArrayMethodCallSite(call, checker)).toEqual({
        family: "map",
        lowered: true,
        ownership: "reactive",
      });
      expect(classifyArrayCallbackContainerCall(call, checker)).toBe(
        "reactive-array-method",
      );
    });

    it("returns plain ownership for a custom `*WithPattern` method on a receiver that is not a cell", () => {
      const { sourceFile, checker } = createProgram(`
        declare const collection: {
          mapWithPattern<U>(callback: (value: number) => U): U[];
        };

        const value = collection.mapWithPattern((n: number) => n + 1);
      `);
      const call = findCallInitializer(sourceFile, "value");

      expect(detectCallKind(call, checker)?.kind).toBeUndefined();
      expect(classifyArrayMethodCallSite(call, checker)).toEqual({
        family: "map",
        lowered: true,
        ownership: "plain",
      });
      expect(classifyArrayCallbackContainerCall(call, checker))
        .toBeUndefined();
    });
  });

  describe("classifyArrayCallbackContainerCall()", () => {
    it("returns `plain-array-value` for a reactive `map()` consumed by a terminal `join()`", () => {
      const { sourceFile, checker } = createProgram(`
        declare function computed<T>(callback: () => T): T;

        const value = computed(() => ["a", "b", "c"])
          .map((n: string) => n.toUpperCase())
          .join(", ");
      `);
      const join = findCallInitializer(sourceFile, "value");
      if (!ts.isPropertyAccessExpression(join.expression)) {
        throw new Error("Expected a property-access callee for join");
      }
      const receiver = join.expression.expression;
      if (!ts.isCallExpression(receiver)) {
        throw new Error("Expected the join receiver to be a call");
      }

      expect(classifyArrayMethodCallSite(receiver, checker)).toEqual({
        family: "map",
        lowered: false,
        ownership: "reactive",
      });
      expect(classifyArrayCallbackContainerCall(receiver, checker)).toBe(
        "plain-array-value",
      );
    });

    it("returns `plain-array-value` for a value-returning callback of a plain-array method other than `map()`", () => {
      const { sourceFile, checker } = createProgram(`
        interface Array<T> {
          find(
            callback: (value: T) => boolean,
          ): T | undefined;
        }

        const value = [1, 2, 3].find((n: number) => n > 1);
      `);

      expect(
        classifyArrayCallbackContainerCall(
          findCallInitializer(sourceFile, "value"),
          checker,
        ),
      ).toBe("plain-array-value");
    });

    it("returns `plain-array-void` for a void callback of a plain-array method", () => {
      const { sourceFile, checker } = createProgram(`
        interface Array<T> {
          forEach(callback: (value: T) => void): void;
        }

        const value = [1, 2, 3].forEach((n: number) => console.log(n));
      `);

      expect(
        classifyArrayCallbackContainerCall(
          findCallInitializer(sourceFile, "value"),
          checker,
        ),
      ).toBe("plain-array-void");
    });
  });

  describe("getPatternBuilderCallbackArgument()", () => {
    it("returns the callback of an unresolved property-access `pattern()` call", () => {
      const { sourceFile, checker } = createProgram(`
        const builders = {} as any;
        const value = builders.pattern((input: unknown) => input);
      `);
      const call = findCallInitializer(sourceFile, "value");

      expect(getPatternBuilderCallbackArgument(call, checker)).toBe(
        call.arguments[0],
      );
    });
  });

  describe("getCapabilitySummaryCallbackArgument()", () => {
    it("returns the callback of a `computed()` call and of an `action()` call", () => {
      const { sourceFile, checker } = createProgram(`
        declare function computed<T>(callback: () => T): T;
        declare function action<T>(callback: () => T): T;

        const computedValue = computed(() => 1);
        const actionValue = action(() => 2);
      `);
      const computedCall = findCallInitializer(sourceFile, "computedValue");
      const actionCall = findCallInitializer(sourceFile, "actionValue");

      expect(getCapabilitySummaryCallbackArgument(computedCall, checker)).toBe(
        computedCall.arguments[0],
      );
      expect(getCapabilitySummaryCallbackArgument(actionCall, checker)).toBe(
        actionCall.arguments[0],
      );
    });
  });

  describe("getLiftAppliedInputAndCallback()", () => {
    it("returns the input and callback of an applied `lift()` call, and `undefined` for an unapplied one", () => {
      const { sourceFile, checker } = createProgram(`
        declare function lift<T, U>(callback: (value: T) => U): (input: T) => U;

        const first = lift((value: number) => value + 1)(1);
        const second = lift((value: number) => value + 2)(1);
        const third = lift((value: number) => value + 3);
      `);

      const firstArgs = getLiftAppliedInputAndCallback(
        findCallInitializer(sourceFile, "first"),
        checker,
      );
      const secondArgs = getLiftAppliedInputAndCallback(
        findCallInitializer(sourceFile, "second"),
        checker,
      );
      // `third` is `lift(cb)` with no input applied, so it is not the
      // lift-applied shape.
      const thirdArgs = getLiftAppliedInputAndCallback(
        findCallInitializer(sourceFile, "third"),
        checker,
      );

      expect(firstArgs?.input.getText()).toBe("1");
      expect(firstArgs?.callback.parameters[0]?.name.getText()).toBe("value");
      expect(secondArgs?.input.getText()).toBe("1");
      expect(secondArgs?.callback.parameters[0]?.name.getText()).toBe("value");
      expect(thirdArgs).toBeUndefined();
    });

    it("returns `undefined` for a call through a `let` binding of a `lift()` call", () => {
      const { sourceFile, checker } = createLiftBindingProgram();

      expect(
        getLiftAppliedInputAndCallback(
          findCallInitializer(sourceFile, "viaLet"),
          checker,
        ),
      ).toBeUndefined();
    });

    it("returns `undefined` for a call through a `let` binding of an applied `lift()` call", () => {
      const { sourceFile, checker } = createLiftBindingProgram();

      expect(
        getLiftAppliedInputAndCallback(
          findCallInitializer(sourceFile, "viaLetApplied"),
          checker,
        ),
      ).toBeUndefined();
    });
  });

  describe("getWithPatternHoistablePatternCall()", () => {
    it("returns the pattern call argument of a synthetic `mapWithPattern()` call, and `undefined` for an authored one", () => {
      const { sourceFile, checker } = createProgram(`
        declare const items: any;
        declare const make: { pattern(body: () => number): number };

        const value = items.mapWithPattern(make.pattern(() => 1), { p: 1 });
      `);
      const authored = findCallInitializer(sourceFile, "value");
      const synthetic = ts.factory.updateCallExpression(
        authored,
        ts.factory.createPropertyAccessExpression(
          ts.factory.createIdentifier("items"),
          "mapWithPattern",
        ),
        authored.typeArguments,
        authored.arguments,
      );

      expect(getWithPatternHoistablePatternCall(authored, checker))
        .toBeUndefined();
      expect(getWithPatternHoistablePatternCall(synthetic, checker)?.getText())
        .toBe("make.pattern(() => 1)");
    });

    it("returns `undefined` when the first argument is not a pattern call", () => {
      const { sourceFile, checker } = createProgram(`
        declare const items: any;
        declare function plain(body: () => number): number;

        const value = items.mapWithPattern(plain(() => 1), { p: 1 });
      `);

      expect(
        getWithPatternHoistablePatternCall(
          findCallInitializer(sourceFile, "value"),
          checker,
        ),
      ).toBeUndefined();
    });
  });

  describe("resolveCallbackFunctionExpression()", () => {
    it("returns the authored arrow through a `satisfies` cast", () => {
      // `satisfies T` states a constraint and leaves the value alone, so it
      // hides a callback no more than `as T` or parentheses do. Callers that
      // ask "is this argument the callback?" must answer yes through every one
      // of those spellings, and callers that go on to use the returned node as
      // an anchor need the authored arrow itself, not a wrapper standing in
      // front of it.

      const { sourceFile, checker } = createProgram(`
        type Handler = (event: { word: string }, state: { count: number }) => void;

        const value = ((event, state) => {}) satisfies Handler;
      `);
      const expression = findInitializer(sourceFile, "value");
      if (!ts.isSatisfiesExpression(expression)) {
        throw new Error("Expected a satisfies expression initializer");
      }

      expect(resolveCallbackFunctionExpression(expression, checker)).toBe(
        findFirstArrowFunction(sourceFile),
      );
    });

    it("returns the authored arrow through a `satisfies`-wrapped alias initializer", () => {
      // The alias is annotated `any`, so the type carries no call signatures
      // and the only route to the callback is the syntactic one: identifier to
      // variable initializer, then through the wrapper.

      const { sourceFile, checker } = createProgram(`
        type Handler = (event: { word: string }, state: { count: number }) => void;

        const callback: any = ((event, state) => {}) satisfies Handler;

        const value = callback;
      `);
      const expression = findInitializer(sourceFile, "value");
      if (!ts.isIdentifier(expression)) {
        throw new Error("Expected an identifier initializer");
      }

      expect(resolveCallbackFunctionExpression(expression, checker)).toBe(
        findFirstArrowFunction(sourceFile),
      );
    });

    it("returns the authored arrow through a partially emitted expression", () => {
      // A PartiallyEmittedExpression cannot arise here — the pipeline
      // transforms authored source through `ts.transform`, never as part of
      // TypeScript's emit — so this pins a choice rather than guards a
      // reachable path: classification reads the same wrapper set as every
      // other resolver in the package, and narrowing it back to a local subset
      // fails here first. The node is built directly because nothing in the
      // corpus produces one.

      const { sourceFile, checker } = createProgram(`
        const value = (event, state) => {};
      `);
      const arrow = findFirstArrowFunction(sourceFile);
      const wrapped = ts.factory.createPartiallyEmittedExpression(arrow);

      expect(resolveCallbackFunctionExpression(wrapped, checker)).toBe(arrow);
    });
  });
});
