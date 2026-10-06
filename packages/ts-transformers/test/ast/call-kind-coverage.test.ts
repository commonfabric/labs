import { assert, assertEquals } from "@std/assert";
import ts from "typescript";

import {
  classifyArrayCallbackContainerCall,
  classifyArrayMethodCallSite,
  classifyArrayMethodResultSinkCall,
  classifyWildcardTraversalCall,
  detectCallKind,
  detectNewExpressionKind,
  getCapabilitySummaryCallbackArgument,
  getLiftAppliedInputAndCallback,
  hasReactiveCollectionProvenance,
  isConsumedByTerminalChainCall,
  isReactiveOriginExpression,
  isReactiveValueExpression,
  isReactiveValueSymbol,
  isSimpleReactiveAccessExpression,
} from "../../src/ast/mod.ts";
import { getEnclosingFunctionLikeDeclaration } from "../../src/ast/function-predicates.ts";
import {
  getPatternBuilderCallbackArgument,
  getPatternToolHoistablePatternCall,
  getWithPatternHoistablePatternCall,
} from "../../src/ast/call-kind.ts";
import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";

// Harness A: a bare source-file-only program (no lib, no module resolution).
// Mirrors the setup in call-kind.test.ts for cases that need only structural
// AST shape and do not depend on resolving `commonfabric` imports.
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

// A program that resolves `import ... from "commonfabric"` against the real
// commonfabric.d.ts, so callee symbols carry Common Fabric provenance. Needed
// for the builder/runtime-call/cell-factory recognition paths that resolve the
// callee symbol rather than reading the callee syntax.
function createProgramWithCommonFabric(source: string): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
} {
  const files: Record<string, string> = {
    "/test.ts": source,
    "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"],
  };
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
  };
  const host: ts.CompilerHost = {
    fileExists: (name) => files[name] !== undefined,
    readFile: (name) => files[name],
    directoryExists: () => true,
    getDirectories: () => [],
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => "/",
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
    getSourceFile: (name, languageVersion) =>
      files[name] !== undefined
        ? ts.createSourceFile(name, files[name]!, languageVersion, true)
        : undefined,
    resolveModuleNames: (moduleNames) =>
      moduleNames.map((name) => {
        const match = Object.keys(files).find((fileName) =>
          fileName === `/${name}.d.ts` || fileName.endsWith(`/${name}.d.ts`)
        );
        return match
          ? {
            resolvedFileName: match,
            extension: ts.Extension.Dts,
            isExternalLibraryImport: false,
          }
          : undefined;
      }),
  };
  const program = ts.createProgram(["/test.ts"], options, host);
  return {
    sourceFile: program.getSourceFile("/test.ts")!,
    checker: program.getTypeChecker(),
  };
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

function findCall(
  sourceFile: ts.SourceFile,
  declarationName: string,
): ts.CallExpression {
  const expr = findInitializer(sourceFile, declarationName);
  if (!ts.isCallExpression(expr)) {
    throw new Error(`Initializer for ${declarationName} is not a call`);
  }
  return expr;
}

function findFirstIdentifier(
  sourceFile: ts.SourceFile,
  text: string,
): ts.Identifier {
  let found: ts.Identifier | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === text) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`Identifier ${text} not found`);
  return found;
}

Deno.test("getWithPatternHoistablePatternCall returns undefined for a lowered method with no arguments", () => {
  const { sourceFile, checker } = createProgram(`
    declare const items: any;
    const value = items.mapWithPattern();
  `);

  const call = findCall(sourceFile, "value");
  // Callee is a lowered *WithPattern access, but there is no first argument to
  // hoist, so the recognizer bails at the missing-argument guard.
  assertEquals(getWithPatternHoistablePatternCall(call, checker), undefined);
});

Deno.test("getPatternToolHoistablePatternCall lifts the bare pattern call out of a patternTool call", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { patternTool, pattern } from "commonfabric";
    const value = patternTool(pattern(() => 1), { p: 1 });
  `);

  const call = findCall(sourceFile, "value");
  const hoistable = getPatternToolHoistablePatternCall(call, checker);
  assertEquals(hoistable?.getText(), "pattern(() => 1)");
});

Deno.test("getPatternToolHoistablePatternCall returns undefined when patternTool has no arguments", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { patternTool } from "commonfabric";
    const value = patternTool();
  `);

  const call = findCall(sourceFile, "value");
  // Recognized as a pattern-tool call, but the missing first argument means
  // there is nothing to hoist.
  assertEquals(getPatternToolHoistablePatternCall(call, checker), undefined);
});

