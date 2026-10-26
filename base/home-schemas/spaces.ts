/**
 * Space entry schemas for home space data.
 * These define the structure of user's managed spaces list.
 */

import type { JSONSchema } from "@commonfabric/api";
import type { Schema } from "@commonfabric/api/schema";

/**
 * One entry in a user's Home space list. An entry with a `did` opens that
 * space, and its `name` is only what the entry is called: two entries may share
 * one, and renaming one changes nothing else. An entry with no `did` was written
 * before spaces had random identities, and its `name` resolves as a legacy
 * space name until the runtime adopts it under the DID the name resolves to.
 *
 * Anything with Home write access can add an entry, so an entry is a label
 * and a route and never authority: one a user did not create can mislead them
 * about what a space is called, and grants nothing.
 */
export const spaceEntrySchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    did: { type: "string" },
  },
  required: ["name"],
} as const satisfies JSONSchema;

export type SpaceEntry = Schema<typeof spaceEntrySchema>;

export const spacesListSchema = {
  type: "array",
  items: spaceEntrySchema,
  default: [],
} as const satisfies JSONSchema;

export type SpacesList = Schema<typeof spacesListSchema>;

/**
 * Site table: where each space lives. The home space carries a per-user
 * table of `did → host` facts — the v0 of hint-driven space resolution
 * (2026-06-09 federation session: "the smallest possible slice"). The
 * runtime reads it as its live host lookup; writers include the local
 * daemon (syncing its served sources) and link-receipt flows.
 *
 * Entries are HINTS: unverified in v0 (the space's own log is the
 * integrity boundary, not the host). The first hint may replace an
 * unseeded default-host provider, but it cannot replace a seed or an
 * earlier accepted hint.
 *
 * SECURITY (v0, explicit): the table is ordinary home-space data, so
 * ANYTHING with home-space write access — including patterns running
 * there — can steer where an unseeded space is fetched from, including
 * a space already opened provisionally through the default host.
 * That is a deliberate v0 trade (matching "don't even verify in the
 * first month") and the forcing function for audience-binding the
 * session handshake before host hints ever come from less-trusted
 * data.
 *
 * Table semantics: an array with no uniqueness constraint. During initial
 * hydration, the last entry for a DID that contains only an HTTP or HTTPS
 * origin is the candidate route. Credentials, paths, queries, and fragments
 * make an entry invalid. A seed or accepted hint remains fixed. A default-host
 * fallback is provisional until the first hint is accepted. Removing an entry
 * does not unregister an accepted route until the runtime restarts.
 */
export const spaceHostEntrySchema = {
  type: "object",
  properties: {
    /** The space DID this fact is about — the table key. */
    did: { type: "string" },

    /** HTTP or HTTPS origin currently serving the space. */
    host: { type: "string" },

    /** ISO timestamp of when this fact was recorded. */
    updatedAt: { type: "string" },

    /** Who recorded it (e.g. "local-source-sync", "share-link"). */
    source: { type: "string" },
  },
  required: ["did", "host"],
} as const satisfies JSONSchema;

export type SpaceHostEntry = Schema<typeof spaceHostEntrySchema>;

export const siteTableSchema = {
  type: "array",
  items: spaceHostEntrySchema,
  default: [],
} as const satisfies JSONSchema;

export type SiteTable = Schema<typeof siteTableSchema>;

/**
 * Canonical cause for the home-space site-table cell, shared by the
 * runtime (reader) and embedder daemons (writers) so both address the
 * same document: `getCell(userDid, siteTableCause(userDid), siteTableSchema)`.
 */
export function siteTableCause(userDid: string): { siteTable: string } {
  return { siteTable: userDid };
}
