import type { JSONSchema } from "commonfabric";

export type ResultSchemaInput = any;

export const parseResultSchemaInput = (
  resultSchema: ResultSchemaInput,
): JSONSchema => {
  if (typeof resultSchema === "string") {
    try {
      const parsed = JSON.parse(resultSchema);
      return (
          typeof parsed === "boolean" ||
          (parsed !== null && typeof parsed === "object" &&
            !Array.isArray(parsed))
        )
        ? parsed as JSONSchema
        : false;
    } catch {
      return false;
    }
  }
  if (
    typeof resultSchema === "boolean" ||
    (resultSchema !== null && typeof resultSchema === "object" &&
      !Array.isArray(resultSchema))
  ) {
    return resultSchema as JSONSchema;
  }
  // Fail closed for malformed inputs (arrays, numbers, null, undefined). A
  // permissive `true` here would let arbitrary subagent output through.
  return false;
};