Deno.test("getPatternToolHoistablePatternCall ignores calls that are not patternTool", () => {
  const { sourceFile, checker } = createProgram(`
    declare function plain(body: () => number, params?: unknown): number;
    const value = plain(() => 1, { p: 1 });
  `);

  const call = findCall(sourceFile, "value");
  assertEquals(getPatternToolHoistablePatternCall(call, checker), undefined);
});

Deno.test("getLiftAppliedInputAndCallback returns undefined when the applied lift call has no input argument", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { lift } from "commonfabric";
    const value = lift((v: number) => v + 1)();
  `);

  const call = findCall(sourceFile, "value");
  // The call is lift-applied, its inner callee is the lift(...) call, but the
  // outer application supplies no input argument, so the input guard rejects it.
  assertEquals(detectCallKind(call, checker)?.kind, "lift-applied");
  assertEquals(getLiftAppliedInputAndCallback(call, checker), undefined);
});

Deno.test("getCapabilitySummaryCallbackArgument reads the callback off a lift-applied call", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { lift } from "commonfabric";
    const value = lift((v: number) => v + 1)(3);
  `);

  const call = findCall(sourceFile, "value");
  assertEquals(detectCallKind(call, checker)?.kind, "lift-applied");
  const callback = getCapabilitySummaryCallbackArgument(call, checker);
  assert(callback && ts.isArrowFunction(callback));
  assertEquals(callback.parameters[0]?.name.getText(), "v");
});

Deno.test("lift-applied callback lookup ignores trailing scheduler options", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { lift } from "commonfabric";
    const value = lift(
      (v: number) => v + 1,
      { unavailableInputPolicy: [{ path: ["v"], reasons: ["error"] }] },
    )(3);
  `);

  const call = findCall(sourceFile, "value");
  const callback = getLiftAppliedInputAndCallback(call, checker)?.callback;
  assert(callback && ts.isArrowFunction(callback));
  assertEquals(callback.parameters[0]?.name.getText(), "v");
  assertEquals(
    getCapabilitySummaryCallbackArgument(call, checker),
    callback,
  );
});

Deno.test("isReactiveOriginExpression is false for a non-call, non-new expression", () => {
  const { sourceFile, checker } = createProgram(`
    const value = 1 + 2;
  `);

  const expression = findInitializer(sourceFile, "value");
  assertEquals(isReactiveOriginExpression(expression, checker), false);
});

Deno.test("isReactiveOriginExpression follows a new expression to a cell factory", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { Writable } from "commonfabric";
    const value = new Writable(1);
  `);

  const expression = findInitializer(sourceFile, "value");
  assert(ts.isNewExpression(expression));
  assertEquals(
    detectNewExpressionKind(expression, checker)?.factoryName,
    "Writable",
  );
  assertEquals(isReactiveOriginExpression(expression, checker), true);
});

Deno.test("classifyWildcardTraversalCall recognizes Object.keys by syntax when the symbol is unresolved", () => {
  const { sourceFile, checker } = createProgram(`
    declare const Object: any;
    const value = Object.keys({ a: 1 });
  `);

  const call = findCall(sourceFile, "value");
  // No lib means Object.keys has no resolvable ObjectConstructor declaration;
  // recognition falls through to the syntactic Object.<name> check.
  assertEquals(
    classifyWildcardTraversalCall(call, checker),
    "object-wildcard-traversal",
  );
});

Deno.test("classifyWildcardTraversalCall recognizes JSON.stringify by syntax when the symbol is unresolved", () => {
  const { sourceFile, checker } = createProgram(`
    declare const JSON: any;
    const value = JSON.stringify({ a: 1 });
  `);

  const call = findCall(sourceFile, "value");
  assertEquals(classifyWildcardTraversalCall(call, checker), "json-stringify");
});

Deno.test("classifyWildcardTraversalCall resolves Object.keys through its ObjectConstructor declaration", () => {
  const { sourceFile, checker } = createProgram(`
    interface ObjectConstructor {
      keys(o: object): string[];
    }
    declare const Object: ObjectConstructor;
    const value = Object.keys({ a: 1 });
  `);

  const call = findCall(sourceFile, "value");
  // The resolved-declaration branch: the callee symbol resolves to an
  // ObjectConstructor member named "keys".
  assertEquals(
    classifyWildcardTraversalCall(call, checker),
    "object-wildcard-traversal",
  );
});

