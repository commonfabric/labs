import { assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { CrossStageState, TransformationContext } from "../../src/core/mod.ts";
import { classifyReactiveContext } from "../../src/ast/mod.ts";
import {
  classifyCallbackBoundary,
  getCallbackBoundarySemantics,
} from "../../src/policy/callback-boundary.ts";

const virtualLibraryFileName = "/virtual/es2023.d.ts";
const virtualLibrarySource = `
  interface ReadonlyArray<T> {
    map<U>(callback: (value: T) => U): U[];
  }

  interface Array<T> extends ReadonlyArray<T> {}
`;
const ambientArrayFileName = "/ambient/array.d.ts";

function createProgramAndContext(
  source: string,
  options: {
    withDefaultLibrary?: boolean;
    withVirtualLibrary?: boolean;
    withAmbientArrayDeclaration?: boolean;
  } = {},
): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  context: TransformationContext;
  program: ts.Program;
} {
  const fileName = "/test.tsx";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.Preserve,
    strict: true,
    noLib: !options.withDefaultLibrary && !options.withVirtualLibrary,
    ...(options.withVirtualLibrary ? { lib: ["es2023.d.ts"] } : {}),
    skipLibCheck: true,
  };

  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    compilerOptions.target!,
    true,
    ts.ScriptKind.TSX,
  );
  const injectedFiles = new Map<string, string>();
  if (options.withVirtualLibrary) {
    injectedFiles.set(virtualLibraryFileName, virtualLibrarySource);
  }
  if (options.withAmbientArrayDeclaration) {
    injectedFiles.set(ambientArrayFileName, virtualLibrarySource);
  }
  const injectedSourceFiles = new Map(
    [...injectedFiles].map(([name, text]) => [
      name,
      ts.createSourceFile(
        name,
        text,
        compilerOptions.target!,
        true,
        ts.ScriptKind.TS,
      ),
    ]),
  );

  const host = ts.createCompilerHost(compilerOptions, true);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNew) => {
    if (name === fileName) return sourceFile;
    return injectedSourceFiles.get(name) ??
      getSourceFile(name, languageVersion, onError, shouldCreateNew);
  };
  host.getCurrentDirectory = () => "/";
  host.getDirectories = () => [];
  host.fileExists = (name) =>
    name === fileName || injectedFiles.has(name) ||
    fileExists(name);
  host.readFile = (name) =>
    name === fileName ? source : injectedFiles.get(name) ?? readFile(name);
  host.writeFile = () => {};
  host.useCaseSensitiveFileNames = () => true;
  host.getCanonicalFileName = (name) => name;
  host.getNewLine = () => "\n";
  if (options.withVirtualLibrary) {
    host.getDefaultLibLocation = () => "/virtual";
  }

  const rootNames = options.withAmbientArrayDeclaration
    ? [ambientArrayFileName, fileName]
    : [fileName];
  const program = ts.createProgram(rootNames, compilerOptions, host);
  const context = new TransformationContext({
    program,
    sourceFile,
    tsContext: { factory: ts.factory } as ts.TransformationContext,
    options: {
      state: new CrossStageState(),
    },
  });

  return { sourceFile, checker: program.getTypeChecker(), context, program };
}

function findFirstNode<T extends ts.Node>(
  sourceFile: ts.SourceFile,
  predicate: (node: ts.Node) => node is T,
): T {
  let found: T | undefined;

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (predicate(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (!found) {
    throw new Error("Expected node not found");
  }

  return found;
}

Deno.test(
  "Callback support policy: plain array map callbacks stay plain-array value callbacks",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(
      `
      const items = [1, 2, 3];
      const result = items.map((item) => item + 1);
    `,
      { withDefaultLibrary: true },
    );

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const semantics = getCallbackBoundarySemantics(callback, checker, context);

    assertEquals(semantics.decision, {
      kind: "supported",
      boundaryKind: "plain-array-value",
      bodyContext: {
        strategy: "inherit-parent",
      },
    });
    assertEquals(semantics.isReactiveArrayMethodCallback, false);
    assertEquals(semantics.allowsRestrictedContextFunctionCallback, true);
    assertEquals(semantics.supportsPatternOwnedWrapperCallbackSite, true);
  },
);

Deno.test(
  "Callback support policy: readonly array map callbacks carry a wrapper site",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(
      `
      const items: readonly number[] = [1, 2, 3];
      const result = items.map((item) => item + 1);
    `,
      { withDefaultLibrary: true },
    );

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const semantics = getCallbackBoundarySemantics(callback, checker, context);

    assertEquals(semantics.isPlainArrayValueCallback, true);
    assertEquals(semantics.supportsPatternOwnedWrapperCallbackSite, true);
  },
);

