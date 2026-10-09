import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";
import { MAX_TTL_DAYS } from "./ingest-channels.utils.ts";

// The CONTROL plane for ingest channels: mint, list, rotate, and revoke. A
// mint may carry a proof of a Gmail mailbox, which binds the channel to it.
//
// A verb that acts on one space carries that space in its path, under
// `/api/spaces/:space/`, so that whatever dispatches requests by space can
// send it to the deployment holding that space without reading the body. The
// one verb that names no space, the caller's own list, sits at
// `/api/ingest-channels/list`.
//
// Both prefixes are deliberately NOT under the data plane's `/api/ingest/*` or
// `/api/spaces/:space/ingest/*`:
//   1. Those carry `cors({ origin: "*", allowMethods: ["POST"] })`.
//      Inheriting that would make this a credentialed cross-origin POST surface,
//      against a written invariant of the first-party auth spec ("the protected
//      routes do not expose wildcard CORS").
//   2. `POST /api/ingest/channels` would collide with `POST /api/ingest/:id`.
//   3. Data plane and control plane should not share middleware.
// Keep the `ingest` and `ingest-channels` path segments separate LITERAL
// strings — a future `ingest*` pattern would silently merge them again.
//
// EVERY verb is POST, including list and revoke. Not aesthetics: the in-runtime
// signer is a hardcoded POST-only path allowlist
// (PROTECTED_TOOLSHED_FIRST_PARTY_ROUTES), so a GET or DELETE cannot be signed
// by an in-pattern caller at all. POST-only keeps a future shell/pattern client
// reachable.

const tags = ["Ingest Channels"];

/** The prefix of every verb that acts on one space, named in the path. */
export const SPACE_BASE = "/api/spaces/:space/ingest-channels";

/** The prefix of the one verb that names no space: the caller's own list. */
export const CALLER_BASE = "/api/ingest-channels";

const spaceParams = z.object({
  space: z.string().describe(
    "The did:key of the space the channel writes into. You must hold an " +
      "explicit OWNER grant on its ACL.",
  ),
});

// An idempotency key; see `claimMintRequest` for why a credential-minting route
// needs one when request proofs have no replay cache.
const requestIdField = z.string().describe(
  "A caller-generated random id. Replaying a request with an id already used " +
    "returns 409, and changes nothing and returns no secret.",
);

const cellTarget = z.object({
  space: z.string(),
  id: z.string(),
  path: z.array(z.string()),
}).describe("The parts of the link to the cell a gmail channel writes.");

const channelSummary = z.object({
  id: z.string(),
  name: z.string(),
  space: z.string(),
  causePrefix: z.string().optional().describe(
    "A device channel's cause prefix.",
  ),
  target: cellTarget.optional(),
  installId: z.string(),
  kind: z.enum(["device", "gmail"]).describe(
    "`device`: a device POSTs records with the token into journal cells " +
      "under the cause prefix. `gmail`: toolshed writes each Gmail push " +
      "notification for the bound mailbox into the target cell.",
  ),
  createdAt: z.string(),
  enabled: z.boolean(),
  owner: z.string().optional(),
  expiresAt: z.string().optional(),
  revoked: z.object({ at: z.string(), by: z.string() }).optional(),
  revocations: z.array(z.object({ at: z.string(), by: z.string() })).optional(),
  lastSeenAt: z.string().nullable(),
  revision: z.number(),
});

const jsonError = {
  content: { "application/json": { schema: z.object({ error: z.string() }) } },
};