Deno.test("classifyWildcardTraversalCall resolves JSON.stringify through its JSON declaration", () => {
  const { sourceFile, checker } = createProgram(`
    interface JSON {
      stringify(value: unknown): string;
    }
    declare const JSON: JSON;
    const value = JSON.stringify({ a: 1 });
  `);

  const call = findCall(sourceFile, "value");
  assertEquals(classifyWildcardTraversalCall(call, checker), "json-stringify");
});

Deno.test("getPatternBuilderCallbackArgument unwraps a function-hardening wrapper around the pattern callback", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { pattern } from "commonfabric";
    declare function __cfHardenFn0<T>(fn: T): T;
    const value = pattern(__cfHardenFn0((input: unknown) => input));
  `);

  const call = findCall(sourceFile, "value");
  const callback = getPatternBuilderCallbackArgument(call, checker);
  // resolveCallbackFunctionExpression peels the __cfHardenFn wrapper call to
  // reach the underlying arrow function.
  assert(callback && ts.isArrowFunction(callback));
  assertEquals(callback.parameters[0]?.name.getText(), "input");
});

Deno.test("getPatternBuilderCallbackArgument follows an identifier bound to the callback arrow", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { pattern } from "commonfabric";
    const body = (input: unknown) => input;
    const value = pattern(body);
  `);

  const call = findCall(sourceFile, "value");
  // The callback argument is an identifier; resolveCallbackFunctionExpression
  // follows its variable initializer to the arrow function.
  const callback = getPatternBuilderCallbackArgument(call, checker);
  assert(callback && ts.isArrowFunction(callback));
  assertEquals(callback.parameters[0]?.name.getText(), "input");
});

Deno.test("getPatternBuilderCallbackArgument stops on a cyclic callback identifier binding", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { pattern } from "commonfabric";
    const cyclicA: any = (cyclicB as any);
    const cyclicB: any = (cyclicA as any);
    const value = pattern(cyclicA);
  `);

  const call = findCall(sourceFile, "value");
  // The callback identifier resolves through a cycle of variable initializers;
  // the seen-set guard breaks the recursion and yields no callback.
  assertEquals(getPatternBuilderCallbackArgument(call, checker), undefined);
});

Deno.test("classifyArrayMethodResultSinkCall recognizes .join by syntax when the join symbol is unresolved", () => {
  const { sourceFile, checker } = createProgram(`
    interface Array<T> {
      map<U>(cb: (v: T) => U): U[];
    }
    const value = [1, 2, 3].map((n: number) => n + 1).join(", ");
  `);

  const call = findCall(sourceFile, "value");
  // The join member has no resolvable Array declaration here, so recognition
  // falls to the syntactic name check.
  assertEquals(classifyArrayMethodResultSinkCall(call, checker), {
    sink: "join",
    receiverFamily: "map",
    receiverLowered: false,
  });
});

Deno.test("classifyArrayMethodResultSinkCall resolves .join through its Array declaration", () => {
  const { sourceFile, checker } = createProgram(`
    interface Array<T> {
      map<U>(cb: (v: T) => U): U[];
      join(separator?: string): string;
    }
    const value = [1, 2, 3].map((n: number) => n + 1).join(", ");
  `);

  const call = findCall(sourceFile, "value");
  assertEquals(classifyArrayMethodResultSinkCall(call, checker), {
    sink: "join",
    receiverFamily: "map",
    receiverLowered: false,
  });
});

Deno.test("classifyArrayMethodResultSinkCall rejects a non-join member that resolves to an Array declaration", () => {
  const { sourceFile, checker } = createProgram(`
    interface Array<T> {
      map<U>(cb: (v: T) => U): U[];
      slice(start?: number): T[];
    }
    const value = [1, 2, 3].map((n: number) => n + 1).slice(0);
  `);

  const call = findCall(sourceFile, "value");
  // The member resolves to a real Array declaration that is not "join", so the
  // "declarations present but none matched" guard returns undefined.
  assertEquals(classifyArrayMethodResultSinkCall(call, checker), undefined);
});

Deno.test("detectCallKind classifies imported runtime calls with their export names", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { str, llm } from "commonfabric";
    const strValue = str(\`x\`);
    const llmValue = llm(\`y\`);
  `);

  const strCall = findCall(sourceFile, "strValue");
  const llmCall = findCall(sourceFile, "llmValue");

  const strKind = detectCallKind(strCall, checker);
  const llmKind = detectCallKind(llmCall, checker);
  assertEquals(strKind?.kind, "runtime-call");
  assertEquals(
    strKind?.kind === "runtime-call" ? strKind.exportName : undefined,
    "str",
  );
  assertEquals(
    strKind?.kind === "runtime-call" ? strKind.reactiveOrigin : undefined,
    true,
  );
  assertEquals(
    llmKind?.kind === "runtime-call" ? llmKind.exportName : undefined,
    "llm",
  );
});