Deno.test(
  "Callback support policy: virtual library array map callbacks carry a wrapper site",
  () => {
    const { sourceFile, checker, context, program } = createProgramAndContext(
      `
      const items = [1, 2, 3];
      const result = items.map((item) => item + 1);
    `,
      { withVirtualLibrary: true },
    );
    const virtualLibraryFile = program.getSourceFile(virtualLibraryFileName);
    if (!virtualLibraryFile) {
      throw new Error("Expected virtual library source file");
    }
    assertEquals(program.isSourceFileDefaultLibrary(virtualLibraryFile), true);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const semantics = getCallbackBoundarySemantics(callback, checker, context);

    assertEquals(semantics.isPlainArrayValueCallback, true);
    assertEquals(semantics.supportsPatternOwnedWrapperCallbackSite, true);
  },
);

Deno.test(
  "Callback support policy: ambient Array declarations carry no wrapper site",
  () => {
    const { sourceFile, checker, context, program } = createProgramAndContext(
      `
      const items = [1, 2, 3];
      const result = items.map((item) => item + 1);
    `,
      { withAmbientArrayDeclaration: true },
    );
    const ambientArrayFile = program.getSourceFile(ambientArrayFileName);
    if (!ambientArrayFile) {
      throw new Error("Expected ambient Array declaration");
    }
    assertEquals(program.isSourceFileDefaultLibrary(ambientArrayFile), false);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const semantics = getCallbackBoundarySemantics(callback, checker, context);

    assertEquals(semantics.isPlainArrayValueCallback, true);
    assertEquals(semantics.supportsPatternOwnedWrapperCallbackSite, false);
  },
);

Deno.test(
  "Callback support policy: plain array find callbacks stay plain-array value callbacks",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(
      `
      const items = [1, 2, 3];
      const result = items.find((item) => item > 1);
    `,
      { withDefaultLibrary: true },
    );

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const semantics = getCallbackBoundarySemantics(callback, checker, context);

    assertEquals(semantics.decision, {
      kind: "supported",
      boundaryKind: "plain-array-value",
      bodyContext: {
        strategy: "inherit-parent",
      },
    });
    assertEquals(semantics.isReactiveArrayMethodCallback, false);
    assertEquals(semantics.allowsRestrictedContextFunctionCallback, true);
    // `find` reads what the callback returns as a boolean, so a lifted local
    // returned from it would always be truthy.
    assertEquals(semantics.supportsPatternOwnedWrapperCallbackSite, false);
  },
);

Deno.test(
  "Callback support policy: a plain filter callback carries no wrapper site",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(
      `
      const items = [1, 2, 3];
      const result = items.filter((item) => item > 1);
    `,
      { withDefaultLibrary: true },
    );

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const semantics = getCallbackBoundarySemantics(callback, checker, context);

    assertEquals(semantics.isPlainArrayValueCallback, true);
    assertEquals(semantics.supportsPatternOwnedWrapperCallbackSite, false);
  },
);

Deno.test(
  "Callback support policy: a sort comparator carries no wrapper site",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(
      `
      const items = [1, 2, 3];
      const result = items.sort((a, b) => a - b);
    `,
      { withDefaultLibrary: true },
    );

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const semantics = getCallbackBoundarySemantics(callback, checker, context);

    assertEquals(semantics.supportsPatternOwnedWrapperCallbackSite, false);
  },
);

Deno.test(
  "Callback support policy: a map on some other type carries no wrapper site",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      interface Grid<T> {
        map<U>(callback: (value: T) => U): U[];
      }

      declare const grid: Grid<number>;
      const result = grid.map((cell) => cell + 1);
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const semantics = getCallbackBoundarySemantics(callback, checker, context);

    assertEquals(semantics.supportsPatternOwnedWrapperCallbackSite, false);
  },
);

Deno.test(
  "Callback support policy: a source-defined `Array.map()` carries no wrapper site",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      class Array<T> {
        map<U>(callback: (value: T) => U): U[] { return []; }
      }

      const items = new Array<number>();
      const result = items.map((item) => item + 1);
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const semantics = getCallbackBoundarySemantics(callback, checker, context);

    assertEquals(semantics.supportsPatternOwnedWrapperCallbackSite, false);
  },
);

