import { assertEquals } from "@std/assert";
import ts from "typescript";

import { classifyCallbackBoundary } from "../../src/policy/callback-boundary.ts";

function createProgramWithFiles(
  files: Record<string, string>,
  entryFileName = "/test.tsx",
): { sourceFile: ts.SourceFile; checker: ts.TypeChecker } {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
    skipLibCheck: true,
    jsx: ts.JsxEmit.Preserve,
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
        ? ts.createSourceFile(
          name,
          files[name]!,
          languageVersion,
          true,
          name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        )
        : undefined,
    resolveModuleNames: (moduleNames) =>
      moduleNames.map((name) => {
        const directMatch = Object.keys(files).find((fileName) =>
          fileName === `/${name}.d.ts` || fileName.endsWith(`/${name}.d.ts`)
        );
        if (!directMatch) return undefined;
        return {
          resolvedFileName: directMatch,
          extension: ts.Extension.Dts,
          isExternalLibraryImport: false,
        };
      }),
  };

  const program = ts.createProgram([entryFileName], compilerOptions, host);
  const sourceFile = program.getSourceFile(entryFileName);
  if (!sourceFile) throw new Error("Expected entry source file");
  return { sourceFile, checker: program.getTypeChecker() };
}

/** Find the second argument arrow of the first `table(cols, (row) => …)` call. */
function findTableRowCallback(
  sourceFile: ts.SourceFile,
): ts.ArrowFunction {
  let found: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node): void => {
    if (
      !found &&
      ts.isCallExpression(node) &&
      node.arguments.length >= 2 &&
      ts.isArrowFunction(node.arguments[1]!)
    ) {
      found = node.arguments[1] as ts.ArrowFunction;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error("Expected a table row callback");
  return found;
}

const SQLITE_TYPINGS = `
export type SqliteTableFunction = <T>(
  columns: T,
  rule: (row: Record<string, unknown>) => unknown,
) => unknown;
export declare const table: SqliteTableFunction;
`;

Deno.test("classifyCallbackBoundary: a SQLite table row rule is a compute-owned supported boundary", () => {
  const { sourceFile, checker } = createProgramWithFiles({
    "/commonfabric.d.ts": SQLITE_TYPINGS,
    "/test.tsx": `
      import { table } from "commonfabric";
      const result = table(
        { id: "id", name: "name" },
        (row) => ({ display: row.name }),
      );
    `,
  });

  const callback = findTableRowCallback(sourceFile);
  assertEquals(classifyCallbackBoundary(callback, checker), {
    kind: "supported",
    boundaryKind: "sqlite-row-label-rule",
    bodyContext: {
      strategy: "explicit",
      kind: "compute",
      owner: "unknown",
    },
  });
});

Deno.test("classifyCallbackBoundary: a user-defined table alias does not match the SQLite rule", () => {
  // A local alias must not match, whether its name resembles the framework's
  // alias or belongs to an unrelated API.
  for (const alias of ["SqliteTableFunction", "UserTableFunction"]) {
    const { sourceFile, checker } = createProgramWithFiles({
      "/test.tsx": `
      type ${alias} = <T>(
        columns: T,
        rule: (row: Record<string, unknown>) => unknown,
      ) => unknown;
      declare const table: ${alias};
      const result = table(
        { id: "id" },
        (row) => ({ display: row.id }),
      );
    `,
    });

    const callback = findTableRowCallback(sourceFile);
    const decision = classifyCallbackBoundary(callback, checker);
    assertEquals(
      decision.kind !== "supported" || decision.boundaryKind !==
          "sqlite-row-label-rule",
      true,
    );
  }
});
