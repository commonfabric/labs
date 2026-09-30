/**
 * Reports the types a generated schema could not read, which it describes as
 * accepting any value.
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
  if (context.onDiagnostic) {
    context.onDiagnostic(diagnostic);
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
