import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts, { type DiagnosticMessageChain } from "typescript";
import {
  type AuthoredSourceLookup,
  CompilationError,
  CompilerError,
  type DiagnosticMessageTransformer,
  formatTransformerDiagnostic,
} from "../typescript/diagnostics/errors.ts";
import { Checker } from "../typescript/diagnostics/mod.ts";

// errors.ts keeps a local mirror of `ts.flattenDiagnosticMessageText` so the
// module stays free of typescript value imports (it is boot-eager in the
// runtime worker). These tests pin the mirror to the real thing.

function chainDiagnostic(
  messageText: string | DiagnosticMessageChain,
): ts.Diagnostic {
  return {
    category: ts.DiagnosticCategory.Error,
    code: 1,
    file: undefined,
    start: undefined,
    length: undefined,
    messageText,
  };
}

describe("CompilationError message flattening", () => {
  it("flattens nested message chains byte-identically to typescript", () => {
    const chain: DiagnosticMessageChain = {
      messageText: "Type 'A' is not assignable to type 'B'.",
      category: ts.DiagnosticCategory.Error,
      code: 2322,
      next: [
        {
          messageText: "Types of property 'x' are incompatible.",
          category: ts.DiagnosticCategory.Error,
          code: 2326,
          next: [
            {
              messageText: "Type 'string' is not assignable to type 'number'.",
              category: ts.DiagnosticCategory.Error,
              code: 2322,
            },
            {
              messageText: "A sibling elaboration at the same depth.",
              category: ts.DiagnosticCategory.Message,
              code: 0,
            },
          ],
        },
      ],
    };
    const error = new CompilationError({ diagnostic: chainDiagnostic(chain) });
    expect(error.message).toBe(ts.flattenDiagnosticMessageText(chain, "\n"));
    expect(error.type).toBe("ERROR");
  });

  it("passes plain string messages through and classifies module-not-found", () => {
    const plain = new CompilationError({
      diagnostic: chainDiagnostic("Cannot find module './missing.ts'."),
    });
    expect(plain.type).toBe("MODULE_NOT_FOUND");
    expect(plain.message).toBe("Cannot find module './missing.ts'.");
  });

  it("applies a message transformer over the flattened text", () => {
    const transformer: DiagnosticMessageTransformer = (message) =>
      message.includes("assignable") ? `friendly: ${message}` : null;
    const chain: DiagnosticMessageChain = {
      messageText: "Type 'A' is not assignable to type 'B'.",
      category: ts.DiagnosticCategory.Error,
      code: 2322,
    };
    const error = new CompilationError(
      { diagnostic: chainDiagnostic(chain) },
      transformer,
    );
    expect(error.message).toBe(
      `friendly: ${ts.flattenDiagnosticMessageText(chain, "\n")}`,
    );
  });
});

// Just enough globals for the checker to type small programs without the real
// libs; kept under the `$types/` prefix so `checkableSources()` filters it the
// way the production host's virtual lib dir is filtered.
const MINIMAL_LIB = `
interface Boolean {}
interface Function {}
interface CallableFunction {}
interface NewableFunction {}
interface IArguments {}
interface Number {}
interface Object {}
interface RegExp {}
interface String {}
interface Array<T> { length: number; [n: number]: T; }
interface SymbolConstructor { (description?: string): symbol; }
declare var Symbol: SymbolConstructor;
interface Symbol { toString(): string; }
`;

/** A real ts.Program over in-memory sources, minimal host, no disk. */
function programFor(files: Record<string, string>): ts.Program {
  const all: Record<string, string> = {
    "$types/lib.d.ts": MINIMAL_LIB,
    ...files,
  };
  const host: ts.CompilerHost = {
    fileExists: (fileName) => fileName in all,
    readFile: (fileName) => all[fileName],
    getSourceFile: (fileName, languageVersion) =>
      fileName in all
        ? ts.createSourceFile(fileName, all[fileName], languageVersion)
        : undefined,
    getDefaultLibFileName: () => "$types/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (fileName) => fileName,
    getNewLine: () => "\n",
    useCaseSensitiveFileNames: () => true,
  };
  return ts.createProgram(Object.keys(all), {
    strict: true,
    declaration: false,
    noResolve: true,
    module: ts.ModuleKind.CommonJS,
  }, host);
}

