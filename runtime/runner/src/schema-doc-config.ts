/**
 * The ambient control point for the `contentAddressedSchemas` experimental
 * flag (`docs/development/EXPERIMENTAL_OPTIONS.md`): whether link writers
 * replace inline schemas with references to content-addressed schema
 * documents (`docs/specs/content-addressed-schemas.md`, Phase 1).
 *
 * Ambient for the same reason as the modern-cell-rep config: the writer
 * (`createSigilLinkFromParsedLink` in link-utils.ts) is pure module code
 * with no runtime handle. The Runtime propagates its experimental option
 * here and reads the effective state back. Readers are NOT gated — they
 * accept both forms unconditionally, so old data keeps reading whatever
 * the flag does. On by default; an explicit `false` is the rollback
 * override, and because references written under the flag persist,
 * turning it off stops emission without un-writing anything.
 */

let contentAddressedSchemas = true;

/**
 * Sets the flag; `undefined` keeps the current state (the built-in default
 * is on).
 */
export function setContentAddressedSchemasConfig(
  enabled: boolean | undefined,
): void {
  if (enabled !== undefined) contentAddressedSchemas = enabled;
}

/** The effective flag state. */
export function getContentAddressedSchemasConfig(): boolean {
  return contentAddressedSchemas;
}

/** Restores the flag to its default. */
export function resetContentAddressedSchemasConfig(): void {
  contentAddressedSchemas = true;
}
