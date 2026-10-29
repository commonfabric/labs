/** Reports defaults whose values cannot be recovered during schema generation. */

import { getLogger } from "@commonfabric/utils/logger";
import type ts from "typescript";

import type {
  GenerationContext,
  SchemaGenerationDiagnostic,
} from "./interface.ts";

const logger = getLogger("schema-generator.default");

/** Reports only after all applicable default-value extraction routes fail. */
export function reportUnresolvedDefault(
  context: GenerationContext,
  node: ts.Node | undefined = context.typeNode,
  wrapper: "Default" | "DeepDefault" = "Default",
): void {
  const diagnostic: SchemaGenerationDiagnostic = {
    severity: "warning",
    type: "schema-default:unresolved",
    message:
      `Cannot extract a value for ${wrapper}<>; this annotation supplies no schema default. ` +
      "Use a literal value type, an empty-object type, or typeof a constant " +
      "with a literal initializer.",
    ...(node && { node }),
  };
  if (context.onDiagnostic) {
    context.onDiagnostic(diagnostic);
  } else {
    logger.warn("schema-gen", () => diagnostic.message);
  }
}
