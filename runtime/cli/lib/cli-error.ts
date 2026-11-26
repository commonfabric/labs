import { ValidationError } from "@cliffy/command";
import {
  CompilerError,
  TransformerError,
} from "@commonfabric/js-compiler/errors";
import { IndexedPatternError } from "@commonfabric/pattern-index/deploy";
import { SlugAssignedError } from "@commonfabric/piece";
import { SlugResolutionError } from "@commonfabric/runner";

import { VerbInputValidationError } from "./callable.ts";
import { IdentityKeyfileError } from "./identity.ts";
import { FirstPartyError } from "./first-party.ts";
import { PairingError } from "./pairing.ts";

/**
 * The value to print for a top-level CLI failure. Validation, transformer,
 * compiler, verb-input, slug, identity-keyfile, pairing and first-party
 * request errors carry user-facing
 * messages, so print those without a stack trace, and so is an indexed
 * pattern's, which {@link indexedPatternErrorText} renders. Other Errors print their
 * stack, falling back to the message. Anything else prints as-is.
 */
export function renderCliError(e: unknown): unknown {
  if (
    e instanceof ValidationError || e instanceof TransformerError ||
    e instanceof CompilerError || e instanceof VerbInputValidationError ||
    e instanceof SlugResolutionError || e instanceof SlugAssignedError ||
    e instanceof IdentityKeyfileError || e instanceof PairingError ||
    e instanceof FirstPartyError
  ) {
    return e.message;
  }
  if (e instanceof IndexedPatternError) {
    return indexedPatternErrorText(e);
  }
  if (e instanceof Error) {
    return e.stack || e.message;
  }
  return e;
}

/**
 * A failed deploy from the pattern index, without a stack trace. Its message
 * never quotes the indexed source, because a deployer may relay it to a model
 * that did not write that source. The withheld detail can, so it is printed
 * only at `--log-level debug`, for an operator reading it themselves.
 */
export function indexedPatternErrorText(e: IndexedPatternError): string {
  if (e.rawCauseMessage === undefined) return e.message;
  if (Deno.env.get("CF_LOG_LEVEL") === "debug") {
    return `${e.message}\n\nWithheld detail:\n${e.rawCauseMessage}`;
  }
  return `${e.message}\nRun again with --log-level debug to print the ` +
    `withheld detail.`;
}
