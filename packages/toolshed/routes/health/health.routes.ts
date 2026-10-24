import { MAX_DOCUMENT_INTEREST_SESSIONS } from "@commonfabric/memory/v2/server";
import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";
import { z } from "zod";
import { HealthResponseSchema } from "./health.handlers.ts";

const tags = ["Health"];

/** Commits over one window of the memory server's commit rates
 * (packages/memory/v2/commit-rates.ts `CommitWindowCounts`). */
const commitWindowCounts = z.object({
  accepted: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  operations: z.number().int().nonnegative(),
});

/** The fields every recorded session report carries, whatever its event
 * (packages/memory/v2/session-reports.ts `RecordedSessionReport`). */
const sessionReportBase = z.object({
  kind: z.literal("echo-breaker"),
  document: z.object({ id: z.string(), scopeKey: z.string() }),
  action: z.string(),
  at: z.number(),
  space: z.string(),
  session: z.string(),
  principal: z.string().optional(),
});

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
        // The memory server's commit rates over the last minute and ten
        // minutes (packages/memory/v2/commit-rates.ts `CommitRatesReport`)
        // — present whenever a memory server is co-hosted in this process.
        commitRates: z.object({
          storm: z.object({
            commitsPerMinute: z.number().positive(),
            sustainedSeconds: z.number().positive(),
          }),
          activeSpaces: z.number().int().nonnegative(),
          storms: z.number().int().nonnegative(),
          spaces: z.array(
            z.object({
              space: z.string(),
              minute: commitWindowCounts,
              tenMinutes: commitWindowCounts,
              storm: z.object({ since: z.number() }).optional(),
              activeWriters: z.number().int().nonnegative(),
              writers: z.array(
                z.object({
                  session: z.string(),
                  principal: z.string().optional(),
                  minute: commitWindowCounts,
                  tenMinutes: commitWindowCounts,
                }),
              ),
            }),
          ),
        }).optional(),
        // The diagnostics clients reported about their sessions
        // (packages/memory/v2/session-reports.ts `SessionReportsReport`):
        // the remote-echo breaker's trips and clears since the server
        // started, and the most recent reports in full — present whenever a
        // memory server is co-hosted in this process.
        sessionReports: z.object({
          echoBreaker: z.object({
            trips: z.number().int().nonnegative(),
            clears: z.object({
              convergence: z.number().int().nonnegative(),
              quiet: z.number().int().nonnegative(),
              retired: z.number().int().nonnegative(),
              evicted: z.number().int().nonnegative(),
            }),
          }),
          recent: z.array(
            z.discriminatedUnion("event", [
              sessionReportBase.extend({ event: z.literal("trip") }),
              sessionReportBase.extend({
                event: z.literal("clear"),
                reason: z.enum(["convergence", "quiet", "retired", "evicted"]),
                renewals: z.number().int().nonnegative(),
                trippedMs: z.number().int().nonnegative(),
              }),
            ]),
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

/** On-demand attribution of one content-addressed document to retained sessions. */
export const documentInterests = createRoute({
  path: "/api/health/document-interests",
  method: "get",
  tags,
  request: {
    query: z.object({
      space: z.string().min(1).max(1024),
      id: z.string().startsWith("cid:").min(5).max(4096),
      branch: z.string().max(1024).default(""),
      // Bound HTTP input before dispatch; the inspector also guards direct calls.
      limit: z.coerce.number().int().min(1)
        .max(MAX_DOCUMENT_INTEREST_SESSIONS)
        .default(MAX_DOCUMENT_INTEREST_SESSIONS),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        timestamp: z.number(),
        space: z.string(),
        id: z.string(),
        branch: z.string(),
        scope: z.literal("space"),
        totalMatches: z.number().int().nonnegative(),
        truncated: z.boolean(),
        sessions: z.array(z.object({
          sessionId: z.string(),
          principal: z.string().nullable(),
          actingPrincipal: z.string().nullable(),
          connectionId: z.string().nullable(),
          expiresAt: z.number().nullable(),
          expired: z.boolean(),
          watchCount: z.number().int().nonnegative(),
          directWatchCount: z.number().int().nonnegative(),
          cached: z.boolean(),
          graphCount: z.number().int().nonnegative(),
          viewDemandCached: z.boolean(),
          viewDemandGraphCount: z.number().int().nonnegative(),
        })).max(MAX_DOCUMENT_INTEREST_SESSIONS),
      }),
      "Session metadata for one document; no document contents or tokens",
    ),
    [HttpStatusCodes.SERVICE_UNAVAILABLE]: jsonContent(
      z.object({ error: z.string() }),
      "No memory server is registered in this process",
    ),
  },
});

export type IndexRoute = typeof index;
export type StatsRoute = typeof stats;
export type DashRoute = typeof dash;

/** Handler contract for the document-interest diagnostic. */
export type DocumentInterestsRoute = typeof documentInterests;
