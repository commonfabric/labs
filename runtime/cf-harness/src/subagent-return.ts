import type { JSONSchema } from "@commonfabric/api";
import { validateSchemaDefinition } from "@commonfabric/runner/cfc";

import {
  DEFAULT_STRUCTURED_RESULT_SCHEMA_MAX_BYTES,
  type ParsedStructuredResultSchema,
  parseStructuredResultJson,
  parseStructuredResultSchema,
  type SanitizedStructuredResult,
  validateAndSanitizeStructuredResult,
} from "./structured-result.ts";

export const MAX_SUBAGENT_RETURN_SCHEMA_BYTES =
  DEFAULT_STRUCTURED_RESULT_SCHEMA_MAX_BYTES;

export type { ParsedStructuredResultSchema as ParsedSubagentReturnSchema };
export type { SanitizedStructuredResult as SanitizedSubagentReturn };

/**
 * Parses and validates the return contract before a child starts. A malformed
 * definition produces a fixed diagnostic without disclosing schema content.
 */
export const parseSubagentReturnSchema = (
  input: unknown,
): ParsedStructuredResultSchema | undefined => {
  const parsed = parseStructuredResultSchema(input, {
    label: "delegate_task returnSchema",
    maxBytes: MAX_SUBAGENT_RETURN_SCHEMA_BYTES,
  });
  if (parsed === undefined) return undefined;
  if (
    validateSchemaDefinition(
      parsed.schema,
      parsed.schema,
      "structured-result",
    ) !==
      undefined
  ) {
    throw new Error(
      "delegate_task returnSchema has an invalid schema definition",
    );
  }
  return parsed;
};

export const parseSubagentReturnJson = (text: string): unknown =>
  parseStructuredResultJson(text, {
    emptyMessage: "child final response was empty",
    invalidMessage: "child final response was not valid JSON",
  });

export const validateAndSanitizeSubagentReturn = (
  options: {
    schema: JSONSchema;
    value: unknown;
    childRunId: string;
  },
): SanitizedStructuredResult =>
  validateAndSanitizeStructuredResult({
    schema: options.schema,
    value: options.value,
    opaqueHandleId: options.childRunId,
  });
