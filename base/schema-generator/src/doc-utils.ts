import ts from "typescript";

/**
 * Extract plain-text JSDoc from a symbol. Filters out tag lines starting with
 * '@'. Returns undefined when no useful text is present.
 */
export function getSymbolDoc(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): string | undefined {
  if (!symbol) return undefined;
  const parts = symbol.getDocumentationComment(checker);
  // @ts-ignore - displayPartsToString exists on the TS namespace
  const text = ts.displayPartsToString(parts) || "";
  if (!text) return undefined;
  const lines = text.split(/\r?\n/).filter((l) => !l.trim().startsWith("@"));
  const cleaned = lines.join("\n").trim();
  return cleaned || undefined;
}

/**
 * Extract JSDoc comments from a declaration node (if available), filtering out
 * lines starting with '@'. Returns all distinct comment texts.
 */
export function getDeclDocs(decl: ts.Declaration): string[] {
  const docs: string[] = [];
  const jsDocs = (decl as any).jsDoc as Array<ts.JSDoc> | undefined;
  if (jsDocs && jsDocs.length > 0) {
    // Prefer comments that are closest to the declaration by iterating in
    // reverse source order. TypeScript keeps JSDoc entries ordered as they
    // appear in the source, so sorting by position places the comment nearest
    // to the declaration at the front of the list.
    const sorted = [...jsDocs].sort((a, b) => b.pos - a.pos);
    for (const d of sorted) {
      const comment = (d as any).comment as unknown;
      let text = "";
      if (typeof comment === "string") {
        text = comment;
      } else if (Array.isArray(comment)) {
        text = comment
          .map((c) => (typeof c === "string" ? c : (c as any).text ?? ""))
          .join("");
      }
      if (!text) continue;
      const lines = String(text).split(/\r?\n/).filter((l) =>
        !l.trim().startsWith("@")
      );
      const cleaned = lines.join("\n").trim();
      if (cleaned && !docs.includes(cleaned)) docs.push(cleaned);
    }
  }
  return docs;
}

/**
 * Extract merged doc from symbol declarations and the symbol itself, preferring
 * declaration-attached comments from non-declaration files. Returns the first
 * doc text (if any) and the set of all distinct docs discovered.
 */
export function extractDocFromSymbolAndDecls(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): { text?: string; all: string[] } {
  const all: string[] = [];
  if (symbol) {
    const decls = symbol.declarations ?? [];
    for (const decl of decls) {
      const sf = decl.getSourceFile();
      if (!sf.isDeclarationFile) {
        for (const s of getDeclDocs(decl)) if (!all.includes(s)) all.push(s);
      }
    }
  }

  // Only include symbol-level docs if there is a non-declaration-file declaration
  const hasUserDecl = (symbol?.declarations ?? []).some((d) =>
    !d.getSourceFile().isDeclarationFile
  );
  if (hasUserDecl) {
    const symText = getSymbolDoc(symbol, checker);
    if (symText && !all.includes(symText)) all.push(symText);
  }

  const result: { text?: string; all: string[] } = { all };
  if (all[0]) result.text = all[0];
  return result;
}

/**
 * Extract documentation info from a TypeScript type by inspecting both the
 * alias symbol (for type aliases) and the underlying symbol (for interfaces,
 * classes, etc.). Returns the first documentation string (if any), all unique
 * doc strings, and the display name of the type as reported by the checker.
 */
export function extractDocFromType(
  type: ts.Type,
  checker: ts.TypeChecker,
): { firstDoc?: string; allDocs: string[]; typeName: string } {
  const docs: string[] = [];
  const aliasSym = type.aliasSymbol;
  const directSym = type.getSymbol?.() || (type as any).symbol;

  if (aliasSym) {
    const { all } = extractDocFromSymbolAndDecls(aliasSym, checker);
    for (const doc of all) {
      if (doc && !docs.includes(doc)) docs.push(doc);
    }
  }

  if (directSym) {
    const { all } = extractDocFromSymbolAndDecls(directSym, checker);
    for (const doc of all) {
      if (doc && !docs.includes(doc)) docs.push(doc);
    }
  }

  const typeName = checker.typeToString(type).replace(/\s+/g, " ").trim();
  const result: { firstDoc?: string; allDocs: string[]; typeName: string } = {
    allDocs: docs,
    typeName,
  };
  if (docs[0]) result.firstDoc = docs[0];
  return result;
}

/**
 * Whether the symbol's JSDoc carries an `@deprecated` tag on any declaration
 * in a non-declaration file. The doc-text extractors above deliberately filter
 * `@`-tag lines out of descriptions; this reads the tag itself. Consumed for
 * verb listing marks: a `@deprecated` stream property lowers to standard JSON
 * Schema `deprecated: true` (verb contract WS-F), which `cf piece verbs`
 * hides by default while the verb stays callable.
 */
export function symbolHasDeprecatedTag(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): boolean {
  if (!symbol) return false;
  const hasUserDecl = (symbol.declarations ?? []).some((d) =>
    !d.getSourceFile().isDeclarationFile
  );
  if (!hasUserDecl) return false;
  return symbol.getJsDocTags(checker).some((tag) => tag.name === "deprecated");
}
