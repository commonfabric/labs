/**
 * Favorites schemas for home space data.
 * These define the structure of user's favorited pieces.
 */

import type { CellScope, JSONSchema } from "@commonfabric/api";
import type { Schema } from "@commonfabric/api/schema";

export const favoriteEntrySchema = {
  type: "object",
  properties: {
    // we use type unknown to validate, but avoid including children
    cell: { type: "unknown", asCell: ["cell"] },
    // Discovery tags snapshotted from the piece's schema when favorited
    // (lowercased, without the leading `#`). Matched by wish() tag search.
    tags: { type: "array", items: { type: "string" }, default: [] },
    userTags: { type: "array", items: { type: "string" }, default: [] },
    spaceName: { type: "string" },
    // Stable key derived from the favorited piece's address (see favoriteKey).
    // The favorite entity is addressed by this key, so a re-favorite dedups and
    // an unfavorite removes by identity without reading the whole list.
    id: { type: "string" },
  },
  required: ["cell"],
} as const satisfies JSONSchema;

export type FavoriteEntry = Schema<typeof favoriteEntrySchema>;

export const favoriteListSchema = {
  type: "array",
  items: favoriteEntrySchema,
} as const satisfies JSONSchema;

export type FavoriteList = Schema<typeof favoriteListSchema>;

/**
 * A favorited piece's address: the space its document lives in, the scope its
 * id resolves in there, that id, and the path to the favorited value.
 *
 * The four are one value so that an id and the scope completing it cannot be
 * declared apart. One id in two scopes is two documents, so an id travelling
 * on its own reaches whichever of them its reader defaults to.
 */
export type FavoriteAddress = {
  /** The space the piece's document lives in. */
  space: string;

  /** The scope the id resolves in within that space. */
  scope: CellScope;

  /** The piece's entity id, its URI scheme included. */
  id: string;

  /** Path to the favorited value, defaulting to the document root. */
  path?: readonly unknown[];
};

/**
 * The key a favorite is addressed by, built from the whole of `address`.
 * Computed by the caller that adds or removes the favorite (which holds the
 * piece's address) and stored on the entry as `id`, so the home handlers reach
 * the same favorite entity with `favorites.elementById(id)`. Pattern code
 * cannot introspect a cell's link, so the key is derived here and passed in as
 * event data rather than recomputed in the handler.
 *
 * A space-scoped address names no scope in its key, that being the scope an
 * address defaults to; only a narrower scope is written. The elision is what
 * every favorite in durable storage is keyed by, so it is a compatibility
 * constraint and not a spelling preference: naming the space scope here would
 * put each of those entries past the reach of its own address.
 */
export function favoriteKey(address: FavoriteAddress): string {
  const { id, path = [], scope, space } = address;
  return scope === "space"
    ? JSON.stringify([space, id, path])
    : JSON.stringify([space, id, path, scope]);
}
