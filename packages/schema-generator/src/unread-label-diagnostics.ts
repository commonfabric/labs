/**
 * Reports the CFC labels a generated schema could not read. The lowering
 * carries such a label as no label at all or as a `null` atom, which says
 * nothing about the value it was written to protect.
 */

import { getLogger } from "@commonfabric/utils/logger";
import { backtickQuote } from "@commonfabric/utils/markdown";
import { isObjectOrArray } from "@commonfabric/utils/types";
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
const IFC_LABEL_KEYS: ReadonlySet<string> = new Set([
  "confidentiality",
  "integrity",
  "addIntegrity",
  "requiredIntegrity",
  "maxConfidentiality",
]);

/**
 * Whether `labels`, a label list as the lowering read it, is missing or holds
 * an atom it could not read in full: one with an `undefined` anywhere in it,
 * whether the atom itself, a field of an object atom, or an alternative of an
 * `AnyOf` clause.
 */
export function holdsUnreadLabel(labels: unknown): boolean {
  return !Array.isArray(labels) || labels.some(holdsUnreadValue);
}

/**
 * Whether `metadata`, a `Cfc` payload as the lowering read it, holds a label
 * list it could not read in full: one under an `ifc` label key, or a UI
 * contract's `requiredEventIntegrity`, where one is written.
 */
export function holdsUnreadMetadataLabel(
  metadata: Readonly<Record<string, unknown>>,
): boolean {
  const uiContract = metadata.uiContract;
  return Object.entries(metadata).some(([key, labels]) =>
    IFC_LABEL_KEYS.has(key) && holdsUnreadLabel(labels)
  ) ||
    (isObjectOrArray(uiContract) && !Array.isArray(uiContract) &&
      "requiredEventIntegrity" in uiContract &&
      holdsUnreadLabel(uiContract.requiredEventIntegrity));
}

/** Whether `value`, an atom or a part of one, holds an `undefined`. */
const holdsUnreadValue = (value: unknown): boolean =>
  value === undefined ||
  (isObjectOrArray(value) &&
    (Array.isArray(value) ? value : Object.values(value)).some(
      holdsUnreadValue,
    ));

/**
 * `node`, a node substitution built, with each leaf that prints from source
 * text (an identifier, a literal, or a template's text) rebuilt from its own
 * text, and on one line. Its parsed children,
 * perhaps from several files, would otherwise print blank against the one
 * source a printer takes. Only rebuilt nodes are marked; the parsed ones stay
 * as the program holds them.
 */
const withOwnText = (node: ts.TypeNode): ts.TypeNode => {
  const result = ts.transform(node, [(context) => (root) => {
    const rebuild = (child: ts.Node): ts.Node =>
      ts.isIdentifier(child)
        ? ts.factory.createIdentifier(child.text)
        : ts.isStringLiteral(child)
        ? ts.factory.createStringLiteral(child.text)
        : ts.isNumericLiteral(child)
        ? ts.factory.createNumericLiteral(child.text)
        : ts.isBigIntLiteral(child)
        ? ts.factory.createBigIntLiteral(child.text)
        : ts.isNoSubstitutionTemplateLiteral(child)
        ? ts.factory.createNoSubstitutionTemplateLiteral(
          child.text,
          child.rawText,
        )
        : ts.isTemplateHead(child)
        ? ts.factory.createTemplateHead(child.text, child.rawText)
        : ts.isTemplateMiddle(child)
        ? ts.factory.createTemplateMiddle(child.text, child.rawText)
        : ts.isTemplateTail(child)
        ? ts.factory.createTemplateTail(child.text, child.rawText)
        : ts.visitEachChild(child, visit, context);
    const visit = (child: ts.Node): ts.Node => {
      const rebuilt = rebuild(child);
      return rebuilt === child
        ? child
        : ts.setEmitFlags(rebuilt, ts.EmitFlags.SingleLine);
    };
    return ts.visitNode(root, visit) as ts.TypeNode;
  }]);
  const [transformed] = result.transformed;
  result.dispose();
  return transformed ?? node;
};

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
  // is; a node built in substitution has no source, and prints from the text
  // each of its leaves holds.
  const printed = labelNode && labelNode.pos >= 0
    ? labelNode.getText()
    : labelNode
    ? ts.createPrinter({ removeComments: true }).printNode(
      ts.EmitHint.Unspecified,
      withOwnText(labelNode),
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
      ". An atom is a literal, an object literal of them, `AnyOf<…>`, or " +
      "`PolicyOf<typeof …>`; the schema carries what it could not read as " +
      "no label, or as an atom that serializes as `null`.",
    ...((labelNode ?? context.typeNode) &&
      { node: labelNode ?? context.typeNode }),
  };
  if (context.onDiagnostic) {
    context.onDiagnostic(diagnostic);
  } else {
    logger.warn("schema-gen", () => diagnostic.message);
  }
}
