import type { MemorySpace } from "./storage/interface.ts";

/**
 * The cause of the root `PatternFactory.inSpace(..., { root: true })` places
 * in `space`, the space it creates. The space's genesis commit reserves the
 * address it derives there, so the root's address is fixed before the run that
 * places it. The cause names `space`, so the roots of two such spaces are two
 * entities, and a pattern keying a record by the entity a root names, as one
 * keys a person's record by their profile, keeps one person's record apart
 * from another's.
 */
export function inSpaceRootCause(space: MemorySpace): string {
  return `in-space-root:${space}`;
}