Deno.test("detectCallKind classifies ifElse, when, unless, wish, and generate calls from commonfabric", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import {
      ifElse, when, unless, wish, generateText, generateObject, patternTool,
    } from "commonfabric";
    const a = ifElse(true, 1, 2);
    const b = when(true, () => 1);
    const c = unless(true, () => 1);
    const d = wish({});
    const e = generateText({});
    const f = generateObject({});
    const g = patternTool({});
  `);

  assertEquals(
    detectCallKind(findCall(sourceFile, "a"), checker)?.kind,
    "ifElse",
  );
  assertEquals(
    detectCallKind(findCall(sourceFile, "b"), checker)?.kind,
    "when",
  );
  assertEquals(
    detectCallKind(findCall(sourceFile, "c"), checker)?.kind,
    "unless",
  );
  assertEquals(
    detectCallKind(findCall(sourceFile, "d"), checker)?.kind,
    "wish",
  );
  assertEquals(
    detectCallKind(findCall(sourceFile, "e"), checker)?.kind,
    "generate-text",
  );
  assertEquals(
    detectCallKind(findCall(sourceFile, "f"), checker)?.kind,
    "generate-object",
  );
  assertEquals(
    detectCallKind(findCall(sourceFile, "g"), checker)?.kind,
    "pattern-tool",
  );
});

Deno.test("detectCallKind resolves advanced generation APIs through aliases and namespaces", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import {
      generateObjectStream as objectStream,
      generateTextStream as textStream,
    } from "commonfabric";
    import * as cf from "commonfabric";
    const aliasText = textStream({ prompt: "hello" });
    const aliasObject = objectStream<{ ok: boolean }>({ prompt: "hello" });
    const namespaceText = cf.generateTextStream({ prompt: "hello" });
    const namespaceObject = cf.generateObjectStream<{ ok: boolean }>({ prompt: "hello" });
  `);

  for (const declaration of ["aliasText", "namespaceText"]) {
    const call = findCall(sourceFile, declaration);
    const callKind = detectCallKind(call, checker);
    assert(callKind?.kind === "runtime-call");
    assertEquals(callKind.exportName, "generateTextStream");
    assertEquals(callKind.reactiveOrigin, true);
    assertEquals(isReactiveOriginExpression(call, checker), true);
  }

  for (const declaration of ["aliasObject", "namespaceObject"]) {
    const call = findCall(sourceFile, declaration);
    const callKind = detectCallKind(call, checker);
    assert(callKind?.kind === "generate-object");
    assertEquals(callKind.exportName, "generateObjectStream");
    assertEquals(isReactiveOriginExpression(call, checker), true);
  }
});

Deno.test("detectCallKind resolves the cell factory imported from commonfabric", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { cell } from "commonfabric";
    const value = cell(1);
  `);

  const call = findCall(sourceFile, "value");
  const kind = detectCallKind(call, checker);
  assertEquals(kind?.kind, "cell-factory");
  assertEquals(
    kind?.kind === "cell-factory" ? kind.factoryName : undefined,
    "cell",
  );
});

Deno.test("detectNewExpressionKind reads a cell factory through a perSpace scoped constructor access", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { Writable } from "commonfabric";
    const value = new Writable.perSpace(1);
  `);

  const expression = findInitializer(sourceFile, "value");
  assert(ts.isNewExpression(expression));
  // The scoped-constructor access recursion strips ".perSpace" and resolves the
  // underlying Writable factory name.
  assertEquals(
    detectNewExpressionKind(expression, checker)?.factoryName,
    "Writable",
  );
});