const commonResponses = {
  [HttpStatusCodes.BAD_REQUEST]: { ...jsonError, description: "Invalid input" },
  [HttpStatusCodes.UNAUTHORIZED]: {
    ...jsonError,
    description: "Missing or invalid first-party request proof",
  },
  // One indistinguishable denial covering: bad space DID, a space this
  // deployment does not host, no ACL, a malformed ACL, and simply not being an
  // owner. Splitting them would hand any keypair holder an existence oracle
  // over the deployment's whole space inventory.
  [HttpStatusCodes.FORBIDDEN]: {
    ...jsonError,
    description:
      "Not an owner of that space, no such space, or no such channel " +
      "writing into it",
  },
  [HttpStatusCodes.CONFLICT]: {
    ...jsonError,
    description:
      "Replayed requestId, or this deployment cannot write to the space",
  },
  // Both of these come from middleware mounted ahead of the handler, so no
  // handler code returns them and they are easy to omit from the contract —
  // but a client sees them and has to tell them apart. 413 is the body limit,
  // which runs BEFORE signature verification so an oversized body costs no
  // Ed25519 work; 422 is stoker's `defaultHook` answering a zod failure, which
  // runs AFTER auth, so it is only reachable with a valid proof.
  [HttpStatusCodes.REQUEST_TOO_LONG]: {
    ...jsonError,
    description: "Request body exceeds the limit (checked before auth)",
  },
  [HttpStatusCodes.UNPROCESSABLE_ENTITY]: {
    ...jsonError,
    description: "Body failed schema validation (checked after auth)",
  },
  [HttpStatusCodes.TOO_MANY_REQUESTS]: {
    ...jsonError,
    description: "Rate limited",
  },
  [HttpStatusCodes.BAD_GATEWAY]: {
    ...jsonError,
    description: "Storage failure",
  },
} as const;

/**
 * The token is returned ONCE, here and on rotate, and never stored in clear.
 * A gmail channel, which no device POSTs to, carries no URL and no token.
 */
const mintResult = z.object({
  id: z.string(),
  url: z.string().optional().describe(
    "Where a device POSTs records. Absent for a gmail channel.",
  ),
  space: z.string(),
  causePrefix: z.string().optional().describe(
    "A device channel's cause prefix.",
  ),
  target: cellTarget.optional(),
  installId: z.string(),
  expiresAt: z.string().optional(),
  token: z.string().optional().describe(
    "Shown once. Hand it to the device. Absent for a gmail channel.",
  ),
  emailAddress: z.string().optional().describe(
    "The mailbox the channel is bound to, when the mint carried a proof.",
  ),
});

const gmailProof = z.union([
  z.object({
    accessToken: z.string().min(1).max(4096).describe(
      "A Google access token that reads the mailbox. Used for one profile " +
        "lookup and not stored.",
    ),
  }).strict(),
  z.object({
    idToken: z.string().min(1).max(4096).describe(
      "A Google ID token naming the mailbox, for one of the OAuth client " +
        "ids this deployment accepts. Grants nothing, and is the proof to " +
        "prefer.",
    ),
  }).strict(),
]).describe(
  "Binds the channel to the Gmail mailbox the proof is for, in this mint: " +
    "one of the two tokens, never both. Comes with `target`, the cell the " +
    "notifications are written to.",
);

export const mint = createRoute({
  path: `${SPACE_BASE}/mint`,
  method: "post",
  tags,
  request: {
    params: spaceParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            installId: z.string().describe(
              "Stable per-device id. Also the cross-repo join key and the " +
                "provenance mark's audience.",
            ),
            causePrefix: z.string().optional().describe(
              "A device channel's cell-cause prefix, `location` unless " +
                "named. Not for a gmail channel, which names a `target`.",
            ),
            name: z.string().optional(),
            ttlDays: z.number().int().positive().max(MAX_TTL_DAYS).optional(),
            target: z.object({
              "/": z.object({
                "link@1": z.object({
                  id: z.string(),
                  space: z.string(),
                  path: z.array(z.string()).optional(),
                }).passthrough(),
              }),
            }).optional().describe(
              "The cell a gmail channel writes, as a link into the space the " +
                "mint is addressed to. Comes with `gmail`; the two make the " +
                "channel a gmail channel, and without them it is a device " +
                "channel.",
            ),
            gmail: gmailProof.optional(),
            requestId: requestIdField,
          }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: { "application/json": { schema: mintResult } },
      description:
        "Channel minted (or its token rotated in place), and bound to the " +
        "mailbox when a proof was given",
    },
    ...commonResponses,
    [HttpStatusCodes.BAD_REQUEST]: {
      ...jsonError,
      description:
        "Invalid input, a mailbox proof without a target cell or on a " +
        "device channel, a proof Google did not accept, or one this " +
        "deployment does not accept",
    },
    [HttpStatusCodes.CONFLICT]: {
      ...jsonError,
      description:
        "Replayed requestId, a channel registered to another owner or " +
        "writing another cause prefix or target cell, this deployment " +
        "cannot write to the space, or the channel was minted but the " +
        "mailbox is at its channel limit",
    },
    [HttpStatusCodes.BAD_GATEWAY]: {
      ...jsonError,
      description: "Storage failure, or Google could not be reached",
    },
  },
});

