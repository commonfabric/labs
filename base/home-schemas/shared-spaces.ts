/** Narrow host projections of Home's social-space observation and command roles. */

import type { JSONSchema } from "@commonfabric/api";
import type { Schema } from "@commonfabric/api/schema";

/** A routing and membership observation; its revision is opaque to consumers. */
export const sharedSpaceEntrySchema = {
  type: "object",
  properties: {
    space: { type: "string" },
    host: { type: "string" },
    kind: { type: "string" },
    state: { type: "string" },
    revision: { type: "string" },
    title: { type: "string" },
    from: { type: "string" },
    since: { type: "number" },
    lastAction: { type: "unknown" },
  },
  required: ["space", "host", "kind", "state", "revision"],
  additionalProperties: true,
} as const satisfies JSONSchema;

const entries = { type: "array", items: sharedSpaceEntrySchema } as const;
const kindView = {
  type: "object",
  properties: { saved: entries, archived: entries, other: entries },
  required: ["saved", "archived", "other"],
} as const;
const unavailable = {
  type: "object",
  properties: {
    status: { const: "unavailable" },
    reason: { enum: ["loading", "malformed"] },
  },
  required: ["status", "reason"],
} as const;

/** Reads `Home.sharedSpaces.view`, without commands or offer receipts. */
export const sharedSpaceCollectionViewSchema = {
  anyOf: [
    unavailable,
    {
      type: "object",
      properties: {
        status: { const: "ready" },
        entries: {
          type: "object",
          additionalProperties: sharedSpaceEntrySchema,
        },
        saved: entries,
        archived: entries,
        other: entries,
        byKind: { type: "object", additionalProperties: kindView },
      },
      required: ["status", "entries", "saved", "archived", "other", "byKind"],
    },
  ],
} as const satisfies JSONSchema;

/** A host's materialized collection observation, including explicit availability. */
export type HomeSharedSpaceCollectionView = Schema<
  typeof sharedSpaceCollectionViewSchema
>;

/** Reads `Home.sharedSpaces.receipts`, without membership lists or commands. */
export const sharedSpaceReceiptViewSchema = {
  anyOf: [
    unavailable,
    {
      type: "object",
      properties: {
        status: { const: "ready" },
        offers: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              from: { type: "string" },
              id: { type: "string" },
              space: { type: "string" },
              host: { type: "string" },
              kind: { type: "string" },
              profileConflict: { enum: ["profile", "unknown-profile"] },
            },
            required: ["from", "id", "space", "host", "kind"],
            additionalProperties: true,
          },
        },
      },
      required: ["status", "offers"],
    },
  ],
} as const satisfies JSONSchema;

/**
 * Reads `Home.sharedSpaces.profiles`: which of the person's profiles acts in
 * each space the catalog holds an entry for, keyed by the space's DID. A
 * space's value is `unrecorded` when Home records no profile for it,
 * `unreadable` when Home's record cannot be read, and, with the `profile`'s
 * space DID, `live` when the record names one of the person's own profiles,
 * `retired` when it names one they retired, and `foreign` when it names a
 * profile that is not the person's own now. None of these means the
 * person's default profile. `live` lists the spaces of the person's own
 * profiles that are not retired.
 */
export const sharedSpaceProfileViewSchema = {
  anyOf: [
    unavailable,
    {
      type: "object",
      properties: {
        status: { const: "ready" },
        spaces: {
          type: "object",
          additionalProperties: {
            anyOf: [
              {
                type: "object",
                properties: {
                  status: { enum: ["unrecorded", "unreadable"] },
                },
                required: ["status"],
              },
              {
                type: "object",
                properties: {
                  status: { enum: ["live", "retired", "foreign"] },
                  profile: { type: "string" },
                },
                required: ["status", "profile"],
              },
            ],
          },
        },
        live: { type: "array", items: { type: "string" } },
      },
      required: ["status", "spaces", "live"],
    },
  ],
} as const satisfies JSONSchema;

/** A host's materialized profile observation, including explicit availability. */
export type HomeSharedSpaceProfileView = Schema<
  typeof sharedSpaceProfileViewSchema
>;

/**
 * Reads only command bindings at `Home.sharedSpaces.commands`. Event schemas
 * retain every field so Home's authored validator sees malformed optional data.
 * Host callers observe completion through ordinary handling receipts.
 */
export const sharedSpaceCommandsSchema = {
  type: "object",
  properties: {
    register: {
      type: "object",
      additionalProperties: true,
      asCell: ["stream"],
    },
    changeMembership: {
      type: "object",
      additionalProperties: true,
      asCell: ["stream"],
    },
  },
  required: ["register", "changeMembership"],
} as const satisfies JSONSchema;

/** Reads only the import-undo binding at `Home.sharedSpaces.imports`. */
export const sharedSpaceImportCommandsSchema = {
  type: "object",
  properties: {
    remove: { type: "object", additionalProperties: true, asCell: ["stream"] },
  },
  required: ["remove"],
} as const satisfies JSONSchema;
