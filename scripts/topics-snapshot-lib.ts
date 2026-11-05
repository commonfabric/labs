/**
 * The half of the Topics export/restore vocabulary that needs the offline
 * store reader, kept apart from `topics-rehearsal-lib.ts` so that the restore
 * never pays for it.
 *
 * `@commonfabric/state-inspector` publishes one entry point, and that barrel
 * re-exports `db.ts`, which imports `@db/sqlite`, which opens its dynamic
 * library with a top-level `await dlopen`. Importing the barrel therefore
 * costs `--allow-ffi` at module load however pure the function being imported
 * is. `topics-restore.ts` talks to a running server over `cf` and touches no
 * database, and its shebang says so; anything it imports must keep that true.
 *
 * So the rule this file exists to enforce: a helper that needs the store
 * reader lives here, where only `topics-export.ts` imports it. A helper that
 * does not lives in `topics-rehearsal-lib.ts`, which both sides import and
 * which stays free of this dependency — `topics-rehearsal-lib.test.ts` holds
 * a check that it did.
 */

import type { FabricValue } from "@commonfabric/data-model";
import { decodedLinkOf } from "@commonfabric/state-inspector";

/**
 * The entity a piece's `argument` link points at, or undefined.
 *
 * Decoded rather than shape-matched. A link is stored in either of two
 * encodings — the `{ "/": { "link@N": … } }` sigil, or a `FabricLink` the
 * codec restores as an instance — and a reader that matches one of them by
 * hand reads the other as "this piece reports no argument entity". For the
 * export that aborts the whole run, which is the recovery payload failing to
 * be taken at the moment it is most wanted. `decodedLinkOf` is the one place
 * that knows both encodings, so which one a given snapshot happens to carry
 * stops being a question these scripts have to answer.
 */
export function argumentIdOf(
  document: Record<string, FabricValue>,
): string | undefined {
  return decodedLinkOf(document.argument)?.id;
}
