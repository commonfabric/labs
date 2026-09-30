// The pattern-lifecycle verbs as server calls
// (docs/features/server-pattern-lifecycle.md): a client sends the source
// it resolved, and the space's serving runtime compiles, materializes or
// replaces, and commits. Every verb is a POST at its own prefix, the shape
// the first-party request proof signs and the ingest control plane
// established.

import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";

const tags = ["Pattern Lifecycle"];

export const BASE = "/api/pattern-lifecycle";

/** The largest request body a verb accepts; a program's files ride inline. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

const spaceField = z.string().describe(
  "The did:key of the space to act in. You must hold a WRITE or OWNER grant " +
    "on its ACL.",
);

const programSchema = z.object({
  main: z.string().describe("The entry file's name within `files`."),
  mainExport: z.string().optional().describe(
    'The entry file\'s export holding the pattern; "default" when absent.',
  ),
  files: z.array(z.object({ name: z.string(), contents: z.string() })),
  sourceRoots: z.array(z.string()).optional().describe(
    "Entry points retained and compiled without being run, such as tests.",
  ),
  dataFiles: z.array(z.string()).optional().describe(
    "Names of entries in `files` that carry data rather than code.",
  ),
}).describe(
  "A program as the client resolved it: every file it needs, by name.",
);

const patternRefSchema = z.object({
  identity: z.string(),
  symbol: z.string(),
}).describe(
  "A content-addressed pattern pointer the space already holds — the " +
    "result of an earlier upload.",
);

const sourceFields = {
  program: programSchema.optional(),
  pattern: patternRefSchema.optional(),
};

const jsonError = {
  content: {
    "application/json": {
      schema: z.object({
        error: z.string(),
        code: z.string().describe("A stable name for the refusal."),
      }),
    },
  },
};

const commonResponses = {
  [HttpStatusCodes.BAD_REQUEST]: { ...jsonError, description: "Invalid input" },
  [HttpStatusCodes.UNAUTHORIZED]: {
    ...jsonError,
    description: "Missing or invalid first-party request proof",
  },
  [HttpStatusCodes.FORBIDDEN]: {
    ...jsonError,
    description: "Not a writer of that space, or no such space",
  },
  [HttpStatusCodes.NOT_FOUND]: {
    ...jsonError,
    description: "The named pattern or piece is not in the space",
  },
  [HttpStatusCodes.CONFLICT]: {
    ...jsonError,
    description:
      "The requested slug is taken, or the piece is not on the pattern the " +
      "update was proved against",
  },
  [HttpStatusCodes.REQUEST_TOO_LONG]: {
    ...jsonError,
    description: "Request body exceeds the limit (checked before auth)",
  },
  [HttpStatusCodes.UNPROCESSABLE_ENTITY]: {
    ...jsonError,
    description:
      "Body failed schema validation, the program did not compile, the " +
      "candidate is incompatible with the piece, or setup refused it",
  },
  [HttpStatusCodes.TOO_MANY_REQUESTS]: {
    ...jsonError,
    description: "Rate limited",
  },
  [HttpStatusCodes.INTERNAL_SERVER_ERROR]: {
    ...jsonError,
    description: "The serving side failed",
  },
  [HttpStatusCodes.SERVICE_UNAVAILABLE]: {
    ...jsonError,
    description:
      "This deployment does not run the serving loop, or does not serve " +
      "the space",
  },
} as const;

export const upload = createRoute({
  path: `${BASE}/upload`,
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ space: spaceField, program: programSchema }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": { schema: z.object({ pattern: patternRefSchema }) },
      },
      description: "The program compiled and its closure is in the space",
    },
    ...commonResponses,
  },
});

export const instantiate = createRoute({
  path: `${BASE}/instantiate`,
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            space: spaceField,
            ...sourceFields,
            requestKey: z.string().min(1).max(256).optional().describe(
              "Stable caller-scoped creation key. Retry this key after an uncertain outcome or failed registration.",
            ),
            argument: z.record(z.string(), z.unknown()).optional().describe(
              "The new piece's argument; the pattern's defaults when absent.",
            ),
            repository: z.string().optional().describe(
              "Repository locator stored with the piece's source.",
            ),
            slug: z.string().optional().describe(
              "A name for the piece, claimed in the creation transaction; " +
                "a name already taken refuses the whole creation.",
            ),
            force: z.boolean().optional().describe(
              "Take `slug` even when it already names something.",
            ),
            register: z.boolean().optional().describe(
              "Add the piece to the space root's registry.",
            ),
            start: z.boolean().optional().describe(
              "Have the serving loop derive the piece once the creation " +
                "commits (the default); `false` leaves it set up and not " +
                "run until something demands it.",
            ),
          }).refine(
            (body) =>
              (body.program === undefined) !== (body.pattern === undefined),
            { message: "Supply exactly one of `program` and `pattern`." },
          ),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: z.object({
            pieceId: z.string(),
            pattern: patternRefSchema,
            slug: z.string().optional(),
            requestKey: z.string(),
            registration: z.object({
              status: z.enum(["skipped", "pending", "handled", "failed"]),
              error: z.string().optional(),
              attempt: z.number().int().nonnegative().optional(),
              terminal: z.literal(true).optional(),
            }),
          }),
        },
      },
      description: "The piece exists in the space",
    },
    ...commonResponses,
  },
});

export const setsrc = createRoute({
  path: `${BASE}/setsrc`,
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            space: spaceField,
            piece: z.string().describe(
              "The id of the piece whose source is replaced.",
            ),
            ...sourceFields,
            repository: z.string().optional().describe(
              "Repository locator stored with the piece's source.",
            ),
            dangerouslyAllowIncompatibleSchema: z.boolean().optional()
              .describe(
                "Replace the source even when pattern or retained-link " +
                  "schema compatibility cannot be proven, or when the " +
                  "current pattern cannot be loaded at all.",
              ),
            expectedPattern: patternRefSchema.optional().describe(
              "The pattern the update was proved against; a piece on " +
                "another pattern refuses the update.",
            ),
            start: z.boolean().optional().describe(
              "Have the serving loop derive the updated piece once the " +
                "update commits (the default); `false` leaves it to the " +
                "first demand.",
            ),
          }).refine(
            (body) =>
              (body.program === undefined) !== (body.pattern === undefined),
            { message: "Supply exactly one of `program` and `pattern`." },
          ),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: z.object({
            pieceId: z.string(),
            pattern: patternRefSchema,
            revisionId: z.string().describe(
              "The source revision the update appended.",
            ),
            seq: z.number().describe(
              "Position in the space's commit log at which the update was " +
                "accepted.",
            ),
            detachedOrigin: z.string().nullable().describe(
              "The origin the update detached; null when the piece had none.",
            ),
          }),
        },
      },
      description: "The piece's source is replaced",
    },
    ...commonResponses,
  },
});

export type UploadRoute = typeof upload;
export type InstantiateRoute = typeof instantiate;
export type SetSourceRoute = typeof setsrc;
