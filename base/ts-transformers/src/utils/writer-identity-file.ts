/**
 * Canonical spelling of a module's source file inside CFC writer identities.
 *
 * This single normalizer feeds every surface that records or matches a
 * writer's source file, so the spellings cannot drift apart:
 * - `WriteAuthorizedBy` claim minting (schema-generator's
 *   `extractWriteAuthorizedByIdentity`),
 * - runtime provenance stamping (module-scope-function-hardening's baked
 *   `sourceFileName`),
 * - `PolicyOf` source matching (schema-generator's normalized fallback).
 *
 * The compiler sees file names exactly as the caller spelled them, and the
 * spellings differ by compile stack: the runner's engine prefixes every
 * module with a per-load `/<id>` segment (and mounts fabric imports under
 * `cf-mount/<identity>/`), while direct compiles hand the resolver's names
 * straight through — `/`-prefixed root-relative from `FileSystemProgramResolver`
 * and `HttpProgramResolver`, bare-relative from piece manifests via
 * `StaticProgramResolver`.
 *
 * Writer identities must record the *authored* path — load- and
 * resolver-independent — so callers whose compile names are not already
 * authored paths pass `canonicalize`, their own compile-name → authored-name
 * mapping (the engine passes its `storedFilenameFor`). Without `canonicalize`
 * the name is recorded verbatim (modulo separators). The historical behavior —
 * blindly stripping the first segment of any absolute name as a presumed
 * engine prefix — mis-spelled modules from direct compiles whose first
 * segment was a real path segment (`/api/...`), shearing claim minting away
 * from provenance stamping across compile stacks (labs#4772 / CT-1886).
 *
 * Spelling-compat note: stored claims keep their mint-time spelling forever.
 * Until the runner's claim↔identity comparison is spelling-tolerant (anchored
 * on `moduleIdentity`; labs#4772), any change to the spellings this function
 * emits shears aged stores against new live provenance.
 */
export function normalizeWriterIdentityFile(
  fileName: string,
  canonicalize?: (fileName: string) => string,
): string {
  const normalized = fileName.replace(/\\/g, "/");
  return canonicalize ? canonicalize(normalized) : normalized;
}
