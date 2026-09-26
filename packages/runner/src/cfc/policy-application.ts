import type { Cell } from "../cell.ts";
import { resolveLink } from "../link-resolution.ts";
import { runtimeWritePolicyAuthorization } from "./types.ts";

/**
 * Applies `cell`'s schema to the value its document already holds, on behalf
 * of host code that labels a document it does not write, such as a view it
 * hands to the document's owner.
 *
 * A policy application writes nothing, so the document's writer and click
 * claims (`writeAuthorizedBy`, `uiContract`) have no write to govern, and
 * preparation leaves them to the writers they name. It still refuses a
 * schema that would drop a stored claim, and every other requirement, the
 * integrity floor among them, still applies. The waiver holds only while the
 * transaction writes nothing to the document and a builtin identity authored
 * the application.
 *
 * Host-only: the runtime's authorization marks the application, and pattern
 * code, which reaches cells and their transactions but not this module,
 * cannot supply it. `Cell.applyCfcSchemaToExistingValue()` records the
 * schema alone and waives nothing.
 */
export function applyCfcPolicyToExistingValue<T>(cell: Cell<T>): void {
  const tx = cell.tx;
  if (!tx) {
    throw new Error("Transaction required for applyCfcPolicyToExistingValue");
  }
  cell.applyCfcSchemaToExistingValue();
  const target = resolveLink(
    cell.runtime,
    tx,
    cell.getAsNormalizedFullLink(),
    "writeRedirect",
  );
  tx.recordCfcWritePolicyInput({
    kind: "policy-application",
    target: {
      space: target.space,
      id: target.id,
      scope: target.scope,
      path: [...target.path],
    },
  }, runtimeWritePolicyAuthorization);
}
