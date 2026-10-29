import { isFabricPrimitiveSchemaType } from "@commonfabric/data-model/fabric-primitives";
import type { JSONSchemaObj } from "./builder/types.ts";

/**
 * Whether no value can satisfy both `left` and `right` as `type` keywords.
 * An absent `type` or `unknown` admits every value. `integer` is a subtype of
 * `number`, and each `FabricPrimitive` type a subtype of `object`, so each of
 * those pairs overlaps.
 */
export function schemaTypesAreDisjoint(
  left: JSONSchemaObj["type"],
  right: JSONSchemaObj["type"],
): boolean {
  if (left === undefined || right === undefined) return false;

  const lefts = Array.isArray(left) ? left : [left];
  const rights = Array.isArray(right) ? right : [right];
  if (lefts.includes("unknown") || rights.includes("unknown")) {
    return false;
  }

  return !lefts.some((leftType) =>
    rights.some((rightType) =>
      leftType === rightType ||
      (leftType === "number" && rightType === "integer") ||
      (leftType === "integer" && rightType === "number") ||
      (leftType === "object" && isFabricPrimitiveSchemaType(rightType)) ||
      (rightType === "object" && isFabricPrimitiveSchemaType(leftType))
    )
  );
}
