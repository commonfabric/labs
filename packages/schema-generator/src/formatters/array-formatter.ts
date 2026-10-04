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

    // Use formatChildType - it will auto-detect whether to use type-based
    // or node-based analysis based on whether the type is reliable
    const items = this.#schemaGenerator.formatChildType(
      info.elementType,
      context,
      info.elementNode,
      instantiatedElementType(context.instantiatedAs, context.typeChecker),
    );

    return { type: "array", items };
  }
}
