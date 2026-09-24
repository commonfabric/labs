/**
 * Reports the CFC labels a generated schema could not read. The lowering
 * carries such a label as no label at all or as a `null` atom, which says
 * nothing about the value it was written to protect.
 */

import { getLogger } from "@commonfabric/utils/logger";
import { backtickQuote } from "@commonfabric/utils/markdown";
import ts from "typescript";

import type {
  GenerationContext,
  SchemaGenerationDiagnostic,
} from "./interface.ts";

const logger = getLogger("schema-generator.unread");

/** How much of one printed label a message shows. */
const LABEL_TEXT_LIMIT = 80;

/**
 * The `ifc` keys whose values are label lists: atoms a value carries or
 * requires, each a string literal, an object literal, `AnyOf<…>`, or
 * `PolicyOf<typeof …>`.
 */
export const IFC_LABEL_KEYS: ReadonlySet<string> = new Set([
  "confidentiality",
  "integrity",
  "addIntegrity",
  "requiredIntegrity",
  "maxConfidentiality",
]);

/**
 * Whether `labels`, a label list as the lowering read it, is missing or holds
 * an atom it could not read: an `undefined` element, or one inside an
 * `AnyOf` clause's alternatives.
 */
export function holdsUnreadLabel(labels: unknown): boolean {
  if (!Array.isArray(labels)) return true;
  return labels.some((atom) =>
    atom === undefined ||
    (typeof atom === "object" && atom !== null && "anyOf" in atom &&
      holdsUnreadLabel((atom as { anyOf: unknown }).anyOf))
  );
}

/**
 * Reports that `aliasName`'s label argument, printed from `labelNode` or else
 * from `labelType`, could not be read in full, as one warning.
 */
export function reportUnreadLabel(
  context: GenerationContext,
  aliasName: string,
  labelType: ts.Type | undefined,
  labelNode: ts.TypeNode | undefined,
): void {
  // An authored node prints from its own source, where its literals' text
  // is; a node built in substitution has no source and prints from itself.
  const printed = labelNode && labelNode.pos >= 0
    ? labelNode.getText()
    : labelNode
    ? ts.createPrinter({ removeComments: true }).printNode(
      ts.EmitHint.Unspecified,
      labelNode,
      ts.createSourceFile("unread.ts", "", ts.ScriptTarget.Latest),
    )
    : labelType
    ? context.typeChecker.typeToString(labelType)
    : "(missing)";
  const text = printed.replace(/\s+/g, " ");
  const diagnostic: SchemaGenerationDiagnostic = {
    severity: "warning",
    type: "cfc-label:unread",
    message: `A label of \`${aliasName}\` could not be read: ` +
      backtickQuote(
        text.length > LABEL_TEXT_LIMIT
          ? `${text.slice(0, LABEL_TEXT_LIMIT)}…`
          : text,
      ) +
      ". An atom is a string literal, an object literal, `AnyOf<…>`, or " +
      "`PolicyOf<typeof …>`; the schema carries what it could not read as " +
      "no label, or as a `null` atom.",
    ...((labelNode ?? context.typeNode) &&
      { node: labelNode ?? context.typeNode }),
  };
  if (context.onDiagnostic) {
    context.onDiagnostic(diagnostic);
  } else {
    logger.warn("schema-gen", () => diagnostic.message);
  }
}
