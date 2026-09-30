import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";
import { z } from "zod";
import { HealthResponseSchema } from "./health.handlers.ts";

const tags = ["Health"];

export const index = createRoute({
  path: "/_health",
  method: "get",
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      HealthResponseSchema,
      "The health status",
    ),
  },
});

export const stats = createRoute({
  path: "/api/health/stats",
  method: "get",
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        timestamp: z.number(),
        serverStart: z.number(),
        logCounts: z.any(),
        timingStats: z.any(),
        slowQueries: z.array(z.any()),
        // The memory server's decoded-document caches, keyed by open space
        // (packages/memory/v2/engine.ts `DocumentCacheDiagnostics`) —
        // present whenever a memory server is co-hosted in this process.
        documentCaches: z.object({
          totalBudgetBytes: z.number().int().positive(),
          bytes: z.number().int().nonnegative(),
          totalBudgetEvictions: z.number().int().nonnegative(),
          spaces: z.record(
            z.string(),
            z.object({
              hits: z.number().int().nonnegative(),
              misses: z.number().int().nonnegative(),
              evictions: z.number().int().nonnegative(),
              patchReplays: z.number().int().nonnegative(),
              resumes: z.number().int().nonnegative(),
              entries: z.number().int().nonnegative(),
              bytes: z.number().int().nonnegative(),
              budgetBytes: z.number().int().positive(),
              maxEntries: z.number().int().positive(),
            }),
          ),
        }).optional(),
        // The serving loop's counters (server-execution v2,
        // serving-loop.md §7) — present only while an ExecutorHost runs
        // in this process (the ON arm).
        servingLoop: z.any().optional(),
      }),
      "Logger counts and timing statistics",
    ),
  },
});

export const dash = createRoute({
  path: "/api/health/dash",
  method: "get",
  tags,
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "text/html": {
          schema: z.any().describe("Health dashboard HTML page"),
        },
      },
      description: "Health dashboard",
    },
  },
});

export type IndexRoute = typeof index;
export type StatsRoute = typeof stats;
export type DashRoute = typeof dash;
