import ts from "typescript";
import type {
  MutableJSONSchema,
  MutableJSONSchemaObj,
} from "@commonfabric/api";
import type { GenerationContext, TypeFormatter } from "../interface.ts";
import { TypeWithInternals } from "../type-utils.ts";

/**
 * Formatter for primitive TypeScript types
 */
export class PrimitiveFormatter implements TypeFormatter {
  supportsType(type: ts.Type, _context: GenerationContext): boolean {
    const flags = type.flags;

    return (flags & ts.TypeFlags.String) !== 0 ||
      (flags & ts.TypeFlags.Number) !== 0 ||
      (flags & ts.TypeFlags.Boolean) !== 0 ||
      (flags & ts.TypeFlags.BooleanLiteral) !== 0 ||
      (flags & ts.TypeFlags.StringLiteral) !== 0 ||
      (flags & ts.TypeFlags.NumberLiteral) !== 0 ||
      (flags & ts.TypeFlags.BigInt) !== 0 ||
      (flags & ts.TypeFlags.BigIntLiteral) !== 0 ||
      (flags & ts.TypeFlags.TemplateLiteral) !== 0 ||
      (flags & ts.TypeFlags.Null) !== 0 ||
      (flags & ts.TypeFlags.Undefined) !== 0 ||
      (flags & ts.TypeFlags.Void) !== 0 ||
      (flags & ts.TypeFlags.Never) !== 0 ||
      (flags & ts.TypeFlags.Unknown) !== 0 ||
      (flags & ts.TypeFlags.Any) !== 0;
  }

  formatType(
    type: ts.Type,
    context: GenerationContext,
  ): MutableJSONSchema {
    return PrimitiveFormatter.getSchemaType(type, context);
  }

  public static getSchemaType(
    type: ts.Type,
    context: GenerationContext,
  ): MutableJSONSchema {
    const flags = type.flags;
    // Handle literal types first (more specific)
    // If widenLiterals flag is set, skip enum generation and return base type
    if (flags & ts.TypeFlags.StringLiteral) {
      if (context.widenLiterals) {
        return { type: "string" };
      }
      return {
        type: "string",
        enum: [(type as ts.StringLiteralType).value],
      };
    }
    if (flags & ts.TypeFlags.NumberLiteral) {
      if (context.widenLiterals) {
        return { type: "number" };
      }
      return {
        type: "number",
        enum: [(type as ts.NumberLiteralType).value],
      };
    }
    if (flags & ts.TypeFlags.BooleanLiteral) {
      if (context.widenLiterals) {
        return { type: "boolean" };
      }
      return {
        type: "boolean",
        enum: [(type as TypeWithInternals).intrinsicName === "true"],
      };
    }
    if (flags & ts.TypeFlags.BigIntLiteral) {
      if (context.widenLiterals) {
        return { type: "integer" };
      }
      return {
        type: "integer",
        enum: [Number((type as ts.BigIntLiteralType).value.base10Value)],
      };
    }

    // Template literal types (e.g. `did:${string}:${string}`) are strings
    if (flags & ts.TypeFlags.TemplateLiteral) {
      return { type: "string" };
    }

    // Handle general primitive types
    if (flags & ts.TypeFlags.String) {
      return { type: "string" };
    }
    if (flags & ts.TypeFlags.Number) {
      return { type: "number" };
    }
    if (flags & ts.TypeFlags.Boolean) {
      return { type: "boolean" };
    }
    if (flags & ts.TypeFlags.BigInt) {
      return { type: "integer" };
    }
    if (flags & ts.TypeFlags.Null) {
      return { type: "null" };
    }
    if (flags & ts.TypeFlags.Undefined) {
      // undefined isn't normally part of JSON Schema, but we include it
      return { type: "undefined" };
    }
    if (flags & ts.TypeFlags.Void) {
      const schema: MutableJSONSchemaObj = { asCell: ["opaque"] };
      context.schemaOrigins?.set(schema, { kind: "void" });
      return schema;
    }
    if (flags & ts.TypeFlags.Never) {
      // never: return false to reject all values
      // never means this type can never occur, so no value should validate
      return false;
    }
    if (flags & ts.TypeFlags.Any) {
      // any: return true to indicate "allow any value"
      return true;
    }
    if (flags & ts.TypeFlags.Unknown) {
      // unknown: return { type: "unknown" } to distinguish from any (true)
      return { type: "unknown" };
    }

    // Fallback
    return { type: "string", enum: ["unknown"] };
  }
}
