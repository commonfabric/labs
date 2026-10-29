/**
 * Reports unread schema types, CFC recursions whose nesting limit would
 * discard policies, and recursive aliases read in place of `any`.
 */

import { getLogger } from "@commonfabric/utils/logger";
import { backtickQuote } from "@commonfabric/utils/markdown";
import ts from "typescript";

import type {
  GenerationContext,
  SchemaGenerationDiagnostic,
} from "./interface.ts";

const logger = getLogger("schema-generator.unread");

/** How many unread types a message names before it counts the rest. */
const NAMED_LIMIT = 5;

/** How much of one printed type a message shows. */
const TYPE_TEXT_LIMIT = 80;

/**
 * Reports `unread`, the type nodes one schema could not read and no caller
 * recovered, as a single warning naming each distinct type once.
 */
export function reportUnreadTypes(
  context: GenerationContext,
  unread: readonly ts.TypeNode[],
  node: ts.Node | undefined = context.typeNode,
): void {
  const printer = ts.createPrinter({ removeComments: true });
  const blank = ts.createSourceFile("unread.ts", "", ts.ScriptTarget.Latest);
  // A parsed node's literals are read from its own file's text, so it prints
  // against that file. A node built afresh has no file and prints alone.
  const texts = [
    ...new Set(
      unread.map((typeNode) =>
        printer.printNode(
          ts.EmitHint.Unspecified,
          typeNode,
          sourceFileOf(typeNode) ?? blank,
        ).replace(/\s+/g, " ")
      ),
    ),
  ];
  const named = texts.slice(0, NAMED_LIMIT).map((text) =>
    backtickQuote(
      text.length > TYPE_TEXT_LIMIT
        ? `${text.slice(0, TYPE_TEXT_LIMIT)}…`
        : text,
    )
  ).join(", ");
  const rest = texts.length > NAMED_LIMIT
    ? ` and ${texts.length - NAMED_LIMIT} more`
    : "";

  const diagnostic: SchemaGenerationDiagnostic = {
    severity: "warning",
    type: "schema-type:unread",
    message: `Part of this schema could not be read from its type: ${named}` +
      `${rest}. The schema describes less than the type does there, and ` +
      "may accept values the type refuses.",
    ...(node && { node }),
  };
  report(context, diagnostic);
}

/** Reports a CFC alias chain whose nesting limit would discard its policies. */
export function reportUnreadCfcRecursion(
  context: GenerationContext,
  node: ts.Node | undefined,
): void {
  report(context, {
    severity: "error",
    type: "cfc-schema:recursion-limit",
    message: "The CFC alias chain reached the schema's recursion limit. " +
      "Its remaining confidentiality and write policies could not be read, " +
      "so this schema cannot be used. Write a recursive reference whose " +
      "type arguments and writer bindings settle to the same reading.",
    ...(node && { node }),
  });
}

/**
 * Reports `node`, a reference to an alias read again inside its own
 * declaration, where that declaration is read in place of the `any` the
 * checker reads the alias as: the checker reads the alias as `any` there too,
 * so what the declaration wraps around `any` would be lost at that depth.
 */
export function reportRecursiveAliasOfAny(
  context: GenerationContext,
  node: ts.Node,
): void {
  report(context, {
    severity: "error",
    type: "cfc-schema:recursive-alias-of-any",
    message: "This alias refers to itself, and the type checker reads it as " +
      "`any` because it wraps a CFC label, a scope, or a default around " +
      "`any`. Its schema is read from its declaration, which cannot be read " +
      "where the alias recurs, so the labels there would be lost, and this " +
      "schema cannot be used. Write `unknown` in place of `any` in the " +
      "alias, which keeps the wrapper in its type.",
    node,
  });
}

/** Delivers a diagnostic to the caller, or logs it at its severity. */
function report(
  context: GenerationContext,
  diagnostic: SchemaGenerationDiagnostic,
): void {
  if (context.onDiagnostic) {
    context.onDiagnostic(diagnostic);
  } else if (diagnostic.severity === "error") {
    logger.error("schema-gen", () => diagnostic.message);
  } else {
    logger.warn("schema-gen", () => diagnostic.message);
  }
}

/** The file `node` was parsed from, or `undefined` for a node built afresh. */
function sourceFileOf(node: ts.Node): ts.SourceFile | undefined {
  let current: ts.Node | undefined = node;
  while (current && !ts.isSourceFile(current)) current = current.parent;
  return current;
}
