import { createRoute, z } from "@hono/zod-openapi";

/**
 * OpenAPI route definition for retrieving pattern files.
 * Serves TSX/TS files from the patterns directory.
 */
export const getPattern = createRoute({
  method: "get",
  path: "/api/patterns/:filename{.+}",
  request: {
    params: z.object({
      filename: z.string().describe(
        "The pattern file path to retrieve (supports subdirectories)",
      ),
    }),
    query: z.object({
      sourceRoot: z.union([z.string(), z.array(z.string())]).optional()
        .describe(
          "Attached source entry pathname under /api/patterns/. Repeat for multiple roots.",
        ),
      identity: z.string().optional().describe(
        "When present, return the complete authored pattern closure's " +
          "content-addressed identity as text/plain instead of the entry " +
          "file's source.",
      ),
    }),
  },
  responses: {
    200: {
      description:
        "Pattern file content, or the complete authored pattern closure's " +
        "content identity when `identity` is present.",
      content: {
        "text/typescript-jsx": {
          schema: z.string(),
        },
        "text/plain": {
          schema: z.string(),
        },
      },
    },
    400: {
      description: "Invalid file path",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
    404: {
      description: "File not found",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
    500: {
      description: "Internal server error",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
  },
});