Deno.test("detectCallKind classifies Cell.of static factory and Cell.for through their declarations", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { Cell } from "commonfabric";
    declare const C: typeof Cell;
    const ofValue = C.of(1);
    const forValue = C.for(1);
  `);

  const ofKind = detectCallKind(findCall(sourceFile, "ofValue"), checker);
  const forKind = detectCallKind(findCall(sourceFile, "forValue"), checker);
  assertEquals(ofKind?.kind, "cell-factory");
  assertEquals(
    ofKind?.kind === "cell-factory" ? ofKind.factoryName : undefined,
    "of",
  );
  assertEquals(forKind?.kind, "cell-for");
});

Deno.test("detectCallKind follows a const alias of an ambient builder", () => {
  const { sourceFile, checker } = createProgram(`
    declare function pattern<T>(cb: () => T): T;
    const aliased = pattern;
    const value = aliased(() => 1);
  `);

  const call = findCall(sourceFile, "value");
  // The callee resolves to a const bound to the ambient `pattern`; builder
  // recognition follows the const initializer to the ambient builder name.
  const kind = detectCallKind(call, checker);
  assertEquals(kind?.kind, "builder");
  assertEquals(
    kind?.kind === "builder" ? kind.builderName : undefined,
    "pattern",
  );
});

Deno.test("detectCallKind resolves a namespace-member builder to its commonfabric declaration", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import * as CF from "commonfabric";
    const value = CF.pattern(() => 1);
  `);

  const call = findCall(sourceFile, "value");
  // The callee symbol is the namespace member `pattern`, so the import-specifier
  // shortcut does not fire; resolution follows the alias to the commonfabric
  // declaration and recognizes the builder by name plus provenance.
  const kind = detectCallKind(call, checker);
  assertEquals(kind?.kind, "builder");
  assertEquals(
    kind?.kind === "builder" ? kind.builderName : undefined,
    "pattern",
  );
});

Deno.test("detectCallKind recognizes a synthetic __cfHelpers builder call by callee syntax", () => {
  const { sourceFile, checker } = createProgram(`
    declare const __cfHelpers: any;
    const value = __cfHelpers.pattern(() => 1);
  `);

  const call = findCall(sourceFile, "value");
  // No symbol resolves for the synthetic helper access, so recognition falls to
  // getDirectBuilderName which reads the __cfHelpers.<builder> syntax directly.
  const kind = detectCallKind(call, checker);
  assertEquals(kind?.kind, "builder");
  assertEquals(
    kind?.kind === "builder" ? kind.builderName : undefined,
    "pattern",
  );
});

Deno.test("detectCallKind recognizes a bare unresolved builder identifier by name", () => {
  const { sourceFile, checker } = createProgram(`
    // @ts-expect-error intentionally unresolved
    const value = pattern(() => 1);
  `);

  const call = findCall(sourceFile, "value");
  // The identifier `pattern` has no symbol, so getDirectBuilderName recognizes it
  // by its name being a known builder export.
  const kind = detectCallKind(call, checker);
  assertEquals(kind?.kind, "builder");
  assertEquals(
    kind?.kind === "builder" ? kind.builderName : undefined,
    "pattern",
  );
});

Deno.test("detectCallKind recognizes synthetic __cfHelpers runtime and cell-factory calls without a callee symbol", () => {
  const { sourceFile, checker } = createProgram(`
    declare const __cfHelpers: any;
    const strValue = __cfHelpers.str(\`x\`);
    const cellValue = __cfHelpers.cell(1);
    const ifElseValue = __cfHelpers.ifElse(true, 1, 2);
    const patternToolValue = __cfHelpers.patternTool({});
    const generateTextValue = __cfHelpers.generateText({});
    const generateObjectValue = __cfHelpers.generateObject({});
    const wishValue = __cfHelpers.wish({});
    const whenValue = __cfHelpers.when(true, () => 1);
    const unlessValue = __cfHelpers.unless(true, () => 1);
  `);

  // getSyntheticHelperCallKind routes through createNamedCallKind with no symbol,
  // exercising the symbol-absent arm of each callKind case.
  const strKind = detectCallKind(findCall(sourceFile, "strValue"), checker);
  assertEquals(strKind?.kind, "runtime-call");
  assertEquals(
    strKind?.kind === "runtime-call" ? strKind.symbol : "present",
    undefined,
  );
  const cellKind = detectCallKind(findCall(sourceFile, "cellValue"), checker);
  assertEquals(cellKind?.kind, "cell-factory");
  assertEquals(
    cellKind?.kind === "cell-factory" ? cellKind.factoryName : undefined,
    "cell",
  );
  assertEquals(
    detectCallKind(findCall(sourceFile, "ifElseValue"), checker)?.kind,
    "ifElse",
  );
  assertEquals(
    detectCallKind(findCall(sourceFile, "patternToolValue"), checker)?.kind,
    "pattern-tool",
  );
  assertEquals(
    detectCallKind(findCall(sourceFile, "generateTextValue"), checker)?.kind,
    "generate-text",
  );
  assertEquals(
    detectCallKind(findCall(sourceFile, "generateObjectValue"), checker)?.kind,
    "generate-object",
  );
  assertEquals(
    detectCallKind(findCall(sourceFile, "wishValue"), checker)?.kind,
    "wish",
  );
  assertEquals(
    detectCallKind(findCall(sourceFile, "whenValue"), checker)?.kind,
    "when",
  );
  assertEquals(
    detectCallKind(findCall(sourceFile, "unlessValue"), checker)?.kind,
    "unless",
  );
});

