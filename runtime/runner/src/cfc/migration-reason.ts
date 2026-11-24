// Why: the runnability backstop (`PiecesController.#healDefaultRootByRollForward`)
// must distinguish the ONE CFC-rejection class it can safely recover from — an
// old document that cannot migrate onto a now-required field that carries no
// default (the estuary `favorites` case) — from every OTHER CFC rejection
// (policy, provenance, prepared-digest races), which must stay fail-closed.
// The backstop fires on one further, non-CFC signal — a refused stored argument
// (`isStoredArgumentSchemaRefusal`) — which this token says nothing about; the
// discrimination here is among CFC rejections.
// Repointing a healthy root's pattern identity in response to a transient
// ordering blip would be a correctness bug; see PR #4967's review.
//
// The discriminator is carried as a machine-stable TOKEN inside the prepare
// `reason` string, not as an error subclass, because only the message string
// survives the plain-`Error` re-wrap the runner applies at its setup-commit
// boundary (`runner.ts` — `throw new Error(error.message, { cause })`). Matching
// a token (not prose, not `instanceof`) is what keeps the producer (the CFC
// merge) and the cross-package consumer (the piece controller) in lockstep.
//
// This module is deliberately dependency-free so the browser-safe piece
// controller can import the token without pulling in the `cfc/mod.ts` barrel.

/**
 * Stable machine token marking a CFC prepare rejection as the additive-required
 * schema-migration incompatibility class — the only CFC rejection the
 * default-root runnability backstop rolls forward on. Emitted into the prepare
 * `reason` (see `prepare.ts`) so it appears in the commit-rejection message.
 */
export const CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON =
  "cfc-schema-migration-incompatible";

/**
 * Additive-migration incompatibility raised by the CFC schema merge: an old
 * document predates a now-required field that declares no default, so the old
 * value cannot be preserved. The merge throws this so the prepare catch can tag
 * its recorded reason with {@link CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON}
 * without string-sniffing prose. The `.message` is left human-readable and
 * unchanged (existing assertions match it as a substring); only the recorded
 * reason gains the token.
 */
export class CfcSchemaMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CfcSchemaMigrationError";
  }
}
