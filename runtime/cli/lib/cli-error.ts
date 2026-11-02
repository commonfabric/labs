import { ValidationError } from "@cliffy/command";
import { CompilerError, TransformerError } from "@commonfabric/js-compiler/errors";
import { SlugAssignedError } from "@commonfabric/piece";
import { SlugResolutionError } from "@commonfabric/runner";

import { VerbInputValidationError } from "./callable.ts";
import { IdentityKeyfileError } from "./identity.ts";

/**
 * The value to print for a top-level CLI failure. Validation, transformer,
 * compiler, verb-input, slug, and identity-keyfile errors carry user-facing
 * messages, so print those without a stack trace. Other Errors print their
 * stack, falling back to the message. Anything else prints as-is.
 */
export function renderCliError(e: unknown): unknown {
  if (
    e instanceof ValidationError || e instanceof TransformerError ||
    e instanceof CompilerError || e instanceof VerbInputValidationError ||
    e instanceof SlugResolutionError || e instanceof SlugAssignedError ||
    e instanceof IdentityKeyfileError
  ) {
    return e.message;
  }
  if (e instanceof Error) {
    return e.stack || e.message;
  }
  return e;
}
