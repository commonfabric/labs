import { CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON } from "@commonfabric/runner/cfc/migration-reason";

/**
 * The commit rejection's prefix up to its reason position, the shape the
 * runner surfaces a refused prepare with (`extended-storage-transaction.ts`):
 * `…not prepared: ${reason}`, `reason` being the first that refused.
 */
const UNPREPARED_REJECTION_PREFIX =
  "CFC enforcement rejected commit: relevant transaction was not prepared";

/**
 * The migration token in its FRAMED reason position — `not prepared:
 * <token>: ` — the exact shape the CFC prepare catch emits (`${token}:
 * ${message}` recorded as a reason, surfaced by the commit as `…not prepared:
 * ${reason}`). A bare `includes(token)` would also match the token appearing
 * incidentally inside an UNRELATED, user-influenced error — e.g. an ordinary
 * incompatible-type merge failure at a property path literally named
 * `/cfc-schema-migration-incompatible` — and wrongly authorize a root
 * replacement for a non-additive incompatibility; so would `: <token>: `
 * alone, for a property named to reproduce that framing inside another
 * reason's message. Anchoring at the reason position leaves no
 * user-influenced text ahead of the token.
 */
const FRAMED_MIGRATION_REASON =
  `${UNPREPARED_REJECTION_PREFIX}: ${CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON}: `;

/**
 * Reports whether a cold-start setup repair failed specifically because the
 * CFC SCHEMA MIGRATION rejected the commit — the pinned pattern loads but
 * cannot migrate preserved input or unclassified document data onto a
 * now-required field that carries no default. Generated result fields are not
 * in this class: pattern setup materializes them. This is ONE of the two
 * repair-failure classes the runnability backstop
 * (`PiecesController.#healDefaultRootByRollForward`) acts on — the other is a
 * refused stored argument ({@link isStoredArgumentSchemaRefusal}); every other
 * failure stays fail-closed.
 *
 * The bare `CFC enforcement rejected commit` prefix is NOT a safe trigger: the
 * runner emits it for prepared-digest races, unprepared transactions, and
 * policy/provenance rejections too (`extended-storage-transaction.ts`), none of
 * which are repaired by repointing the root's pattern identity. So the check
 * requires the machine-stable migration token the CFC prepare tags onto this
 * class (`migration-reason.ts`), and only in its framed position
 * ({@link FRAMED_MIGRATION_REASON}). Matching a token in the message — not the
 * error class — is what survives the plain-`Error` re-wrap the runner applies
 * at its setup-commit boundary (`runner.ts`), keeping producer and consumer in
 * lockstep across that boundary and across packages.
 */
export const isCfcMigrationRejection = (error: unknown): boolean =>
  error instanceof Error &&
  error.message.startsWith(FRAMED_MIGRATION_REASON);
