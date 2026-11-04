import type ts from "typescript";
// Typescript-free contract module (see engine.ts) — safe to import eagerly
// without pulling the compiler stack onto this module's graph.
import { compilerStack } from "./deferred-compiler-stack.ts";
import { RuntimeProgram } from "./types.ts";

// For each source file in the program, inject the internal helper import used
// by the AST transformer. Every file is transformed.
//
// `tolerateStoredLegacyEnvelope` (CT-1838): pre-#4158 pipelines persisted the
// helper-INJECTED form as the source-of-record, so re-injecting a stored
// legacy doc trips the reserved-symbol guard (`checkCFHelperVar`) and bricks
// every pre-#4158 pattern on cold load. When the option is set, files whose
// bytes are EXACTLY the legacy envelope (`isLegacyInjectedEnvelope` — exact
// prefix + trailer, nothing looser) pass through UNCHANGED: they already
// carry the helper import and `h` shim the compiler needs, and they never
// reach `transformCfDirective`, so the guard never fires for them. Set this
// ONLY for storage-fetched, Merkle-verified input (the engine's cold
// recovery path and fabric mounts). Authoring paths
// (`pretransformProgramForModules`) never set it — authored source
// containing `__cfHelpers` keeps throwing, so the poison can never be
// WRITTEN again; tolerance exists only for what history already stored.
// Skipping `normalizeMixedModuleImports` for these files is safe: the
// pre-#4158 pipeline normalized before storage, so stored legacy bytes are
// already normalized.
export function transformInjectHelperModule(
  program: RuntimeProgram,
  options: { tolerateStoredLegacyEnvelope?: boolean } = {},
): RuntimeProgram {
  // Deferred compiler stack (parses + prints): pretransform only runs on
  // compile flows, which await ensureCompilerStack() at their entry.
  const { isLegacyInjectedEnvelope, transformCfDirective } = compilerStack();
  const dataFiles = new Set(program.dataFiles ?? []);
  return {
    main: program.main,
    files: program.files.map((source) => {
      if (source.name.endsWith(".d.ts") || dataFiles.has(source.name)) {
        return { name: source.name, contents: source.contents };
      }
      // CT-1838 tolerance: an exact legacy-envelope stored doc passes
      // through unchanged. Checked before the directive warning below —
      // envelope docs are machine-written pretransform output, not authored
      // source, so the author-facing warning would be noise on them.
      if (
        options.tolerateStoredLegacyEnvelope === true &&
        isLegacyInjectedEnvelope(source.contents)
      ) {
        return { name: source.name, contents: source.contents };
      }
      return {
        name: source.name,
        contents: transformCfDirective(
          source.contents,
          source.name,
          normalizeMixedModuleImports,
        ),
      };
    }),
    mainExport: program.mainExport,
    sourceRoots: program.sourceRoots,
    dataFiles: program.dataFiles,
  };
}

// Inject the helper import and prefix every file with `id`, which namespaces
// this load's source-map and diagnostic coordinates. The program entry is the
// prefixed main module.
export function pretransformProgramForModules(
  program: RuntimeProgram,
  id: string,
): RuntimeProgram {
  program = transformInjectHelperModule(program);
  return {
    main: prefix(program.main, id),
    files: program.files.map((source) => ({
      name: prefix(source.name, id),
      contents: source.contents,
    })),
    ...(program.mainExport !== undefined
      ? { mainExport: program.mainExport }
      : {}),
    ...(program.sourceRoots !== undefined
      ? { sourceRoots: program.sourceRoots.map((root) => prefix(root, id)) }
      : {}),
    ...(program.dataFiles !== undefined
      ? { dataFiles: program.dataFiles.map((data) => prefix(data, id)) }
      : {}),
  };
}

function prefix(filename: string, id: string): string {
  return `/${id}${filename}`;
}

/**
 * Rewrites each import that takes a module's default export beside or inside
 * a named-import list as a default import, followed by a named import of the
 * remaining names if any, keeping the statement's line count. It reads the
 * parse the helper injection made of `source`, so one parse serves both. The
 * helper import and the shim the injection adds around `source` hold no such
 * import, so rewriting `source` alone gives what rewriting the injected text
 * would.
 */
