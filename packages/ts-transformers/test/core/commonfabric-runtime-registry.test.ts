import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";

import ts from "typescript";

import { COMMONFABRIC_RUNTIME_EXPORTS_BY_NAME } from "../../src/core/commonfabric-runtime-registry.ts";

const FACTORY_URL = new URL(
  "../../../runner/src/builder/factory.ts",
  import.meta.url,
);

/**
 * The modules whose exports `factory.ts` injects as callables, each of which
 * needs a registry entry: the builder modules, and `@commonfabric/identity/did`.
 * The guard sees only exports imported from these, so a module that a new
 * callable is imported from has to be added here.
 */
const TRACKED_IMPORT_SOURCES = new Set([
  "@commonfabric/identity/did",
  "./built-in.ts",
  "./current-principal.ts",
  "./event-key.ts",
  "./module.ts",
  "./pattern.ts",
  "./space-access.ts",
  "./space-access-change.ts",
  "./space-access-notice.ts",
]);

function getPropertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function extractInjectedCallableExports(sourceText: string): string[] {
  const sourceFile = ts.createSourceFile(
    FACTORY_URL.pathname,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const importedIdentifiers = new Map<string, string>();
  const localBindings = new Map<string, ts.Expression>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }

    const importSource = statement.moduleSpecifier.text;
    for (const specifier of statement.importClause.namedBindings.elements) {
      importedIdentifiers.set(specifier.name.text, importSource);
    }
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer
      ) {
        localBindings.set(declaration.name.text, declaration.initializer);
      }
    }
  }

  // The object literal is the one annotated with the builder surface type.
  // `factory.ts` annotates it rather than casting, so the compiler checks it
  // against what `@commonfabric/api` declares; that annotation is the durable
  // marker for it, where the name of the local holding it is not.
  //
  // More than one declaration names that type, so every match is collected and
  // exactly one is required to carry a literal. Taking the first would bind
  // this guard to traversal order, and a second literal appearing later would
  // narrow what it reads without failing.
  const isBuilderSurfaceAnnotation = (node: ts.VariableDeclaration) =>
    node.type !== undefined &&
    sourceText.slice(node.type.pos, node.type.end).includes(
      "BuilderFunctionsAndConstants",
    );

  const candidates: ts.ObjectLiteralExpression[] = [];
  ts.forEachChild(sourceFile, function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      isBuilderSurfaceAnnotation(node) &&
      node.initializer
    ) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isObjectLiteralExpression(initializer)) {
        candidates.push(initializer);
        return;
      }
    }
    ts.forEachChild(node, visit);
  });

  assertEquals(
    candidates.length,
    1,
    "Expected exactly one object literal annotated with the builder surface " +
      `type in runner builder factory, found ${candidates.length}`,
  );
  const commonfabricObject = candidates[0];

  const injectedExports = new Set<string>();
  for (const property of commonfabricObject.properties) {
    const exportName = ts.isShorthandPropertyAssignment(property)
      ? property.name.text
      : ts.isPropertyAssignment(property)
      ? getPropertyNameText(property.name)
      : undefined;
    const valueIdentifier = ts.isShorthandPropertyAssignment(property)
      ? property.name.text
      : ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.initializer)
      ? property.initializer.text
      : undefined;
    if (!exportName || !valueIdentifier) continue;

    for (
      const importSource of collectReferencedImportSources(
        valueIdentifier,
        importedIdentifiers,
        localBindings,
      )
    ) {
      if (TRACKED_IMPORT_SOURCES.has(importSource)) {
        injectedExports.add(exportName);
        break;
      }
    }
  }

  return [...injectedExports].sort();
}

function collectReferencedImportSources(
  identifier: string,
  importedIdentifiers: ReadonlyMap<string, string>,
  localBindings: ReadonlyMap<string, ts.Expression>,
  visiting = new Set<string>(),
): Set<string> {
  const directImportSource = importedIdentifiers.get(identifier);
  if (directImportSource) {
    return new Set([directImportSource]);
  }

  if (visiting.has(identifier)) {
    return new Set();
  }

  const initializer = localBindings.get(identifier);
  if (!initializer) {
    return new Set();
  }

  visiting.add(identifier);
  const referencedSources = new Set<string>();
  ts.forEachChild(initializer, function visit(node) {
    if (ts.isIdentifier(node)) {
      for (
        const source of collectReferencedImportSources(
          node.text,
          importedIdentifiers,
          localBindings,
          visiting,
        )
      ) {
        referencedSources.add(source);
      }
      return;
    }
    ts.forEachChild(node, visit);
  });
  visiting.delete(identifier);
  return referencedSources;
}

describe("COMMONFABRIC_RUNTIME_EXPORT_REGISTRY", () => {
  it("covers every imported callable injected by runner builder factory", async () => {
    const factorySource = await Deno.readTextFile(FACTORY_URL);
    const injectedExports = extractInjectedCallableExports(factorySource);
    const missing = injectedExports.filter((name) =>
      !COMMONFABRIC_RUNTIME_EXPORTS_BY_NAME.has(name)
    );

    assertEquals(
      missing,
      [],
      [
        "builder/factory.ts injects callable exports that are missing from COMMONFABRIC_RUNTIME_EXPORT_REGISTRY.",
        `Missing exports: ${missing.join(", ") || "(none)"}`,
        "Add each export to src/core/commonfabric-runtime-registry.ts and explicitly decide whether reactiveOrigin should be true or false.",
        "If the export needs dedicated detection behavior, also update src/ast/call-kind.ts to map it to the right CallKind.",
      ].join("\n"),
    );
  });
});