Deno.test("isSimpleReactiveAccessExpression walks property and element access down to a reactive cell root", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { Cell } from "commonfabric";
    declare const root: Cell<{ items: number[] }>;
    const propValue = root.items;
    const elemValue = root["items"];
    const plainValue = ({ items: [] }).items;
  `);

  const prop = findInitializer(sourceFile, "propValue");
  const elem = findInitializer(sourceFile, "elemValue");
  const plain = findInitializer(sourceFile, "plainValue");

  assertEquals(isSimpleReactiveAccessExpression(prop, checker), true);
  assertEquals(isSimpleReactiveAccessExpression(elem, checker), true);
  assertEquals(isSimpleReactiveAccessExpression(plain, checker), false);
});

Deno.test("classifyArrayCallbackContainerCall downgrades a reactive .map consumed by a following element access", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { Cell } from "commonfabric";
    declare const items: Cell<number[]>;
    const value = items.map((n: number) => n + 1)[0];
  `);

  // The `.map` call over a reactive receiver is reactive, but it is immediately
  // consumed by an element access, so isConsumedByTerminalChainCall marks it a
  // terminal-chain value and it is downgraded to plain-array-value.
  const mapIdent = findFirstIdentifier(sourceFile, "map");
  const mapCall = mapIdent.parent.parent as ts.Node;
  if (!ts.isCallExpression(mapCall)) {
    throw new Error("Expected the .map call expression");
  }
  assertEquals(
    classifyArrayMethodCallSite(mapCall, checker)?.ownership,
    "reactive",
  );
  assertEquals(
    classifyArrayCallbackContainerCall(mapCall, checker),
    "plain-array-value",
  );
  assertEquals(isConsumedByTerminalChainCall(mapCall), true);
});

Deno.test("classifyArrayCallbackContainerCall keeps a reactive .map reactive when it is not consumed by a chain", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { Cell } from "commonfabric";
    declare const items: Cell<number[]>;
    const value = items.map((n: number) => n + 1);
  `);

  const call = findCall(sourceFile, "value");
  assertEquals(
    classifyArrayMethodCallSite(call, checker)?.ownership,
    "reactive",
  );
  assertEquals(
    classifyArrayCallbackContainerCall(call, checker),
    "reactive-array-method",
  );
  assertEquals(isConsumedByTerminalChainCall(call), false);
});

Deno.test("isConsumedByTerminalChainCall reports true when the call result is itself invoked", () => {
  const { sourceFile } = createProgram(`
    declare const make: () => (() => number);
    const value = make()();
  `);

  // Outer call `make()()` — the inner `make()` result is directly invoked, so
  // the call-parent branch fires.
  const outer = findCall(sourceFile, "value");
  const inner = outer.expression;
  if (!ts.isCallExpression(inner)) {
    throw new Error("Expected an inner call expression");
  }
  assertEquals(isConsumedByTerminalChainCall(inner), true);
});

Deno.test("hasReactiveCollectionProvenance treats a builder callback parameter as a reactive collection root", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { computed } from "commonfabric";
    const value = computed((rows: number[]) => rows.map((n: number) => n + 1));
  `);

  // `rows` is a parameter of a computed() builder callback, so it is an implicit
  // reactive parameter and the provenance walk resolves it as reactive.
  const rows = findFirstIdentifier(sourceFile, "rows");
  assertEquals(hasReactiveCollectionProvenance(rows, checker), true);
  assertEquals(
    isReactiveValueSymbol(checker.getSymbolAtLocation(rows), checker),
    true,
  );
});

