import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import {
  classifyArrayCallbackContainerCall,
  classifyArrayMethodCall,
  classifyArrayMethodCallSite,
  classifyArrayMethodResultSinkCall,
  classifyWildcardTraversalCall,
  detectCallKind,
  detectNewExpressionKind,
  getCapabilitySummaryCallbackArgument,
  getLiftAppliedInputAndCallback,
  getPatternBuilderCallbackArgument,
  resolveCallbackFunctionExpression,
} from "../../src/ast/mod.ts";
import {
  getWithPatternHoistablePatternCall,
  isCallbackReference,
  isCollectingPlainArrayMethodCallback,
  isHandlerAppliedCall,
  isReactiveValueExpression,
} from "../../src/ast/call-kind.ts";

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
 * `call` with its callee replaced by a synthetic `items.<method>` access, as
 * the closure stage emits for a lowered array method, and its arguments
 * replaced by `args` when given.
 */
function withSyntheticCallee(
  call: ts.CallExpression,
  method: string,
  args: readonly ts.Expression[] = call.arguments,
): ts.CallExpression {
  return ts.factory.updateCallExpression(
    call,
    ts.factory.createPropertyAccessExpression(
      ts.factory.createIdentifier("items"),
      method,
    ),
    call.typeArguments,
    args,
  );
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

/**
 * A program holding builder calls applied once (`appliedOnce`,
 * `aliasAppliedOnce`, `handlerApplied`), calls of what an application returned
 * (`overApplied`, `viaAppliedResult`, `handlerOverApplied`), a call through a
 * binding of a `handler()` factory (`viaBoundHandler`), and a call of what an
 * `ifElse()` call returned (`viaIfElseResult`).
 */
function createApplicationProgram() {
  return createProgram(`
    declare function lift<T, U>(callback: (value: T) => U): (input: T) => U;
    declare function handler<E, S>(
      callback: (event: E, state: S) => void,
    ): (state: S) => () => void;
    declare function ifElse<T>(condition: boolean, ifTrue: T, ifFalse: T): T;

    const liftAlias = lift;
    const appliedResult = lift((value: number) => () => value)(1);
    const boundHandler = handler((event: unknown, state: {}) => {});

    const appliedOnce = lift((value: number) => value + 1)(1);
    const aliasAppliedOnce = liftAlias((value: number) => value + 1)(1);
    const overApplied = lift((value: number) => () => value)(1)();
    const viaAppliedResult = appliedResult();
    const viaBoundHandler = boundHandler({});
    const viaIfElseResult = ifElse(true, () => 1, () => 2)();
    const handlerApplied = handler((event: unknown, state: {}) => {})({});
    const handlerOverApplied = handler((event: unknown, state: {}) => {})({})();
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
    it("returns the builder kind `lift` for a mapped-type member typed as `lift`", () => {
      // A member of a mapped type has no declaration of its own, so its kind
      // comes from the declaration of its call signature.

      const { sourceFile, checker } = createProgram(`
        declare function lift<T, U>(callback: (value: T) => U): (input: T) => U;
        declare const helpers: { [K in "make"]: typeof lift };
        declare const others: {
          [K in "make"]: (callback: (value: number) => number) => number;
        };

        const value = helpers.make((value: number) => value);
        const plain = others.make((value: number) => value);
      `);

      const callKind = detectCallKind(
        findCallInitializer(sourceFile, "value"),
        checker,
      );

      expect(callKind?.kind === "builder" ? callKind.builderName : undefined)
        .toBe("lift");
      expect(detectCallKind(findCallInitializer(sourceFile, "plain"), checker))
        .toBeUndefined();
    });

    describe("a call of what a builder call returns", () => {
      // A builder call returns a factory, and calling that factory applies
      // the builder. What the application returns in turn is no factory, so
      // calling it is not a call of the builder.

      it("returns `lift-applied` for a `lift()` call applied once", () => {
        const { sourceFile, checker } = createApplicationProgram();

        expect(
          detectCallKind(
            findCallInitializer(sourceFile, "appliedOnce"),
            checker,
          )?.kind,
        ).toBe("lift-applied");
      });

      it("returns `lift-applied` for a call of a `lift` alias applied once", () => {
        const { sourceFile, checker } = createApplicationProgram();

        expect(
          detectCallKind(
            findCallInitializer(sourceFile, "aliasAppliedOnce"),
            checker,
          )?.kind,
        ).toBe("lift-applied");
      });

      it("returns `undefined` for a call of what an applied `lift()` call returns", () => {
        const { sourceFile, checker } = createApplicationProgram();

        expect(
          detectCallKind(
            findCallInitializer(sourceFile, "overApplied"),
            checker,
          )?.kind,
        ).toBeUndefined();
      });

      it("returns `undefined` for a call through a `const` binding of an applied `lift()` call", () => {
        const { sourceFile, checker } = createApplicationProgram();

        expect(
          detectCallKind(
            findCallInitializer(sourceFile, "viaAppliedResult"),
            checker,
          )?.kind,
        ).toBeUndefined();
      });

      it("returns the builder kind `handler` for a call through a `const` binding of a `handler()` call", () => {
        const { sourceFile, checker } = createApplicationProgram();

        const callKind = detectCallKind(
          findCallInitializer(sourceFile, "viaBoundHandler"),
          checker,
        );

        expect(callKind?.kind).toBe("builder");
        expect(callKind?.kind === "builder" ? callKind.builderName : undefined)
          .toBe("handler");
      });

      it("returns `undefined` for a call of what an `ifElse()` call returns", () => {
        const { sourceFile, checker } = createApplicationProgram();

        expect(
          detectCallKind(
            findCallInitializer(sourceFile, "viaIfElseResult"),
            checker,
          )?.kind,
        ).toBeUndefined();
      });
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

    it("returns `undefined` for a constructor bound to itself", () => {
      const { sourceFile, checker } = createProgram(`
        const Loop = Loop;

        const value = new Loop();
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

  describe("isHandlerAppliedCall()", () => {
    it("returns `true` for a `handler()` call applied once", () => {
      const { sourceFile, checker } = createApplicationProgram();

      expect(
        isHandlerAppliedCall(
          findCallInitializer(sourceFile, "handlerApplied"),
          checker,
        ),
      ).toBe(true);
    });

    it("returns `false` for a call of what an applied `handler()` call returns", () => {
      const { sourceFile, checker } = createApplicationProgram();

      expect(
        isHandlerAppliedCall(
          findCallInitializer(sourceFile, "handlerOverApplied"),
          checker,
        ),
      ).toBe(false);
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

    it("returns `undefined` for an applied `lift()` call whose callback is not a function expression", () => {
      // The callback is a declared function, so there is no authored body to
      // return; the call still classifies as `lift-applied`.

      const { sourceFile, checker } = createProgram(`
        declare function lift<T, U>(callback: (value: T) => U): (input: T) => U;
        declare function double(value: number): number;

        const value = lift(double)(1);
      `);
      const call = findCallInitializer(sourceFile, "value");

      expect(detectCallKind(call, checker)?.kind).toBe("lift-applied");
      expect(getLiftAppliedInputAndCallback(call, checker)).toBeUndefined();
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
      const synthetic = withSyntheticCallee(authored, "mapWithPattern");

      expect(getWithPatternHoistablePatternCall(authored, checker))
        .toBeUndefined();
      expect(getWithPatternHoistablePatternCall(synthetic, checker)?.getText())
        .toBe("make.pattern(() => 1)");
    });

    it("returns `undefined` when the first argument is not a pattern call", () => {
      const { sourceFile, checker } = createProgram(`
        declare const items: any;
        declare const make: { pattern(body: () => number): number };
        declare function plain(body: () => number): number;

        const value = items.mapWithPattern(plain(() => 1), { p: 1 });
        const hoistable = items.mapWithPattern(make.pattern(() => 1), {});
      `);
      const call = withSyntheticCallee(
        findCallInitializer(sourceFile, "value"),
        "mapWithPattern",
      );
      const hoistable = withSyntheticCallee(
        findCallInitializer(sourceFile, "hoistable"),
        "mapWithPattern",
      );

      expect(getWithPatternHoistablePatternCall(call, checker))
        .toBeUndefined();
      expect(getWithPatternHoistablePatternCall(hoistable, checker)?.getText())
        .toBe("make.pattern(() => 1)");
    });

    it("returns `undefined` for a synthetic `mapWithPattern()` call with no arguments", () => {
      const { sourceFile, checker } = createProgram(`
        declare const items: any;
        declare const make: { pattern(body: () => number): number };

        const value = items.mapWithPattern(make.pattern(() => 1), {});
      `);
      const authored = findCallInitializer(sourceFile, "value");

      expect(
        getWithPatternHoistablePatternCall(
          withSyntheticCallee(authored, "mapWithPattern", []),
          checker,
        ),
      ).toBeUndefined();
      expect(
        getWithPatternHoistablePatternCall(
          withSyntheticCallee(authored, "mapWithPattern"),
          checker,
        )?.getText(),
      ).toBe("make.pattern(() => 1)");
    });
  });

  describe("isCallbackReference()", () => {
    it("returns `false` for a missing expression, and `true` for an arrow", () => {
      const { sourceFile, checker } = createProgram(`
        const value = (event: unknown) => {};
      `);

      expect(isCallbackReference(undefined, checker)).toBe(false);
      expect(isCallbackReference(findInitializer(sourceFile, "value"), checker))
        .toBe(true);
    });
  });

  describe("isReactiveValueExpression()", () => {
    it("returns `false` for a literal the checker cannot type", () => {
      const { sourceFile, checker } = createProgram(`
        declare const CELL_BRAND: unique symbol;
        declare const cell: { readonly [CELL_BRAND]: "opaque" };
        const value = cell;
      `);
      const detached = ts.createSourceFile(
        "/detached.ts",
        "1;",
        ts.ScriptTarget.ESNext,
        false,
      ).statements[0];
      if (!detached || !ts.isExpressionStatement(detached)) {
        throw new Error("The detached statement did not parse.");
      }

      // Parsed without parent pointers, the literal makes the checker throw
      // when asked for its type.
      expect(() => checker.getTypeAtLocation(detached.expression)).toThrow();
      expect(isReactiveValueExpression(detached.expression, checker)).toBe(
        false,
      );
      expect(
        isReactiveValueExpression(
          findInitializer(sourceFile, "value"),
          checker,
        ),
      ).toBe(true);
    });
  });

  describe("isCollectingPlainArrayMethodCallback()", () => {
    const source = `
      interface Array<T> {
        map<U>(callback: (value: T) => U): U[];
        filter(callback: (value: T) => boolean): T[];
      }
      declare const loose: any;

      const mapped = [1, 2].map((value) => value * 2);
      const filtered = [1, 2].filter((value) => value > 1);
      const untyped = loose.map((value: number) => value * 2);
    `;

    function callbackOf(sourceFile: ts.SourceFile, declarationName: string) {
      const callback = findCallInitializer(sourceFile, declarationName)
        .arguments[0];
      if (!callback || !ts.isArrowFunction(callback)) {
        throw new Error(`${declarationName} has no arrow callback`);
      }
      return callback;
    }

    it("returns `true` for the callback of a default-library `map()`", () => {
      const { sourceFile, checker } = createProgram(source);

      expect(
        isCollectingPlainArrayMethodCallback(
          callbackOf(sourceFile, "mapped"),
          checker,
          () => true,
        ),
      ).toBe(true);
      expect(
        isCollectingPlainArrayMethodCallback(
          callbackOf(sourceFile, "mapped"),
          checker,
          () => false,
        ),
      ).toBe(false);
      expect(
        isCollectingPlainArrayMethodCallback(
          callbackOf(sourceFile, "filtered"),
          checker,
          () => true,
        ),
      ).toBe(false);
    });

    it("returns `false` for the callback of a `map()` on an `any` receiver", () => {
      // The call resolves to no signature declaration, so nothing shows the
      // method is the default library's `Array.map()`.

      const { sourceFile, checker } = createProgram(source);

      expect(
        isCollectingPlainArrayMethodCallback(
          callbackOf(sourceFile, "untyped"),
          checker,
          () => true,
        ),
      ).toBe(false);
    });
  });

  describe("classifyWildcardTraversalCall()", () => {
    it("returns `object-wildcard-traversal` for a quoted `keys` method that `ObjectConstructor` declares", () => {
      // The receiver is an alias, so only the declaration can identify the
      // method; its quoted name names the same member as a bare one.

      const { sourceFile, checker } = createProgram(`
        interface ObjectConstructor { "keys"(value: object): string[] }
        interface Registry { "keys"(value: object): string[] }
        declare const objects: ObjectConstructor;
        declare const registry: Registry;

        const traversal = objects.keys({});
        const lookup = registry.keys({});
      `);

      expect(
        classifyWildcardTraversalCall(
          findCallInitializer(sourceFile, "traversal"),
          checker,
        ),
      ).toBe("object-wildcard-traversal");
      expect(
        classifyWildcardTraversalCall(
          findCallInitializer(sourceFile, "lookup"),
          checker,
        ),
      ).toBeUndefined();
    });
  });

  describe("classifyArrayMethodResultSinkCall()", () => {
    it("returns the `join` sink for a quoted `join` method that `Array` declares", () => {
      const { sourceFile, checker } = createProgram(`
        interface Array<T> {
          map<U>(callback: (value: T) => U): U[];
          "join"(separator?: string): string;
        }

        const joined = [1, 2].map((value) => value).join();
      `);

      expect(
        classifyArrayMethodResultSinkCall(
          findCallInitializer(sourceFile, "joined"),
          checker,
        ),
      ).toEqual({
        sink: "join",
        receiverFamily: "map",
        receiverLowered: false,
      });
    });

    it("returns `undefined` for a method other than `join` when no checker is given", () => {
      const { sourceFile } = createProgram(`
        declare const items: any;

        const joined = items.map((value: number) => value).join();
        const other = items.map((value: number) => value).concat();
      `);

      expect(
        classifyArrayMethodResultSinkCall(
          findCallInitializer(sourceFile, "joined"),
        ),
      ).toEqual({
        sink: "join",
        receiverFamily: "map",
        receiverLowered: false,
      });
      expect(
        classifyArrayMethodResultSinkCall(
          findCallInitializer(sourceFile, "other"),
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