const listResponses = (description: string) => ({
  [HttpStatusCodes.OK]: {
    content: {
      "application/json": {
        schema: z.object({ channels: z.array(channelSummary) }),
      },
    },
    description,
  },
  ...commonResponses,
});

export const list = createRoute({
  path: `${SPACE_BASE}/list`,
  method: "post",
  tags,
  request: {
    params: spaceParams,
    body: { content: { "application/json": { schema: z.object({}) } } },
  },
  responses: listResponses(
    "EVERY channel targeting the space, whoever minted it, including revoked " +
      "ones, which is how a space's current owner discovers a channel minted " +
      "by someone whose access has since been removed, and the only place a " +
      "revoked channel's `revision` can be read. Requires owning the space. " +
      "Never includes secretHash.",
  ),
});

export const listOwn = createRoute({
  path: `${CALLER_BASE}/list`,
  method: "post",
  tags,
  request: {
    // Strict, so that a caller sending `space` here, where it would be
    // dropped and the wrong list returned, is told instead.
    body: {
      content: { "application/json": { schema: z.object({}).strict() } },
    },
  },
  responses: listResponses(
    "The channels this caller minted, in whichever spaces, live ones only — " +
      "the owner index is pruned on revoke because its length is the " +
      "live-channel cap. Never includes secretHash.",
  ),
});

export const rotate = createRoute({
  path: `${SPACE_BASE}/rotate`,
  method: "post",
  tags,
  request: {
    params: spaceParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            ttlDays: z.number().int().positive().max(MAX_TTL_DAYS).optional(),
            requestId: requestIdField,
          }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: { "application/json": { schema: mintResult } },
      description: "New token minted; the previous one stops working",
    },
    ...commonResponses,
  },
});

export const revoke = createRoute({
  path: `${SPACE_BASE}/revoke`,
  method: "post",
  tags,
  request: {
    params: spaceParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            requestId: requestIdField,
            // REQUIRED, and the actual defense. The request id only makes a
            // revoke at-most-once-DELIVERED; it does nothing for one that is
            // captured and withheld, because an id that was never spent is
            // still live for the whole proof window. Naming the generation the
            // caller looked at is what stops a withheld revoke from landing on
            // a credential minted after it was signed. Read it from `list`.
            expectedRevision: z.number().int().nonnegative(),
          }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          // `revision` is the generation AFTER this write. Returned because
          // `revoke` requires the caller to name a current generation, and a
          // caller who has just revoked would otherwise have to go find it
          // again via a space-scoped list.
          schema: z.object({
            id: z.string(),
            revokedAt: z.string(),
            revision: z.number(),
          }),
        },
      },
      description:
        "Channel disabled; the registration is kept as an audit record",
    },
    ...commonResponses,
    // Overrides the shared 409: revoke has a cause the others do not, and it is
    // the one a caller is most likely to hit. Sending them to look for a
    // replayed requestId when they actually raced a rotate wastes the debugging
    // session the description exists to shorten.
    [HttpStatusCodes.CONFLICT]: {
      ...jsonError,
      description:
        "`expectedRevision` no longer matches the stored channel (list it " +
        "again and re-issue), replayed requestId, or this deployment cannot " +
        "write to the space",
    },
  },
});

export type MintRoute = typeof mint;
export type ListRoute = typeof list;
export type ListOwnRoute = typeof listOwn;
export type RotateRoute = typeof rotate;
export type RevokeRoute = typeof revoke;