function normalizeMixedModuleImports(
  source: string,
  sourceFile: ts.SourceFile,
): string {
  const { ts: tsc } = compilerStack();
  const printer = tsc.createPrinter({ newLine: tsc.NewLineKind.LineFeed });
  const replacements: { start: number; end: number; text: string }[] = [];

  for (const statement of sourceFile.statements) {
    if (
      !tsc.isImportDeclaration(statement) ||
      !statement.importClause ||
      !statement.importClause.namedBindings ||
      !tsc.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }

    const { importClause } = statement;
    const namedBindings = importClause.namedBindings as ts.NamedImports;

    let rewrittenStatements: ts.ImportDeclaration[] | undefined;
    if (importClause.name) {
      rewrittenStatements = [
        tsc.factory.createImportDeclaration(
          statement.modifiers,
          tsc.factory.createImportClause(
            importClause.isTypeOnly,
            tsc.factory.createIdentifier(importClause.name.text),
            undefined,
          ),
          cloneModuleSpecifier(statement.moduleSpecifier),
          cloneImportAttributes(statement.attributes, sourceFile),
        ),
        tsc.factory.createImportDeclaration(
          statement.modifiers,
          tsc.factory.createImportClause(
            importClause.isTypeOnly,
            undefined,
            cloneNamedImports(namedBindings, sourceFile),
          ),
          cloneModuleSpecifier(statement.moduleSpecifier),
          cloneImportAttributes(statement.attributes, sourceFile),
        ),
      ];
    } else {
      const defaultSpecifier = namedBindings.elements.find((
        element,
      ) => element.propertyName?.text === "default");
      if (!defaultSpecifier) {
        continue;
      }

      const remainingElements = namedBindings.elements.filter((
        element,
      ) => element !== defaultSpecifier);
      rewrittenStatements = [
        tsc.factory.createImportDeclaration(
          statement.modifiers,
          tsc.factory.createImportClause(
            importClause.isTypeOnly || defaultSpecifier.isTypeOnly,
            tsc.factory.createIdentifier(defaultSpecifier.name.text),
            undefined,
          ),
          cloneModuleSpecifier(statement.moduleSpecifier),
          cloneImportAttributes(statement.attributes, sourceFile),
        ),
      ];

      if (remainingElements.length > 0) {
        rewrittenStatements.push(
          tsc.factory.createImportDeclaration(
            statement.modifiers,
            tsc.factory.createImportClause(
              importClause.isTypeOnly,
              undefined,
              cloneNamedImportsFromElements(remainingElements, sourceFile),
            ),
            cloneModuleSpecifier(statement.moduleSpecifier),
            cloneImportAttributes(statement.attributes, sourceFile),
          ),
        );
      }
    }

    const start = statement.getStart(sourceFile);
    const end = statement.getEnd();
    replacements.push({
      start,
      end,
      text: preserveLineCount(
        source.slice(start, end),
        rewrittenStatements.map((entry) =>
          printer.printNode(tsc.EmitHint.Unspecified, entry, sourceFile)
        ).join(" "),
      ),
    });
  }

  if (replacements.length === 0) return source;

  let out = source;
  for (const replacement of [...replacements].reverse()) {
    out = out.slice(0, replacement.start) + replacement.text +
      out.slice(replacement.end);
  }
  return out;
}

function cloneModuleSpecifier(moduleSpecifier: ts.Expression): ts.Expression {
  const { ts: tsc } = compilerStack();
  return tsc.isStringLiteral(moduleSpecifier)
    ? tsc.factory.createStringLiteral(moduleSpecifier.text)
    : moduleSpecifier;
}

function cloneImportAttributes(
  attributes: ts.ImportAttributes | undefined,
  sourceFile: ts.SourceFile,
): ts.ImportAttributes | undefined {
  const { ts: tsc } = compilerStack();
  if (!attributes) return undefined;
  const cloned = tsc.factory.createImportAttributes(
    tsc.factory.createNodeArray(
      attributes.elements.map((element) =>
        tsc.factory.createImportAttribute(
          cloneModuleExportName(element.name, sourceFile),
          cloneImportAttributeValue(element.value),
        )
      ),
    ),
    false,
  );
  return Object.assign(cloned, { token: attributes.token });
}

function cloneNamedImports(
  namedImports: ts.NamedImports,
  sourceFile: ts.SourceFile,
): ts.NamedImports {
  return cloneNamedImportsFromElements(namedImports.elements, sourceFile);
}

function cloneNamedImportsFromElements(
  elements: readonly ts.ImportSpecifier[],
  sourceFile: ts.SourceFile,
): ts.NamedImports {
  const { ts: tsc } = compilerStack();
  return tsc.factory.createNamedImports(
    elements.map((element) =>
      tsc.factory.createImportSpecifier(
        element.isTypeOnly,
        element.propertyName
          ? cloneModuleExportName(element.propertyName, sourceFile)
          : undefined,
        tsc.factory.createIdentifier(element.name.text),
      )
    ),
  );
}

function cloneModuleExportName(
  name: ts.ModuleExportName,
  sourceFile: ts.SourceFile,
): ts.ModuleExportName {
  const { ts: tsc } = compilerStack();
  return tsc.isIdentifier(name)
    ? tsc.factory.createIdentifier(name.text)
    : tsc.factory.createStringLiteral(name.text ?? name.getText(sourceFile));
}

function cloneImportAttributeValue(value: ts.Expression): ts.Expression {
  const { ts: tsc } = compilerStack();
  if (tsc.isStringLiteral(value)) {
    return tsc.factory.createStringLiteral(value.text);
  }
  return value;
}

export function preserveLineCount(
  original: string,
  replacement: string,
): string {
  const originalLineCount = original.split(/\r\n|\r|\n/).length;
  const replacementLineCount = replacement.split(/\r\n|\r|\n/).length;
  if (replacementLineCount > originalLineCount) {
    throw new Error(
      `Import rewrite expanded from ${originalLineCount} to ${replacementLineCount} lines`,
    );
  }
  return replacement +
    "\n".repeat(originalLineCount - replacementLineCount);
}
