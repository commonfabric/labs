/**
 * The identity a transaction of a handler of a compiled piece is stamped
 * with: the identity the runtime registered the compiled pattern under, and
 * the index of the handler's body in the plan. The commit preparation reads
 * what the handler is from the registered plan (`cfc/compiled-writer.ts`).
 */
import type { ImplementationIdentity } from "../cfc/types.ts";

/**
 * Returns the identity of the handler of the binding `binding` of `plan`,
 * which the runtime registered as `pattern`, or `undefined` where the plan
 * names no body for the binding.
 */
export const handlerIdentityOf = (
  plan: unknown,
  pattern: string,
  binding: number,
): ImplementationIdentity | undefined => {
  const body = (plan as {
    bindings?: readonly ({ handler?: { body?: unknown } } | undefined)[];
  } | undefined)?.bindings?.[binding]?.handler?.body;
  return typeof body === "number" && Number.isInteger(body) && body >= 0
    ? { kind: "compiled", pattern, body }
    : undefined;
};
