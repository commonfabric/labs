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

import type { AppRouteHandler } from "@/lib/types.ts";
import { runtime } from "@/index.ts";
import {
  type IngestLogger,
  type IngestResult,
  processIngest,
} from "./ingest.utils.ts";
import type { IngestByIdRoute, IngestRoute } from "./ingest.routes.ts";
import { ingestServiceSpace } from "./service-space.ts";

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
    runtime,
    ingestServiceSpace,
    id,
    token,
    rawBody,
    logger,
    addressedSpace,
  );
};

/** Handles a write addressed through the space the channel writes into. */
export const ingest: AppRouteHandler<IngestRoute> = async (c) => {
  const { space, id } = c.req.valid("param");
  const result = await append(c.req, c.get("logger"), id, space);
  if (result === null) return c.json({ error: "Invalid request" }, 401);
  if (result.status === 200) return c.json(result.body, 200);
  return c.json(result.body, result.status);
};

/** Handles a write addressed by channel id alone. */
export const ingestById: AppRouteHandler<IngestByIdRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const result = await append(c.req, c.get("logger"), id);
  if (result === null) return c.json({ error: "Invalid request" }, 401);
  if (result.status === 200) return c.json(result.body, 200);
  return c.json(result.body, result.status);
};