Deno.test(
  "Callback support policy: a callback past argument zero carries no wrapper site",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(
      `
      interface Array<T> {
        map<U>(callback: (value: T) => U, andThen: (value: U) => U): U[];
      }

      const items = [1, 2, 3];
      const result = items.map((item) => item + 1, (item) => item * 2);
    `,
      { withDefaultLibrary: true },
    );

    const callbacks: ts.ArrowFunction[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isArrowFunction(node)) callbacks.push(node);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    assertEquals(
      getCallbackBoundarySemantics(callbacks[0]!, checker, context)
        .supportsPatternOwnedWrapperCallbackSite,
      true,
    );
    assertEquals(
      getCallbackBoundarySemantics(callbacks[1]!, checker, context)
        .supportsPatternOwnedWrapperCallbackSite,
      false,
    );
  },
);

Deno.test(
  "Callback support policy: reactive array-method callbacks stay reactive-owned",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare function cell<T>(value: T): T;

      const result = cell([1, 2, 3]).map((item) => item + 1);
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const semantics = getCallbackBoundarySemantics(callback, checker, context);

    assertEquals(semantics.decision, {
      kind: "supported",
      boundaryKind: "reactive-array-method",
      bodyContext: {
        strategy: "inherit-parent",
      },
    });
    assertEquals(semantics.isReactiveArrayMethodCallback, true);
    assertEquals(semantics.allowsRestrictedContextFunctionCallback, true);
    assertEquals(semantics.supportsPatternOwnedWrapperCallbackSite, true);
  },
);

Deno.test(
  "Callback boundary policy: non-transformed reactive array callbacks inherit parent body context",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare function cell<T>(value: T): T;

      const result = cell([1, 2, 3]).map((item) => item + 1);
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const decision = classifyCallbackBoundary(callback, checker, context);

    assertEquals(decision, {
      kind: "supported",
      boundaryKind: "reactive-array-method",
      bodyContext: {
        strategy: "inherit-parent",
      },
    });
  },
);

Deno.test(
  "Callback boundary policy: transformed array callbacks stay explicit pattern boundaries",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      const items = [1, 2, 3];
      const result = items.map((item) => item + 1);
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    context.markAsArrayMethodCallback(callback);
    const decision = classifyCallbackBoundary(callback, checker, context);

    assertEquals(decision, {
      kind: "supported",
      boundaryKind: "reactive-array-method",
      bodyContext: {
        strategy: "explicit",
        kind: "pattern",
        owner: "array-method",
      },
    });
  },
);

Deno.test(
  "Callback boundary policy: reactive context for transformed array callbacks comes from the shared boundary classifier",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      const items = [1, 2, 3];
      const result = items.map((item) => item + 1);
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    context.markAsArrayMethodCallback(callback);
    const info = classifyReactiveContext(callback.body, checker, context);

    assertEquals(info.kind, "pattern");
    assertEquals(info.owner, "array-method");
  },
);

describe("terminal array callback context", () => {
  for (const method of ["map", "filter"]) {
    it(`keeps a function-valued ${method} thisArg outside the callback boundary`, () => {
      const { sourceFile, checker, context } = createProgramAndContext(`
        [1].map((outer) => [outer].${method}(
          (inner) => inner,
          (function thisValue() { return outer; }),
        ).slice(0, 1));
      `);
      const outer = findFirstNode(sourceFile, ts.isArrowFunction);
      context.markAsArrayMethodCallback(outer);
      const call = findFirstNode(
        sourceFile,
        (node): node is ts.CallExpression =>
          ts.isCallExpression(node) && node.arguments.length === 2 &&
          ts.isArrowFunction(node.arguments[0]!),
      );
      const callback = call.arguments[0]!;
      if (!ts.isArrowFunction(callback)) {
        throw new Error("Expected the array method callback");
      }
      const thisValue = findFirstNode(sourceFile, ts.isFunctionExpression);

      expect(classifyReactiveContext(callback.body, checker, context)).toEqual({
        kind: "compute",
        owner: "unknown",
        inJsxExpression: false,
      });
      expect(classifyReactiveContext(thisValue.body, checker, context)).toEqual(
        {
          kind: "pattern",
          owner: "array-method",
          inJsxExpression: false,
        },
      );
    });
  }
});

Deno.test(
  "Callback support policy: event handlers stay outside the generic safe-wrapper callback bucket",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          button: any;
        }
      }

      const view = <button onClick={() => 1} />;
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const semantics = getCallbackBoundarySemantics(callback, checker, context);

    assertEquals(semantics.decision, {
      kind: "supported",
      boundaryKind: "event-handler",
      bodyContext: {
        strategy: "explicit",
        kind: "compute",
        owner: "handler",
      },
    });
    assertEquals(semantics.allowsRestrictedContextFunctionCallback, false);
    assertEquals(semantics.supportsPatternOwnedWrapperCallbackSite, false);
  },
);

