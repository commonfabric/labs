import {
  isPrimitiveCellLink,
  isWriteRedirectLink,
  type NormalizedFullLink,
} from "../link-utils.ts";
import { ignoreReadForScheduling } from "../scheduler.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { runtimeWritePolicyAuthorization } from "./types.ts";

/**
 * Records the references a collection builtin staged into the argument of a
 * sub-pattern it is instantiating. Each of `fields` whose staged value is a
 * link to a cell is recorded, and a field holding anything else is not: a link
 * hands the new piece a reference and writes nothing of what it points at,
 * which is what makes the staging an initialization of the argument and no
 * modification of the cell. The commit verifier independently checks that the
 * slot was absent before the transaction or already held the link, and that
 * the final bytes are the link recorded.
 */
export function recordReferencedArgumentFields(
  tx: IExtendedStorageTransaction,
  argument: NormalizedFullLink,
  fields: readonly string[],
): void {
  for (const field of fields) {
    const path = [...argument.path, field];
    const staged = tx.readValueOrThrow({ ...argument, path }, {
      meta: ignoreReadForScheduling,
    });
    // A redirect sends writes on to its target, so it is no plain reference.
    if (!isPrimitiveCellLink(staged) || isWriteRedirectLink(staged)) continue;
    tx.recordCfcWritePolicyInput({
      kind: "initialization",
      mode: "reference",
      target: {
        space: argument.space,
        id: argument.id,
        scope: argument.scope,
        path,
      },
      value: staged,
    }, runtimeWritePolicyAuthorization);
  }
}
