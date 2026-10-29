import { cors } from "@hono/hono/cors";

import * as handlers from "./plaid-oauth.handlers.ts";
import * as routes from "./plaid-oauth.routes.ts";
import { createRouter } from "@/lib/create-app.ts";

const router = createRouter()
  .openapi(routes.createLinkToken, handlers.createLinkToken)
  .openapi(routes.exchangeToken, handlers.exchangeToken)
  .openapi(routes.refreshAccounts, handlers.refreshAccounts)
  .openapi(routes.syncTransactions, handlers.syncTransactions)
  .openapi(routes.removeItem, handlers.removeItem);

router.use(
  "/api/integrations/plaid-oauth/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Length", "X-Disk-Cache"],
    maxAge: 3600,
    credentials: true,
  }),
);

export default router;
