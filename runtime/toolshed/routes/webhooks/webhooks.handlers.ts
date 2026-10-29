/**
 * Design spec: docs/specs/webhook-ingress/README.md
 *
 * Auth note: The list and create endpoints are intentionally unauthed,
 * consistent with all other toolshed admin endpoints (google-oauth, plaid,
 * patterns, etc.). When the platform adds HTTP-level auth
 * infrastructure, these endpoints should adopt it.
 */

import env from "@/env.ts";
import type { AppRouteHandler } from "@/lib/types.ts";
import type {
  CreateRoute,
  IngestRoute,
  ListRoute,
  RemoveRoute,
} from "./webhooks.routes.ts";
import {
  addToServiceIndex,
  deleteRegistration,
  extractSpaceFromCellLink,
  generateWebhookId,
  generateWebhookSecret,
  getRegistration,
  getServiceIndex,
  removeFromServiceIndex,
  saveRegistration,
  sendToStream,
  verifyWebhookSecret,
  writeConfidentialConfig,
} from "./webhooks.utils.ts";

const DUMMY_HASH = "0".repeat(64);

export const create: AppRouteHandler<CreateRoute> = async (c) => {
  const logger = c.get("logger");

  try {
    const {
      name,
      cellLink,
      confidentialCellLink,
    } = c.req.valid("json");

    // Validate cellLink format and extract space
    let space: string;
    try {
      space = extractSpaceFromCellLink(cellLink);
    } catch {
      return c.json({ error: "Invalid cellLink format" }, 400);
    }

    // Validate confidentialCellLink format
    try {
      extractSpaceFromCellLink(confidentialCellLink);
    } catch {
      return c.json({ error: "Invalid confidentialCellLink format" }, 400);
    }

    const id = generateWebhookId();
    const { secret, hashPromise } = generateWebhookSecret();
    const secretHash = await hashPromise;

    // Write URL+secret to the pattern's config cell FIRST.
    // If this fails, no registration is persisted (no orphaned webhook).
    const url = `${env.API_URL}/api/webhooks/${id}`;
    await writeConfidentialConfig(confidentialCellLink, url, secret);

    const registration = {
      id,
      name,
      cellLink,
      secretHash,
      createdBy: space,
      createdAt: new Date().toISOString(),
      enabled: true,
    };

    // Store registration in toolshed's service space
    await saveRegistration(registration);

    // Update the per-space index. If this fails the webhook is functional
    // (config written, registration stored) — just not discoverable via list.
    try {
      await addToServiceIndex(space, id);
    } catch (indexError) {
      logger.warn(
        { id, space, error: indexError },
        "Webhook created but failed to update service index",
      );
    }

    logger.info({ id, name, space }, "Webhook created");

    return c.json({ id, name }, 200);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    logger.error({ error: msg, stack }, "Failed to create webhook");
    return c.json({ error: "Failed to create webhook" }, 500);
  }
};

export const ingest: AppRouteHandler<IngestRoute> = async (c) => {
  const logger = c.get("logger");
  const { id } = c.req.param();

  // Extract bearer token FIRST (before any storage lookup)
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Invalid request" }, 401);
  }
  const token = authHeader.slice(7);

  // Look up registration from shared storage.
  // Storage errors must not be swallowed — they should 502, not masquerade as 401.
  let registration: Awaited<ReturnType<typeof getRegistration>>;
  try {
    registration = await getRegistration(id);
  } catch (error) {
    logger.error(
      { error, id },
      "Storage error looking up webhook registration",
    );
    return c.json({ error: "Failed to process webhook" }, 502);
  }

  if (!registration || !registration.enabled) {
    // Match the real verification path to prevent timing oracle on missing webhooks
    await verifyWebhookSecret(token, DUMMY_HASH);
    return c.json({ error: "Invalid request" }, 401);
  }

  // Verify bearer token
  const valid = await verifyWebhookSecret(token, registration.secretHash);
  if (!valid) {
    return c.json({ error: "Invalid request" }, 401);
  }

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON payload" }, 400);
  }

  try {
    await sendToStream(registration.cellLink, payload);
    logger.info({ id }, "Webhook payload received");
    return c.json({ received: true }, 200);
  } catch (error) {
    logger.error({ error, id }, "Failed to write webhook payload to cell");
    return c.json({ error: "Failed to write payload" }, 502);
  }
};

export const list: AppRouteHandler<ListRoute> = async (c) => {
  const logger = c.get("logger");
  const space = c.req.query("space");

  if (!space) {
    return c.json({ error: "Missing required query parameter: space" }, 400);
  }

  try {
    // Read per-space index to get webhook IDs
    const webhookIds = await getServiceIndex(space);

    // Fetch each registration and strip secretHash
    const registrations = await Promise.all(
      webhookIds.map((webhookId) => getRegistration(webhookId)),
    );
    const webhooks = registrations
      .filter((reg): reg is NonNullable<typeof reg> => reg !== null)
      .map(({ secretHash: _, ...rest }) => rest);

    return c.json({ webhooks }, 200);
  } catch (error) {
    logger.error({ error }, "Failed to list webhooks");
    return c.json({ error: "Failed to list webhooks" }, 500);
  }
};

export const remove: AppRouteHandler<RemoveRoute> = async (c) => {
  const logger = c.get("logger");
  const { id } = c.req.param();
  const space = c.req.query("space");

  if (!space) {
    return c.json({ error: "Missing required query parameter: space" }, 400);
  }

  try {
    const registration = await getRegistration(id);

    if (!registration) {
      return c.json({ error: "Webhook not found" }, 404);
    }

    // Soft ownership check: `space` is caller-provided, not cryptographically
    // verified. Sufficient for now since all admin endpoints are unauthed;
    // will be replaced by DID-based auth when platform adds it.
    if (registration.createdBy !== space) {
      return c.json({ error: "Webhook not found" }, 404);
    }

    // Deactivate the webhook first so it can't accept payloads,
    // then clean up the index. A ghost index entry is harmless;
    // a ghost active webhook is not.
    await deleteRegistration(id);

    // Try to clean up the service index, but don't fail if cellLink is corrupted
    try {
      const indexSpace = extractSpaceFromCellLink(registration.cellLink);
      await removeFromServiceIndex(indexSpace, id);
    } catch {
      logger.warn(
        { id },
        "Could not derive space from cellLink; index entry may be orphaned",
      );
    }

    logger.info({ id }, "Webhook deleted");

    return c.json({ deleted: true }, 200);
  } catch (error) {
    logger.error({ error, id }, "Failed to delete webhook");
    return c.json({ error: "Failed to delete webhook" }, 500);
  }
};
