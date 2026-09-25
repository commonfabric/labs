/**
 * Reports a writer binding the lowering could not read. A `WriteAuthorizedBy`
 * lowered without its binding carries no write restriction at all, so the
 * schema would admit a write from any writer.
 */

import { getLogger } from "@commonfabric/utils/logger";

import type {
  GenerationContext,
  SchemaGenerationDiagnostic,
} from "./interface.ts";

const logger = getLogger("schema-generator.writer");

/** Reports that `aliasName`, the policy being lowered, has no readable binding. */
export function reportUnreadWriterBinding(
  context: GenerationContext,
  aliasName: string,
): void {
  const diagnostic: SchemaGenerationDiagnostic = {
    severity: "error",
    type: "cfc-write-authorized-by:unread",
    message: `The writer binding of \`${aliasName}\` could not be read, so ` +
      "the schema would carry no write restriction. Write the binding as a " +
      "direct `typeof` reference, in the policy itself or passed to it " +
      "unchanged through an alias's parameter.",
    ...(context.typeNode && { node: context.typeNode }),
  };
  if (context.onDiagnostic) {
    context.onDiagnostic(diagnostic);
  } else {
    logger.error("schema-gen", () => diagnostic.message);
  }
}