describe("Checker", () => {
  // The compile pipeline steps through checkableSources()/collect* one file at
  // a time (compileToModulesSteps); typeCheck()/declarationCheck() remain the
  // whole-program one-call contract with no other production caller, so they
  // are pinned directly here.

  it("checkableSources excludes the virtual type libs", () => {
    const checker = new Checker(
      programFor({ "/ok.ts": "export const x: number = 1;" }),
    );
    expect(checker.checkableSources().map((source) => source.fileName))
      .toEqual(["/ok.ts"]);
  });

  it("typeCheck passes a well-typed program", () => {
    const checker = new Checker(
      programFor({ "/ok.ts": "export const x: number = 1;" }),
    );
    checker.typeCheck();
  });

  it("typeCheck throws an aggregated CompilerError on a type error", () => {
    const checker = new Checker(
      programFor({ "/bad.ts": "export const x: number = 'nope';" }),
    );
    let thrown: unknown;
    try {
      checker.typeCheck();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CompilerError);
    expect((thrown as CompilerError).message).toContain(
      "Type 'string' is not assignable to type 'number'.",
    );
    expect((thrown as CompilerError).errors.map((e) => e.file)).toEqual([
      "/bad.ts",
    ]);
  });

  it("declarationCheck passes a program with portable exported types", () => {
    const checker = new Checker(
      programFor({ "/ok.ts": "export const x: number = 1;" }),
    );
    checker.declarationCheck();
  });

  it("declarationCheck throws when an exported type uses a private name", () => {
    // A function-scoped unique symbol cannot be hoisted into the declaration
    // file, so declaration diagnostics report TS4025 while the semantic check
    // stays clean.
    const checker = new Checker(programFor({
      "/leak.ts":
        "function f() { const s: unique symbol = Symbol(); return { [s]: 1 }; }\n" +
        "export const v = f();",
    }));
    checker.typeCheck();
    expect(() => checker.declarationCheck()).toThrow(
      "Exported variable 'v' has or is using private name 's'.",
    );
  });

  it("declarationCheck skips known exported-symbol false positives", () => {
    // Identical TS4025 shape, but the private name matches a
    // KNOWN_EXPORTED_SYMBOLS entry — a known TypeScript false positive for the
    // commonfabric brand symbols, filtered rather than surfaced.
    const checker = new Checker(programFor({
      "/brand.ts":
        "function f() { const CELL_BRAND: unique symbol = Symbol(); return { [CELL_BRAND]: 1 }; }\n" +
        "export const v = f();",
    }));
    checker.declarationCheck();
  });

  it("check() tolerates empty diagnostics and throws a CompilerError otherwise", () => {
    const checker = new Checker(
      programFor({ "/ok.ts": "export const x: number = 1;" }),
    );
    checker.check(undefined);
    checker.check([]);

    let thrown: unknown;
    try {
      checker.check([chainDiagnostic("manufactured emit failure")]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CompilerError);
    expect((thrown as CompilerError).message).toContain(
      "manufactured emit failure",
    );
  });

  it("check() routes messages through the diagnostic message transformer", () => {
    const checker = new Checker(
      programFor({ "/ok.ts": "export const x: number = 1;" }),
      {
        messageTransformer: (message) =>
          message.includes("manufactured") ? `clearer: ${message}` : null,
      },
    );
    expect(() => checker.check([chainDiagnostic("manufactured emit failure")]))
      .toThrow("clearer: manufactured emit failure");
  });
});

describe("authored source locations", () => {
  // A caller that adds a line ahead of the authored text, as the runtime
  // engine's helper injection does, hands the compiler a lookup from each
  // compiler input to its authored text and the line shift between them.

  /** A lookup holding one authored file, one line shorter at the top. */
  function injectedOneLine(
    fileName: string,
    authored: string,
  ): AuthoredSourceLookup {
    return (name) =>
      name === fileName ? { contents: authored, lineOffset: -1 } : undefined;
  }

  /** The CompilerError a type check of `files` throws. */
  function typeCheckError(
    files: Record<string, string>,
    authoredSource: AuthoredSourceLookup,
  ): CompilerError {
    const checker = new Checker(programFor(files), { authoredSource });
    try {
      checker.typeCheck();
    } catch (error) {
      if (error instanceof CompilerError) return error;
      throw error;
    }
    throw new Error("Expected the type check to throw");
  }

  it("names the authored line and quotes the authored text in a type error", () => {
    const authored = "export const x: number = 'nope';";
    const error = typeCheckError(
      { "/bad.ts": `// added\n${authored}` },
      injectedOneLine("/bad.ts", authored),
    );

    expect(error.errors.map((e) => e.line)).toEqual([1]);
    expect(error.message).toContain(`1 | ${authored}`);
    expect(error.message).not.toContain("// added");
  });

  it("keeps the compiler input's line for a diagnostic on a line the caller added", () => {
    const error = typeCheckError(
      { "/bad.ts": "export const y: number = 'no';\nexport const x = 1;" },
      injectedOneLine("/bad.ts", "export const x = 1;"),
    );

    expect(error.errors.map((e) => e.line)).toEqual([1]);
    expect(error.message).toContain("1 | export const y: number = 'no';");
  });

  it("names the authored line in a formatted transformer diagnostic", () => {
    const formatted = formatTransformerDiagnostic(
      {
        severity: "error",
        type: "module-scope:let-declaration",
        message: "no `let` here",
        fileName: "/main.ts",
        line: 2,
        column: 1,
        start: 9,
        length: 3,
      },
      "// added\nlet x = 0;",
      injectedOneLine("/main.ts", "let x = 0;"),
    );

    expect(formatted).toContain("/main.ts:1:1 - error: no `let` here");
    expect(formatted).toContain("1 | let x = 0;");
  });

  it("names the compiler input's line in a formatted transformer diagnostic without a lookup", () => {
    const formatted = formatTransformerDiagnostic(
      {
        severity: "error",
        type: "module-scope:let-declaration",
        message: "no `let` here",
        fileName: "/main.ts",
        line: 2,
        column: 1,
        start: 9,
        length: 3,
      },
      "// added\nlet x = 0;",
    );

    expect(formatted).toContain("/main.ts:2:1 - error: no `let` here");
    expect(formatted).toContain("2 | let x = 0;");
  });
});
