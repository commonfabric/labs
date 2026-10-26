/**
 * Reports the CFC labels a generated schema could not read. An atom the
 * lowering could not read is carried as a `null` atom, a label nobody holds,
 * which says nothing about the value it was written to protect. A label list
 * that does not read as a list at all is an error: the runtime reads labels
 * only from a list, so none of what is written there would reach it.
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
 * How much of a label list the lowering read: all of it; a list holding an
 * atom it could not read in full, one with an `undefined` anywhere in it,
 * whether the atom itself, a field of an object atom, or an alternative of an
 * `AnyOf` clause; or no list at all, as an array type or a union of tuples
 * reads.
 */
export type LabelListReading = "read" | "partial" | "not-a-list";

/** How much of `labels`, a label list as the lowering read it, it read. */
export function readingOfLabelList(labels: unknown): LabelListReading {
  if (!Array.isArray(labels)) return "not-a-list";
  return labels.some(holdsUnreadValue) ? "partial" : "read";
}

/**
 * How much of the label lists in `metadata`, a `Cfc` payload as the lowering
 * read it, it read, judged by the list it read least of: one under an `ifc`
 * label key, or a UI contract's `requiredEventIntegrity`, where one is written.
 */
export function readingOfMetadataLabels(
  metadata: Readonly<Record<string, unknown>>,
): LabelListReading {
  const uiContract = metadata.uiContract;
  const lists = [
    ...Object.entries(metadata)
      .filter(([key]) => IFC_LABEL_KEYS.has(key))
      .map(([, labels]) => labels),
    ...(isObjectOrArray(uiContract) && !Array.isArray(uiContract) &&
        "requiredEventIntegrity" in uiContract
      ? [uiContract.requiredEventIntegrity]
      : []),
  ];
  const readings = lists.map(readingOfLabelList);
  return readings.includes("not-a-list")
    ? "not-a-list"
    : readings.includes("partial")
    ? "partial"
    : "read";
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
 * The label printed from `labelNode`, or else from `labelType`, on one line
 * and cut to `LABEL_TEXT_LIMIT`, as a code span.
 */
const printedLabel = (
  context: GenerationContext,
  labelType: ts.Type | undefined,
  labelNode: ts.TypeNode | undefined,
): string => {
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
  return backtickQuote(
    text.length > LABEL_TEXT_LIMIT
      ? `${text.slice(0, LABEL_TEXT_LIMIT)}…`
      : text,
  );
};

/**
 * Reports `aliasName`'s label argument, printed from `labelNode` or else from
 * `labelType`, as the lowering read it: a list read only in part as a
 * `cfc-label:unread` warning, and one that is no list at all as a
 * `cfc-label:not-a-list` error.
 */
export function reportLabelReading(
  context: GenerationContext,
  aliasName: string,
  reading: Exclude<LabelListReading, "read">,
  labelType: ts.Type | undefined,
  labelNode: ts.TypeNode | undefined,
): void {
  const label = printedLabel(context, labelType, labelNode);
  const node = labelNode ?? context.typeNode;
  const diagnostic: SchemaGenerationDiagnostic = reading === "not-a-list"
    ? {
      severity: "error",
      type: "cfc-label:not-a-list",
      message: `A label list of \`${aliasName}\` is not a list: ${label}. ` +
        "The runtime reads labels only from a list, so none of what is " +
        "written there would reach it. Write the labels as a tuple of atoms, " +
        'such as `readonly ["secret"]`.',
      ...(node && { node }),
    }
    : {
      severity: "warning",
      type: "cfc-label:unread",
      message: `A label of \`${aliasName}\` could not be read: ${label}. ` +
        "An atom is a literal, an object literal of them, `AnyOf<…>`, or " +
        "`PolicyOf<typeof …>`; the schema carries what it could not read as " +
        "an atom that serializes as `null`, or as a field left out.",
      ...(node && { node }),
    };
  if (context.onDiagnostic) {
    context.onDiagnostic(diagnostic);
  } else if (diagnostic.severity === "error") {
    logger.error("schema-gen", () => diagnostic.message);
  } else {
    logger.warn("schema-gen", () => diagnostic.message);
  }
}
