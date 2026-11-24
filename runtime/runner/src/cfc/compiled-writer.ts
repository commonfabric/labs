/**
 * The writer that a handler of a compiled pattern is, for a writer claim
 * (`writeAuthorizedBy`, and each alternative of a `writePolicyAnyOf`).
 *
 * A transaction that runs such a handler is stamped with the identity the
 * runtime registered the compiled pattern under and the index of the
 * handler's body in its plan (`ImplementationIdentity` of kind `compiled`).
 * The stamp names a plan and a body, and asserts nothing about the handler.
 * What the handler is comes from the plan the runtime registered under that
 * identity (`CompiledPlanRegistry`): `Body.code` of the body, the pair of the
 * content-addressed identity of the module that declares the handler and
 * the path of its binding in that module, which is the pair a writer claim
 * holds as `moduleIdentity` and `path`.
 */

import { isObjectNotArray } from "@commonfabric/js-values/types";

import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  type ImplementationIdentity,
  runtimeWritePolicyAuthorization,
} from "./types.ts";

/** What a writer claim is compared with for a handler of a compiled pattern. */
export type CompiledWriter = {
  /** The content-addressed identity of the module that declares the handler. */
  readonly moduleIdentity: string;

  /** The path of the handler's binding in that module. */
  readonly bindingPath: readonly string[];
};

/**
 * Returns the writer that `identity` names on `tx`, or `undefined` where it
 * names none: the runtime registered no compiled pattern under the identity,
 * the identity names no body, or the plan holds no `Body.code` for the body,
 * as for a handler that is declared at no binding of module scope. A claim
 * admits no writer that is `undefined`.
 */
// SPEC-PENDING https://github.com/commonfabric/specs/pull/91
export const compiledWriterOf = (
  tx: IExtendedStorageTransaction,
  identity: Extract<ImplementationIdentity, { kind: "compiled" }>,
): CompiledWriter | undefined => {
  if (identity.body === undefined) return undefined;
  const plan = tx.compiledPlans(runtimeWritePolicyAuthorization)?.plan(
    identity.pattern,
    runtimeWritePolicyAuthorization,
  );
  const code = plan?.bodies[identity.body]?.code;
  if (!isObjectNotArray(code)) return undefined;
  const { module, binding } = code;
  if (
    typeof module !== "string" || module.length === 0 ||
    !Array.isArray(binding) || binding.length === 0 ||
    !binding.every((step) => typeof step === "string")
  ) {
    return undefined;
  }
  return { moduleIdentity: module, bindingPath: binding };
};