Deno.test("isReactiveValueExpression follows a variable initialized by a reactive-origin call", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { computed } from "commonfabric";
    const derived = computed(() => 1);
    const value = derived;
  `);

  // `derived` is bound to a reactive-origin computed() call, so reading the
  // identifier resolves as a reactive value through its initializer.
  const ident = findInitializer(sourceFile, "value");
  assertEquals(isReactiveValueExpression(ident, checker), true);
});

Deno.test("detectCallKind ignores a non-const let binding of a builder", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { pattern } from "commonfabric";
    let aliased = pattern;
    const value = aliased(() => 1);
  `);

  const call = findCall(sourceFile, "value");
  // resolveSymbolKind reaches the builder through the `let` initializer, but the
  // non-const guard rejects builder kinds bound to a mutable binding.
  assertEquals(detectCallKind(call, checker), undefined);
});

Deno.test("detectNewExpressionKind follows a const alias chain to a commonfabric cell constructor", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { Writable } from "commonfabric";
    const First = Writable;
    const Second = First;
    const value = new Second(1);
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isNewExpression(expression)) {
    throw new Error("Expected a new expression");
  }
  // detectCellConstructorExpressionName walks the const-initializer chain
  // Second -> First -> Writable to reach the commonfabric cell constructor.
  assertEquals(
    detectNewExpressionKind(expression, checker)?.factoryName,
    "Writable",
  );
});

Deno.test("detectNewExpressionKind returns undefined for a new expression with an unresolved callee", () => {
  const { sourceFile, checker } = createProgram(`
    // @ts-expect-error intentionally unresolved
    const value = new Unknown(1);
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isNewExpression(expression)) {
    throw new Error("Expected a new expression");
  }
  // The callee identifier has no symbol, so detectCellConstructorExpressionName
  // returns undefined at the missing-symbol guard.
  assertEquals(detectNewExpressionKind(expression, checker), undefined);
});

Deno.test("detectNewExpressionKind resolves a namespace-member cell constructor through its declaration", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import * as CF from "commonfabric";
    const value = new CF.Writable(1);
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isNewExpression(expression)) {
    throw new Error("Expected a new expression");
  }
  // The callee is a property access whose member symbol resolves via alias to the
  // commonfabric Writable declaration, taking the name-plus-provenance branch.
  assertEquals(
    detectNewExpressionKind(expression, checker)?.factoryName,
    "Writable",
  );
});

Deno.test("detectNewExpressionKind returns undefined for a new expression with a non-identifier callee", () => {
  const { sourceFile, checker } = createProgram(`
    declare const ctors: any;
    const value = new ctors[0](1);
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isNewExpression(expression)) {
    throw new Error("Expected a new expression");
  }
  // The callee is an element access, which is neither an identifier nor a
  // property access, so recognition bails at the callee-shape guard.
  assertEquals(detectNewExpressionKind(expression, checker), undefined);
});

Deno.test("detectCallKind returns a non-builder call kind through a const alias initializer", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { ifElse } from "commonfabric";
    const chosen = ifElse;
    const value = chosen(true, 1, 2);
  `);

  const call = findCall(sourceFile, "value");
  // The alias resolves to ifElse through its const initializer; because the
  // nested kind is not a builder, it is returned directly (no const gate).
  assertEquals(detectCallKind(call, checker)?.kind, "ifElse");
});

Deno.test("detectCallKind returns undefined when a const alias initializer resolves to no kind", () => {
  const { sourceFile, checker } = createProgram(`
    declare function plain(): number;
    const alias = plain;
    const value = alias();
  `);

  const call = findCall(sourceFile, "value");
  // The const initializer resolves to no call kind, so the declaration loop
  // continues past it and resolution yields undefined.
  assertEquals(detectCallKind(call, checker), undefined);
});

Deno.test("detectCallKind classifies aliased availability guards by resolved commonfabric symbol", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { hasError as failed } from "commonfabric";
    declare const value: unknown;
    const result = failed(value);
  `);

  const call = findCall(sourceFile, "result");
  assertEquals(detectCallKind(call, checker), {
    kind: "availability-guard",
    reason: "error",
    variantTypeName: "HasError",
    symbol: checker.getSymbolAtLocation(
      call.expression as ts.Identifier,
    ),
  });
});

