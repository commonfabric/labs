/**
 * The device-channel ingest handler — a thin transport wrapper. It pulls the
 * bearer token and JSON body off the request, then delegates to processIngest
 * (ingest.utils.ts), whose full auth + validation contract is unit-tested
 * against a real runtime. Auth mirrors the webhook ingest path.
 *
 * This is the DATA plane only. Channel lifecycle lives under the
 * `ingest-channels` path segment (separate prefixes, separate auth model),
 * where the confused-deputy risk of a create that names someone else's space
 * is closed by requiring an explicit OWNER grant on that space's ACL. See
 * docs/features/self-serve-ingest-channels.md.
 */

import { bodyLimit } from "@hono/hono/body-limit";
import { cors } from "@hono/hono/cors";
import type { Runtime } from "@commonfabric/runner";
import { createRouter } from "@/lib/create-app.ts";
import type { AppRouteHandler } from "@/lib/types.ts";
import {
  type IngestLogger,
  type IngestResult,
  processIngest,
} from "./ingest.utils.ts";
import * as routes from "./ingest.routes.ts";

/** What the ingest handlers reach outside the request. */
export interface IngestHandlerDeps {
  /**
   * The runtime that holds the registry and the journals. A function, because
   * the server assigns its runtime after the module graph loads.
   */
  runtime: () => Runtime;

  /** The space holding the channel registry. */
  serviceSpace: string;
}

/** The parts of a request the append reads. */
interface IngestRequest {
  /** Returns the named request header, if the request carries it. */
  header: (name: string) => string | undefined;

  /** Returns the request body as text. */
  text: () => Promise<string>;
}

/**
 * Helper for both handlers, which pulls the token and body off `request` and
 * appends to channel `id`. `addressedSpace` is the space the path named, if it
 * named one. Returns `null` for a request with no bearer token.
 */
const append = async (
  deps: IngestHandlerDeps,
  request: IngestRequest,
  logger: IngestLogger,
  id: string,
  addressedSpace?: string,
): Promise<IngestResult | null> => {
  // Extract the bearer token FIRST, before any storage lookup.
  const authHeader = request.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);

  // Read the raw body but DON'T parse here — processIngest parses only after it
  // has verified the token, so a bad token can't be distinguished by body
  // validity (uniform 401 for bad/unknown/disabled/wrong-kind).
  const rawBody = await request.text();

  return await processIngest(
    deps.runtime(),
    deps.serviceSpace,
    id,
    token,
    rawBody,
    logger,
    addressedSpace,
  );
};

/** The ingest route handlers, over `deps`. */
export function createIngestHandlers(deps: IngestHandlerDeps) {
  /** Handles a write addressed through the space the channel writes into. */
  const ingest: AppRouteHandler<routes.IngestRoute> = async (c) => {
    const { space, id } = c.req.valid("param");
    const result = await append(deps, c.req, c.get("logger"), id, space);
    if (result === null) return c.json({ error: "Invalid request" }, 401);
    if (result.status === 200) return c.json(result.body, 200);
    return c.json(result.body, result.status);
  };

  /** Handles a write addressed by channel id alone. */
  const ingestById: AppRouteHandler<routes.IngestByIdRoute> = async (c) => {
    const { id } = c.req.valid("param");
    const result = await append(deps, c.req, c.get("logger"), id);
    if (result === null) return c.json({ error: "Invalid request" }, 401);
    if (result.status === 200) return c.json(result.body, 200);
    return c.json(result.body, result.status);
  };

  return { ingest, ingestById };
}

/** The ingest data-plane router, over `deps`. */
export function createIngestRouter(deps: IngestHandlerDeps) {
  const handlers = createIngestHandlers(deps);
  const router = createRouter();

  // The data plane answers at two prefixes: with the channel's space in the
  // path, which is the form mint and rotate hand out, and by channel id alone.
  for (const prefix of ["/api/spaces/:space/ingest/*", "/api/ingest/*"]) {
    router.use(
      prefix,
      bodyLimit({
        maxSize: 1_000_000,
        onError: (c) => c.json({ error: "Payload too large (max 1MB)" }, 413),
      }),
    );

    router.use(
      prefix,
      cors({
        origin: "*",
        allowMethods: ["POST", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
        exposeHeaders: ["Content-Length"],
        maxAge: 3600,
      }),
    );
  }

  return router
    .openapi(routes.ingest, handlers.ingest)
    .openapi(routes.ingestById, handlers.ingestById);
}
