import type { MemorySpace } from "@commonfabric/memory/interface";
import { hashOf } from "@commonfabric/data-model";

/**
 * What a slug's id is derived from: the space that holds the slug, and the
 * slug.
 *
 * This is a type alias, not an `interface`, because `slugIdForSpace()` hashes
 * one, and what gets hashed is a `FabricValue`. An `interface` is never
 * assignable to `FabricPlainObject`, however plain its members: TypeScript
 * gives an anonymous object type the implicit index signature which that
 * requires, and does not give one to an interface.
 */
export type SlugCause = {
  space: MemorySpace;
  slug: string;
};

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 80;

export function isSlugAddress(value: string): boolean {
  return !value.includes(":");
}

/**
 * Whether a token is a slug, without throwing to say no.
 *
 * `validateSlug` reports *why* a slug is invalid, which suits a caller that
 * was handed one and has to explain itself. A caller deciding whether an
 * arbitrary path segment is a slug at all is asking a question, and a question
 * deserves an answer.
 */
export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= MAX_SLUG_LENGTH &&
    SLUG_PATTERN.test(slug);
}

export function validateSlug(slug: string): string {
  if (slug.length === 0) {
    throw new Error("Slug must not be empty.");
  }
  if (slug.includes("/")) {
    throw new Error("Slug must not contain '/'.");
  }
  if (slug.includes(":")) {
    throw new Error("Slug must not contain ':'.");
  }
  if (slug.length > MAX_SLUG_LENGTH) {
    throw new Error(`Slug must be at most ${MAX_SLUG_LENGTH} characters.`);
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      "Slug must use lowercase letters, numbers, and single hyphens between words.",
    );
  }
  return slug;
}

export function slugCause(space: MemorySpace, slug: string): SlugCause {
  return { space, slug: validateSlug(slug) };
}

export function slugIdForSpace(space: MemorySpace, slug: string): string {
  return hashOf({ causal: slugCause(space, slug) }).taggedHashString;
}

/**
 * The one cell in a space that names its slugs: a map keyed by slug name,
 * `true` at every key. It exists because slug cells are unenumerable by
 * construction — each lives at an id derived from its name, so nothing can
 * find a name it was never told — and "arrive by name" needs names a caller
 * can discover.
 *
 * The index holds names and nothing else. The slug cell stays the one
 * authority on where a name points; a copy of the target here would be a
 * second answer that could disagree with it.
 *
 * The cause is shaped unlike any slug's — `{space, slugIndex: true}` against
 * `{space, slug}` — so the index can never collide with a slug cell however
 * a name is chosen.
 */
export function slugIndexIdForSpace(space: MemorySpace): string {
  return hashOf({ causal: { space, slugIndex: true } }).taggedHashString;
}
