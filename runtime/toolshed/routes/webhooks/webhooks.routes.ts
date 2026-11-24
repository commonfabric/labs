import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";

const tags = ["Webhooks"];

export const create = createRoute({
  path: "/api/webhooks",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              name: z.string().describe("Human-readable label for the webhook"),
              cellLink: z
                .string()
                .describe(
                  "Serialized cell link JSON for the inbox (payload destination) cell",
                ),
              confidentialCellLink: z
                .string()
                .describe(
                  "Serialized cell link JSON for the confidential config cell (receives URL+secret)",
                ),
            })
            .openapi({
              example: {
                name: "GitHub Push Events",
                cellLink:
                  '{"/" : {"link@1" : {"id" : "of:bafe...", "space" : "did:key:bafe...", "path" : ["webhooks", "github"]}}}',
                confidentialCellLink:
                  '{"/" : {"link@1" : {"id" : "of:cafe...", "space" : "did:key:bafe...", "path" : ["webhooks", "github", "config"]}}}',
              },
            }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            name: z.string(),
          }),
        },
      },
      description:
        "Webhook created. URL and secret written to confidential config cell.",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Invalid request parameters",
    },
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Internal server error",
    },
  },
});

export const ingest = createRoute({
  path: "/api/webhooks/:id",
  method: "post",
  tags,
  request: {
    params: z.object({
      id: z.string().describe("Webhook ID"),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: z.object({ received: z.boolean() }),
        },
      },
      description: "Payload received and written to cell",
    },
    [HttpStatusCodes.UNAUTHORIZED]: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Invalid request",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Invalid payload",
    },
    [HttpStatusCodes.BAD_GATEWAY]: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Downstream write failed",
    },
  },
});

export const list = createRoute({
  path: "/api/webhooks",
  method: "get",
  tags,
  request: {
    query: z.object({
      space: z.string().describe("Space DID to list webhooks for"),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: z.object({
            webhooks: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                cellLink: z.string(),
                enabled: z.boolean(),
                createdAt: z.string(),
                createdBy: z.string(),
              }),
            ),
          }),
        },
      },
      description: "List of webhooks for the space (trusted admin endpoint)",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Missing space parameter",
    },
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Internal server error",
    },
  },
});

export const remove = createRoute({
  path: "/api/webhooks/:id",
  method: "delete",
  tags,
  request: {
    params: z.object({
      id: z.string().describe("Webhook ID to delete"),
    }),
    query: z.object({
      space: z
        .string()
        .describe("Space DID of the webhook owner (ownership check)"),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: z.object({ deleted: z.boolean() }),
        },
      },
      description: "Webhook deleted successfully",
    },
    [HttpStatusCodes.NOT_FOUND]: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Webhook not found",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Missing required parameters",
    },
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Internal server error",
    },
  },
});

export type CreateRoute = typeof create;
export type IngestRoute = typeof ingest;
export type ListRoute = typeof list;
export type RemoveRoute = typeof remove;
