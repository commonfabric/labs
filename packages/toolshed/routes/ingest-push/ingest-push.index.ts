/**
 * The router for push deliveries into ingest channels. Mounted on every
 * deployment, and answering 404 to every request on one where Gmail push is
 * not configured.
 */

import { bodyLimit } from "@hono/hono/body-limit";

import * as handlers from "./ingest-push.handlers.ts";
import * as routes from "./ingest-push.routes.ts";
import { gmailPushEnabled } from "./gmail-push.config.ts";
import { createRouter } from "@/lib/create-app.ts";
import { ingestGate } from "@/routes/ingest-channels/gate.ts";

const router = createRouter();

// First, so nothing downstream runs for a deployment that has not configured
// Gmail push.
router.use(`${routes.BASE}/*`, ingestGate(gmailPushEnabled));

// Ahead of token verification, so an unauthenticated caller cannot make the
// handler buffer an arbitrary body. A Pub/Sub envelope around a Gmail
// notification is a few hundred bytes.
router.use(
  `${routes.BASE}/*`,
  bodyLimit({
    maxSize: 16_384,
    onError: (c) => c.json({ error: "Payload too large" }, 413),
  }),
);

export default router.openapi(routes.gmail, handlers.gmail);
