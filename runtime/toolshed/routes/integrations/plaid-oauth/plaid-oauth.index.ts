import { createPlaidRouter } from "./plaid-oauth.router.ts";
import { createPlaidClient } from "./plaid-oauth.utils.ts";
import env from "@/env.ts";
import { runtime } from "@/index.ts";

export default createPlaidRouter({
  runtime: () => runtime,
  client: () => createPlaidClient(),
  syncAllTransactions: env.PLAID_SYNC_ALL_TRANSACTIONS,
});