Deno.test(
  "Callback boundary policy: reactive context for event handlers comes from the shared boundary classifier",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          button: any;
        }
      }

      const view = <button onClick={() => 1} />;
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const info = classifyReactiveContext(callback.body, checker, context);

    assertEquals(info.kind, "compute");
    assertEquals(info.owner, "handler");
  },
);

Deno.test(
  "Callback boundary policy: unsupported callbacks inside JSX become boundary-owned callback-container errors",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      const view = <div>{[1, 2, 3].forEach((item) => item + 1)}</div>;
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const decision = classifyCallbackBoundary(callback, checker, context);

    assertEquals(decision, {
      kind: "unsupported",
      boundaryKind: "unsupported-container",
      boundaryDiagnostic: "callback-container",
      bodyContext: {
        strategy: "explicit",
        kind: "compute",
        owner: "unknown",
      },
    });
  },
);

Deno.test(
  "Callback boundary policy: unsupported callbacks outside JSX inherit parent context",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      const items = [1, 2, 3];
      items.forEach((item) => item + 1);
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const decision = classifyCallbackBoundary(callback, checker, context);

    assertEquals(decision, {
      kind: "unsupported",
      boundaryKind: "unsupported-container",
      boundaryDiagnostic: "function-creation",
      bodyContext: {
        strategy: "inherit-parent",
      },
    });
  },
);

Deno.test(
  "Callback boundary policy: unresolved property-access pattern fallback stays pattern-owned",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      const builders = {} as any;
      const value = builders.pattern((input: unknown) => input);
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const decision = classifyCallbackBoundary(callback, checker, context);

    assertEquals(decision, {
      kind: "supported",
      boundaryKind: "pattern-builder",
      bodyContext: {
        strategy: "explicit",
        kind: "pattern",
        owner: "pattern",
      },
    });
  },
);

Deno.test(
  "Callback boundary policy: unresolved property-access patternTool fallback stays compute-owned",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      const helpers = {} as any;
      const tool = helpers.patternTool((input: { value?: string }) => input?.value);
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const decision = classifyCallbackBoundary(callback, checker, context);

    assertEquals(decision, {
      kind: "supported",
      boundaryKind: "pattern-tool",
      bodyContext: {
        strategy: "explicit",
        kind: "compute",
        owner: "unknown",
      },
    });
  },
);

Deno.test(
  "Callback boundary policy: shadowed local pattern helper does not use name-only fallback",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      const pattern = <T,>(fn: T) => fn;
      const value = pattern((input: unknown) => input);
    `);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "pattern",
    );
    const callback = call.arguments[0];
    if (!callback || !ts.isArrowFunction(callback)) {
      throw new Error("Expected inline pattern callback");
    }
    const decision = classifyCallbackBoundary(callback, checker, context);

    assertEquals(decision, {
      kind: "unsupported",
      boundaryKind: "unsupported-container",
      boundaryDiagnostic: "function-creation",
      bodyContext: {
        strategy: "inherit-parent",
      },
    });
  },
);

Deno.test(
  "Callback boundary policy: shadowed local patternTool helper does not use name-only fallback",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      const patternTool = <T,>(fn: T) => fn;
      const tool = patternTool((input: { value?: string }) => input?.value);
    `);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "patternTool",
    );
    const callback = call.arguments[0];
    if (!callback || !ts.isArrowFunction(callback)) {
      throw new Error("Expected inline patternTool callback");
    }
    const decision = classifyCallbackBoundary(callback, checker, context);

    assertEquals(decision, {
      kind: "unsupported",
      boundaryKind: "unsupported-container",
      boundaryDiagnostic: "function-creation",
      bodyContext: {
        strategy: "inherit-parent",
      },
    });
  },
);

Deno.test(
  "Callback support policy: foreign void array containers remain unsupported",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      interface Array<T> {
        forEach(callback: (value: T) => void): void;
      }

      const items = [1, 2, 3];
      items.forEach((item) => item + 1);
    `);

    const callback = findFirstNode(sourceFile, ts.isArrowFunction);
    const semantics = getCallbackBoundarySemantics(callback, checker, context);

    assertEquals(semantics.decision, {
      kind: "unsupported",
      boundaryKind: "plain-array-void",
      boundaryDiagnostic: "function-creation",
      bodyContext: {
        strategy: "inherit-parent",
      },
    });
    assertEquals(semantics.allowsRestrictedContextFunctionCallback, false);
    assertEquals(semantics.supportsPatternOwnedWrapperCallbackSite, false);
  },
);
