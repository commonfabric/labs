import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";

const tags = ["Link Preview"];

// Response schema for link preview metadata
const LinkPreviewSchema = z.object({
  title: z.string().optional().describe("Page title"),
  description: z.string().optional().describe("Page description"),
  image: z.string().optional().describe("Screenshot URL from Jina"),
  url: z.string().url().describe("The requested URL"),
});

export const getLinkPreview = createRoute({
  path: "/api/link-preview/:url{.+}",
  method: "get",
  tags,
  request: {
    params: z.object({
      url: z.string().describe("URL encoded web page URL to preview").openapi({
        example: "https://github.com",
      }),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: LinkPreviewSchema,
        },
      },
      description: "Link preview metadata",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
      description: "Invalid request parameters",
    },
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
      description: "Error fetching link preview",
    },
  },
});

export type GetLinkPreviewRoute = typeof getLinkPreview;
