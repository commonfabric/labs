import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";

const tags = ["Ingest"];

const responses = {
  [HttpStatusCodes.OK]: {
    content: {
      "application/json": {
        schema: z.object({
          received: z.number(),
          appended: z.number(),
        }),
      },
    },
    description: "Records appended to the channel's partition cell",
  },
  [HttpStatusCodes.BAD_REQUEST]: {
    content: {
      "application/json": { schema: z.object({ error: z.string() }) },
    },
    description: "Invalid body or partition",
  },
  [HttpStatusCodes.UNAUTHORIZED]: {
    content: {
      "application/json": { schema: z.object({ error: z.string() }) },
    },
    description: "Invalid request",
  },
  // Reachable only with a correct token, so it leaks nothing to a guesser.
  [HttpStatusCodes.FORBIDDEN]: {
    content: {
      "application/json": { schema: z.object({ error: z.string() }) },
    },
    description: "Valid token, but the channel is revoked, rotated, or expired",
  },
  [413]: {
    content: {
      "application/json": { schema: z.object({ error: z.string() }) },
    },
    description: "Batch too large",
  },
  [HttpStatusCodes.BAD_GATEWAY]: {
    content: {
      "application/json": { schema: z.object({ error: z.string() }) },
    },
    description: "Durable write failed",
  },
} as const;

// POST /api/spaces/:space/ingest/:id — the `journal` sink of a vouched ingest
// channel. An external, DID-less source (a phone beacon, a webhook)
// bearer-authenticates with its per-channel token and durably appends a batch
// of records to the channel's partition cell, each carrying the runtime-minted
// ExternalIngest mark. The body is parsed and validated in the handler (auth
// runs first), so no request body schema is declared here — mirroring the
// webhook ingest route.
//
// `:space` is the space the channel writes into. It is there for whatever
// dispatches requests by space, and a channel addressed through any other
// space answers as an unknown one.
export const ingest = createRoute({
  path: "/api/spaces/:space/ingest/:id",
  method: "post",
  tags,
  request: {
    params: z.object({
      space: z.string().describe("The space the channel writes into"),
      id: z.string().describe("Ingest channel ID"),
    }),
  },
  responses,
});

// POST /api/ingest/:id — the same sink, for a device holding a URL that names
// no space. Mint and rotate hand out the form above.
export const ingestById = createRoute({
  path: "/api/ingest/:id",
  method: "post",
  tags,
  request: {
    params: z.object({
      id: z.string().describe("Ingest channel ID"),
    }),
  },
  responses,
});

export type IngestRoute = typeof ingest;
export type IngestByIdRoute = typeof ingestById;
