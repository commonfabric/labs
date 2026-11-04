import ts from "typescript";
import type {
  MutableJSONSchema,
  MutableJSONSchemaObj,
} from "@commonfabric/api";
import type { GenerationContext, TypeFormatter } from "../interface.ts";
import type { SchemaGenerator } from "../schema-generator.ts";
import { getArrayElementInfo, instantiatedElementType } from "../type-utils.ts";

export class ArrayFormatter implements TypeFormatter {
  #schemaGenerator: SchemaGenerator;

  constructor(schemaGenerator: SchemaGenerator) {
    this.#schemaGenerator = schemaGenerator;
  }

  supportsType(type: ts.Type, context: GenerationContext): boolean {
    return !!getArrayElementInfo(type, context.typeChecker, context.typeNode);
  }

  formatType(type: ts.Type, context: GenerationContext): MutableJSONSchemaObj {
    // Check for array items override (propagated from wrapper types for array-property-only access)
    // This allows patterns like `pieceRegistry.length` to generate `items: { not: true, asCell/asOpaque: true }`
    if (context.arrayItemsOverride !== undefined) {
      return {
        type: "array",
        items: context.arrayItemsOverride as MutableJSONSchema,
      };
    }

    const info = getArrayElementInfo(
      type,
      context.typeChecker,
      context.typeNode,
    );

    if (!info) {
      throw new Error(
        "ArrayFormatter.formatType called but getArrayElementInfo returned null - this indicates a bug in supportsType logic",
      );
    }

    if (!info.elementType) {
      throw new Error(
        "ArrayFormatter received malformed array element info with missing elementType",
      );
    }

    // Handle special cases for any[], unknown[], and never[] with JSON Schema shortcuts
    const elementFlags = info.elementType.flags;

    // Special case: explicit any[] or unknown[] (without concrete node info)
    if ((elementFlags & ts.TypeFlags.Any) && !info.elementNode) {
      // any[] - allow any item type
      return { type: "array", items: true };
    }

    if ((elementFlags & ts.TypeFlags.Unknown) && !info.elementNode) {
      // unknown[] - items are unknown type
      return { type: "array", items: { type: "unknown" } };
    }

    if (elementFlags & ts.TypeFlags.Never) {
      // never[] - allow no items (empty arrays only)
      return { type: "array", items: false };
    }

    // A print is read by its type, and the context holds the print as its
    // hints node. Its element node is reached from there, and read at the
    // annotation its hint spells (`SchemaHint.spelledBy`), as a print of a
    // whole value is; the hint is recorded only where that annotation denotes
    // the element type.
    const printedElement = !context.typeNode && context.hintsNode
      ? getArrayElementInfo(type, context.typeChecker, context.hintsNode)
        ?.elementNode
      : undefined;
    const spelledBy = printedElement &&
      context.schemaHints?.get(printedElement)?.spelledBy;

    // Use formatChildType - it will auto-detect whether to use type-based
    // or node-based analysis based on whether the type is reliable
    // A tuple's items are the union of its element types, which the checker
    // lists in the order it created them; the tuple lists them in its own.
    const elements = context.typeChecker.isTupleType(type)
      ? (type as ts.Type & {
        readonly resolvedTypeArguments?: readonly ts.Type[];
      }).resolvedTypeArguments
      : undefined;
    const items = this.#schemaGenerator.formatChildType(
      info.elementType,
      elements && info.elementType.isUnion()
        ? { ...context, tupleItems: { items: info.elementType, elements } }
        : context,
      spelledBy ?? info.elementNode,
      instantiatedElementType(context.instantiatedAs, context.typeChecker),
    );

    return { type: "array", items };
  }
}