Deno.test("detectCallKind classifies observeAvailability through a stable const alias", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { observeAvailability } from "commonfabric";
    const observe = observeAvailability;
    declare const value: unknown;
    const result = observe(value, "pending");
  `);

  const call = findCall(sourceFile, "result");
  assertEquals(detectCallKind(call, checker)?.kind, "availability-observer");
});

Deno.test("detectCallKind classifies resultOf through direct alias and namespace references", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { resultOf, resultOf as usable } from "commonfabric";
    import * as cf from "commonfabric";
    declare const value: unknown;
    const direct = resultOf(value);
    const alias = usable(value);
    const namespace = cf.resultOf(value);
  `);

  for (const declaration of ["direct", "alias", "namespace"]) {
    const call = findCall(sourceFile, declaration);
    const callKind = detectCallKind(call, checker);
    assertEquals(callKind?.kind, "availability-result");
    assertEquals(isReactiveOriginExpression(call, checker), true);
  }
});

Deno.test("detectCallKind ignores an unrelated same-named resultOf", () => {
  const { sourceFile, checker } = createProgram(`
    function resultOf<T>(value: T): T { return value; }
    const result = resultOf("ordinary data");
  `);

  const call = findCall(sourceFile, "result");
  assertEquals(detectCallKind(call, checker), undefined);
});

Deno.test("detectCallKind classifies a namespace availability guard", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import * as cf from "commonfabric";
    declare const value: unknown;
    const result = cf.isSyncing(value);
  `);

  const call = findCall(sourceFile, "result");
  const callKind = detectCallKind(call, checker);
  assert(callKind?.kind === "availability-guard");
  assertEquals(callKind.reason, "syncing");
});

Deno.test("detectCallKind ignores an unrelated same-named availability helper", () => {
  const { sourceFile, checker } = createProgram(`
    function hasError(_value: unknown): boolean { return false; }
    const result = hasError("ordinary data");
  `);

  const call = findCall(sourceFile, "result");
  assertEquals(detectCallKind(call, checker), undefined);
});

Deno.test("isReactiveValueSymbol treats a reactive array-method callback parameter as reactive", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { Cell } from "commonfabric";
    declare const items: Cell<{ n: number }[]>;
    const value = items.map((row) => row.n);
  `);

  // `row` is the parameter of a callback on a reactive `.map`; the implicit
  // reactive-parameter context recognizes it as a reactive-array-method binding.
  const row = findFirstIdentifier(sourceFile, "row");
  assertEquals(
    isReactiveValueSymbol(checker.getSymbolAtLocation(row), checker),
    true,
  );
});

Deno.test("isReactiveValueExpression follows a variable bound to a lowered reactive array-method call", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { Cell } from "commonfabric";
    declare const items: Cell<number[]>;
    const mapped = items.mapWithPattern((n: number) => n + 1);
    const value = mapped;
  `);

  // `mapped` is bound to a lowered reactive `.mapWithPattern` call, so reading it
  // resolves as reactive through isVariableFromReactiveCallSymbol.
  const ident = findInitializer(sourceFile, "value");
  assertEquals(isReactiveValueExpression(ident, checker), true);
});

Deno.test("hasReactiveCollectionProvenance restricts implicit reactive parameters to the given scope", () => {
  const { sourceFile, checker } = createProgramWithCommonFabric(`
    import { computed } from "commonfabric";
    const outer = computed((rows: number[]) => {
      const inner = (extra: number[]) => extra.map((n: number) => n + 1);
      return inner([1]);
    });
  `);

  const rows = findFirstIdentifier(sourceFile, "rows");
  const outerFn = getEnclosingFunctionLikeDeclaration(rows);
  const innerRef = findFirstIdentifier(sourceFile, "extra");
  const innerFn = getEnclosingFunctionLikeDeclaration(innerRef);
  if (!outerFn || !innerFn) throw new Error("Expected enclosing functions");

  // `rows` is an implicit reactive parameter of the computed() callback. Scoped
  // to the outer function it is in-scope and reactive; scoped to the inner arrow
  // it is out of scope, so the scope guard rejects it.
  assertEquals(
    hasReactiveCollectionProvenance(rows, checker, { sameScope: outerFn }),
    true,
  );
  assertEquals(
    hasReactiveCollectionProvenance(rows, checker, { sameScope: innerFn }),
    false,
  );
});
