import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import ts from "typescript";

import {
  assertNoEmitErrors,
  declarationName,
  findEmitted,
  flatten,
  formatTypeScript,
  generateCfcTypes,
  withExport,
} from "./generate-cfc-types.ts";

/**
 * Tests for the `commonfabric/cfc` type generator.
 *
 * The first three are contract tests: they prove the generated
 * `assets/types/cfc.ts` is what the in-memory pattern compiler can consume for
 * authored pattern code — a self-contained, declaration-only module that
 * exposes exactly the public authoring surface. The rest exercise the
 * generator's own code paths directly.
 *
 * These tests read files, load the TypeScript compiler, and spawn `deno fmt`,
 * so they run under the Deno test runner only. They live beside the generator
 * under `scripts/`, where the recursive deno-test task finds them but the
 * browser-bundled `test/*.test.ts` pass does not.
 */

const GENERATED_URL = new URL("../assets/types/cfc.ts", import.meta.url);
const AUTHORING_URL = new URL("../../api/cfc-authoring.ts", import.meta.url);

function parse(text: string, name = "x.d.ts"): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
}

function parseFile(url: URL): ts.SourceFile {
  return parse(Deno.readTextFileSync(url), url.pathname);
}

/** Names re-exported by `export { ... } from "..."` / `export type { ... }`. */
function reExportedNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

/** Names exported by inline declarations (`export type X`, `export const X`). */
function exportedDeclarationNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    const isExported = ts.canHaveModifiers(statement) &&
      (ts.getModifiers(statement) ?? []).some((modifier) =>
        modifier.kind === ts.SyntaxKind.ExportKeyword
      );
    if (!isExported) continue;
    if (
      ts.isTypeAliasDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isFunctionDeclaration(statement)
    ) {
      if (statement.name) names.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    }
  }
  return names;
}

Deno.test("generated cfc types expose exactly the public authoring surface", () => {
  const authored = reExportedNames(parseFile(AUTHORING_URL));
  const generated = exportedDeclarationNames(parseFile(GENERATED_URL));

  assert(authored.size > 0, "expected the authoring module to export names");
  assertEquals(
    [...generated].sort(),
    [...authored].sort(),
    "generated module must export exactly the authoring surface",
  );
});

Deno.test("generated cfc types are self-contained", () => {
  const source = parseFile(GENERATED_URL);
  // The in-memory compiler serves this module as a single text and cannot
  // follow relative imports, so there must be no imports or re-exports.
  for (const statement of source.statements) {
    assert(
      !ts.isImportDeclaration(statement),
      "generated module must not contain imports",
    );
    assert(
      !(ts.isExportDeclaration(statement) && statement.moduleSpecifier),
      "generated module must not re-export from another module",
    );
  }
});

Deno.test("generated cfc types are declaration-only", () => {
  const source = parseFile(GENERATED_URL);
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      const isDeclared = (ts.getModifiers(statement) ?? []).some((modifier) =>
        modifier.kind === ts.SyntaxKind.DeclareKeyword
      );
      assert(
        isDeclared,
        "every value declaration must be `declare` so no runtime JavaScript is emitted",
      );
    }
    assert(
      !ts.isExpressionStatement(statement),
      "generated module must not contain executable statements",
    );
    if (ts.isFunctionDeclaration(statement)) {
      assert(!statement.body, "function declarations must not carry a body");
    }
  }
});

Deno.test("generated cfc pattern constructors retain their public types", () => {
  const generated = Deno.readTextFileSync(GENERATED_URL);
  assert(
    generated.includes(
      "export declare const cfcPattern: CfcPatternConstructors;",
    ),
    "cfcPattern must not degrade to any in the in-memory compiler types",
  );
});

Deno.test("generateCfcTypes reproduces the checked-in module", async () => {
  const generated = await generateCfcTypes();
  assertEquals(
    generated,
    Deno.readTextFileSync(GENERATED_URL),
    "generator output must match the committed file (run `deno task gen-cfc-types`)",
  );
});

Deno.test("findEmitted throws when no emitted file matches", () => {
  assertThrows(
    () => findEmitted(new Map(), "missing.d.ts"),
    Error,
    "missing.d.ts",
  );
});

Deno.test("assertNoEmitErrors throws on error diagnostics", () => {
  assertNoEmitErrors([]);
  assertThrows(
    () =>
      assertNoEmitErrors([{
        category: ts.DiagnosticCategory.Error,
        code: 9999,
        file: undefined,
        start: undefined,
        length: undefined,
        messageText: "synthetic emit failure",
      }]),
    Error,
    "Declaration emit reported errors",
  );
});

Deno.test("withExport throws on an unsupported declaration kind", () => {
  const statement = parse("doThing();").statements[0];
  assertThrows(() => withExport(statement, true), Error, "Unsupported");
});

Deno.test("declarationName returns undefined for a non-declaration", () => {
  assertEquals(declarationName(parse("doThing();").statements[0]), undefined);
});

Deno.test("flatten preserves public declaration-only functions", () => {
  const body = flatten(
    "export declare function make<T>(value: T): Box<T>;\ninterface Box<T> { value: T }\n",
    "x.d.ts",
    new Set(["make"]),
  );
  assert(body.includes("export declare function make<T>"));
  assert(body.includes("interface Box<T>"));
  assert(!body.includes("export interface Box<T>"));
});

Deno.test("flatten skips non-declarations and drops unreferenced types", () => {
  const body = flatten(
    "doThing();\nexport type Keep = string;\ntype Drop = number;\n",
    "x.d.ts",
    new Set(["Keep"]),
  );
  assert(
    body.includes("export type Keep"),
    "kept public type must be exported",
  );
  assert(!body.includes("Drop"), "unreferenced helper must be dropped");
});

Deno.test("flatten throws when a public export has no declaration", () => {
  assertThrows(
    () => flatten("export type A = string;\n", "x.d.ts", new Set(["Missing"])),
    Error,
    "Missing",
  );
});

Deno.test("formatTypeScript rejects input that deno fmt cannot parse", async () => {
  await assertRejects(
    () => formatTypeScript("const = ;\n"),
    Error,
    "deno fmt failed",
  );
});
