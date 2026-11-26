import type {
  AccountBase,
  AccountsGetRequest,
  CountryCode,
  Institution,
  InstitutionsGetByIdRequest,
  Item,
  ItemPublicTokenExchangeRequest,
  ItemPublicTokenExchangeResponse,
  ItemRemoveRequest,
  LinkTokenCreateRequest,
  LinkTokenCreateResponse,
  Transaction,
  TransactionsSyncRequest,
  TransactionsSyncResponse,
} from "plaid";
import type { Runtime } from "@commonfabric/runner";

import { plaidErrorFrom } from "./plaid-oauth.error.ts";
import type {
  CreateLinkTokenRoute,
  ExchangeTokenRoute,
  RefreshAccountsRoute,
  RemoveItemRoute,
  SyncTransactionsRoute,
} from "./plaid-oauth.routes.ts";
import {
  getAuthData,
  getPlaidItem,
  type PlaidItem,
  removePlaidItem,
  upsertPlaidItem,
} from "./plaid-oauth.utils.ts";
import type { AppRouteHandler } from "@/lib/types.ts";

/**
 * The Plaid calls the handlers make, and the part of each answer they read.
 * `PlaidApi` satisfies it.
 */
export interface PlaidClient {
  linkTokenCreate(request: LinkTokenCreateRequest): Promise<{
    data: Pick<LinkTokenCreateResponse, "link_token" | "expiration">;
  }>;
  itemPublicTokenExchange(request: ItemPublicTokenExchangeRequest): Promise<{
    data: Pick<ItemPublicTokenExchangeResponse, "access_token" | "item_id">;
  }>;
  accountsGet(request: AccountsGetRequest): Promise<{
    data: {
      accounts: AccountBase[];
      item: Pick<
        Item,
        "institution_id" | "available_products" | "consent_expiration_time"
      >;
    };
  }>;
  institutionsGetById(request: InstitutionsGetByIdRequest): Promise<{
    data: { institution: Pick<Institution, "institution_id" | "name"> };
  }>;
  transactionsSync(request: TransactionsSyncRequest): Promise<{
    data: Pick<
      TransactionsSyncResponse,
      "added" | "modified" | "removed" | "next_cursor" | "has_more"
    >;
  }>;
  itemRemove(request: ItemRemoveRequest): Promise<unknown>;
}

export interface PlaidHandlerDeps {
  /** The runtime the auth cells are read and written through. */
  runtime: () => Runtime;
  /** The Plaid client a request talks to. */
  client: () => PlaidClient;
  /**
   * Whether a sync keeps fetching batches until Plaid reports no more, rather
   * than stopping after the first batch of each item.
   */
  syncAllTransactions: boolean;
}

const toPlaidAccount = (
  account: AccountBase,
): PlaidItem["accounts"][number] => ({
  accountId: account.account_id,
  name: account.name,
  mask: account.mask || "",
  type: account.type,
  subtype: account.subtype || "",
  balances: {
    available: account.balances.available,
    current: account.balances.current,
    limit: account.balances.limit,
    isoCurrencyCode: account.balances.iso_currency_code,
    unofficialCurrencyCode: account.balances.unofficial_currency_code,
  },
});

const messageOf = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

/** The route handlers of the Plaid integration, over `deps`. */
export function createPlaidHandlers(deps: PlaidHandlerDeps) {
  /**
   * Plaid Create Link Token Handler
   * Creates a Link token for initiating Plaid Link
   */
  const createLinkToken: AppRouteHandler<CreateLinkTokenRoute> = async (c) => {
    const logger = c.get("logger");

    try {
      const payload = await c.req.json();
      logger.info("Received Plaid create link token request");

      if (!payload.authCellId) {
        logger.error("Missing authCellId in request payload");
        return c.json({ error: "Missing authCellId in request" }, 400);
      }

      const response = await deps.client().linkTokenCreate({
        // Any stable string identifies the user to Plaid.
        user: { client_user_id: "commonfabric-user" },
        client_name: "Common Fabric",
        products: payload.products || ["transactions"],
        country_codes: (payload.countryCodes || ["US"]) as CountryCode[],
        language: "en",
      });
      const { link_token, expiration } = response.data;

      logger.info(
        {
          linkToken: link_token.substring(0, 20) + "...",
          expiration,
        },
        "Created Plaid link token",
      );

      return c.json({ linkToken: link_token, expiration }, 200);
    } catch (error) {
      logger.error({ error }, "Failed to create link token");

      const plaidError = plaidErrorFrom(error);
      if (plaidError) {
        return c.json({
          error: plaidError.error_message || "Failed to create link token",
          error_code: plaidError.error_code,
          error_type: plaidError.error_type,
          display_message: plaidError.display_message,
        }, 400);
      }

      return c.json({
        error: messageOf(error, "Failed to create link token"),
      }, 400);
    }
  };

  /**
   * Plaid Exchange Token Handler
   * Exchanges a public token for an access token and stores account data
   */
  const exchangeToken: AppRouteHandler<ExchangeTokenRoute> = async (c) => {
    const logger = c.get("logger");

    try {
      const payload = await c.req.json();
      logger.info("Received Plaid token exchange request");

      if (!payload.publicToken || !payload.authCellId) {
        logger.error("Missing required fields in request payload");
        return c.json(
          { error: "Missing publicToken or authCellId in request" },
          400,
        );
      }

      const plaidClient = deps.client();

      const exchangeResponse = await plaidClient.itemPublicTokenExchange({
        public_token: payload.publicToken,
      });
      const { access_token, item_id } = exchangeResponse.data;

      logger.info(
        { itemId: item_id },
        "Exchanged public token for access token",
      );

      const accountsResponse = await plaidClient.accountsGet({ access_token });
      const { accounts, item } = accountsResponse.data;

      // Use the institution from Link's metadata if provided, otherwise fetch
      // it.
      let institutionId = payload.metadata?.institution?.institutionId;
      let institutionName = payload.metadata?.institution?.name;

      if (!institutionId && item.institution_id) {
        try {
          const institutionResponse = await plaidClient.institutionsGetById({
            institution_id: item.institution_id,
            country_codes: ["US"] as CountryCode[],
          });
          institutionId = institutionResponse.data.institution.institution_id;
          institutionName = institutionResponse.data.institution.name;
        } catch (error) {
          logger.warn(
            { error },
            "Failed to fetch institution details, using defaults",
          );
          institutionId = item.institution_id;
          institutionName = "Unknown Institution";
        }
      }

      await upsertPlaidItem(deps.runtime(), payload.authCellId, {
        accessToken: access_token,
        itemId: item_id,
        institutionId: institutionId || "unknown",
        institutionName: institutionName || "Unknown Institution",
        accounts: accounts.map(toPlaidAccount),
        products: item.available_products || ["accounts", "transactions"],
        consentExpirationTime: item.consent_expiration_time || null,
        lastUpdated: new Date().toISOString(),
        lastSyncCursor: null,
      });

      return c.json(
        {
          success: true,
          message: "Token exchanged successfully",
          itemId: item_id,
        },
        200,
      );
    } catch (error) {
      logger.error({ error }, "Failed to exchange token");
      return c.json(
        { error: messageOf(error, "Failed to exchange token") },
        400,
      );
    }
  };

  /**
   * Plaid Refresh Accounts Handler
   * Refreshes account balances and metadata
   */
  const refreshAccounts: AppRouteHandler<RefreshAccountsRoute> = async (c) => {
    const logger = c.get("logger");

    try {
      const payload = await c.req.json();
      logger.info("Received Plaid refresh accounts request");

      if (!payload.authCellId) {
        logger.error("Missing authCellId in request payload");
        return c.json(
          { success: false, error: "Missing authCellId in request" },
          400,
        );
      }

      const plaidClient = deps.client();
      const runtime = deps.runtime();
      const authData = await getAuthData(runtime, payload.authCellId);
      let updatedItems = 0;

      const itemsToRefresh = payload.itemId
        ? authData.items.filter((item) => item.itemId === payload.itemId)
        : authData.items;

      if (itemsToRefresh.length === 0) {
        logger.warn("No items found to refresh");
        return c.json(
          {
            success: true,
            message: "No items found to refresh",
            updatedItems: 0,
          },
          200,
        );
      }

      for (const item of itemsToRefresh) {
        try {
          const accountsResponse = await plaidClient.accountsGet({
            access_token: item.accessToken,
          });

          await upsertPlaidItem(runtime, payload.authCellId, {
            ...item,
            accounts: accountsResponse.data.accounts.map(toPlaidAccount),
            lastUpdated: new Date().toISOString(),
          });
          updatedItems++;
        } catch (error) {
          // A failure for one item leaves the others to be refreshed.
          logger.error(
            { error, itemId: item.itemId },
            "Failed to refresh accounts for item",
          );
        }
      }

      return c.json(
        {
          success: true,
          message: "Accounts refreshed successfully",
          updatedItems,
        },
        200,
      );
    } catch (error) {
      logger.error({ error }, "Failed to refresh accounts");
      return c.json({
        success: false,
        error: messageOf(error, "Failed to refresh accounts"),
      }, 400);
    }
  };

  /**
   * Plaid Sync Transactions Handler
   * Syncs transactions using the /transactions/sync endpoint
   */
  const syncTransactions: AppRouteHandler<SyncTransactionsRoute> = async (
    c,
  ) => {
    const logger = c.get("logger");

    try {
      const payload = await c.req.json();
      logger.info("Received Plaid sync transactions request");

      if (!payload.authCellId) {
        logger.error("Missing authCellId in request payload");
        return c.json({
          success: false,
          error: "Missing authCellId in request",
        }, 400);
      }

      const plaidClient = deps.client();
      const runtime = deps.runtime();
      const authData = await getAuthData(runtime, payload.authCellId);
      const added: Transaction[] = [];
      const modified: Transaction[] = [];
      const removed: string[] = [];
      let hasMoreOverall = false;

      const itemsToSync = payload.itemId
        ? authData.items.filter((item) => item.itemId === payload.itemId)
        : authData.items;

      if (itemsToSync.length === 0) logger.warn("No items found to sync");

      for (const item of itemsToSync) {
        try {
          let hasMore = true;
          let cursor = item.lastSyncCursor;

          while (hasMore) {
            const syncRequest: TransactionsSyncRequest = {
              access_token: item.accessToken,
              count: payload.count || 500,
            };
            if (cursor) syncRequest.cursor = cursor;

            const { data } = await plaidClient.transactionsSync(syncRequest);
            for (const t of data.added) added.push(t);
            for (const t of data.modified) modified.push(t);
            for (const r of data.removed) removed.push(r.transaction_id);

            cursor = data.next_cursor;
            hasMore = data.has_more;

            if (!deps.syncAllTransactions) break;
          }

          await upsertPlaidItem(runtime, payload.authCellId, {
            ...item,
            lastSyncCursor: cursor,
            lastUpdated: new Date().toISOString(),
          });

          if (hasMore) hasMoreOverall = true;
        } catch (error) {
          // A failure for one item leaves the others to be synced.
          logger.error(
            { error, itemId: item.itemId },
            "Failed to sync transactions for item",
          );
        }
      }

      return c.json({
        success: true,
        message: "Transactions synced successfully",
        added,
        modified,
        removed,
        hasMore: hasMoreOverall,
      }, 200);
    } catch (error) {
      logger.error({ error }, "Failed to sync transactions");
      return c.json({
        success: false,
        error: messageOf(error, "Failed to sync transactions"),
      }, 400);
    }
  };

  /**
   * Plaid Remove Item Handler
   * Removes a connected bank account
   */
  const removeItem: AppRouteHandler<RemoveItemRoute> = async (c) => {
    const logger = c.get("logger");

    try {
      const payload = await c.req.json();
      logger.info("Received Plaid remove item request");

      if (!payload.authCellId || !payload.itemId) {
        logger.error("Missing required fields in request payload");
        return c.json({
          success: false,
          error: "Missing authCellId or itemId in request",
        }, 400);
      }

      const runtime = deps.runtime();
      const item = await getPlaidItem(
        runtime,
        payload.authCellId,
        payload.itemId,
      );
      if (!item) {
        logger.warn({ itemId: payload.itemId }, "Item not found");
        return c.json({ success: false, error: "Item not found" }, 400);
      }

      // A failure to revoke the item at Plaid still removes it locally.
      try {
        await deps.client().itemRemove({ access_token: item.accessToken });
      } catch (error) {
        logger.error(
          { error, itemId: payload.itemId },
          "Failed to remove item from Plaid, continuing with local removal",
        );
      }

      await removePlaidItem(runtime, payload.authCellId, payload.itemId);

      return c.json(
        { success: true, message: "Item removed successfully" },
        200,
      );
    } catch (error) {
      logger.error({ error }, "Failed to remove item");
      return c.json({
        success: false,
        error: messageOf(error, "Failed to remove item"),
      }, 400);
    }
  };

  return {
    createLinkToken,
    exchangeToken,
    refreshAccounts,
    syncTransactions,
    removeItem,
  };
}
