import {
  CountryCode,
  LinkTokenCreateRequest,
  Transaction,
  TransactionsSyncRequest,
} from "plaid";

import { plaidErrorFrom } from "./plaid-oauth.error.ts";
import type {
  CreateLinkTokenRoute,
  ExchangeTokenRoute,
  RefreshAccountsRoute,
  RemoveItemRoute,
  SyncTransactionsRoute,
} from "./plaid-oauth.routes.ts";
import {
  createPlaidClient,
  getAuthData,
  getPlaidItem,
  type PlaidItem,
  removePlaidItem,
  upsertPlaidItem,
} from "./plaid-oauth.utils.ts";
import env from "@/env.ts";
import type { AppRouteHandler } from "@/lib/types.ts";

/**
 * Plaid Create Link Token Handler
 * Creates a Link token for initiating Plaid Link
 */
export const createLinkToken: AppRouteHandler<CreateLinkTokenRoute> = async (
  c,
) => {
  const logger = c.get("logger");

  try {
    const payload = await c.req.json();
    logger.info("Received Plaid create link token request");

    if (!payload.authCellId) {
      logger.error("Missing authCellId in request payload");
      return c.json({ error: "Missing authCellId in request" }, 400);
    }

    const plaidClient = createPlaidClient();

    // Create a user ID for Plaid (can be any stable string)
    const userId = "commonfabric-user";

    // Create link token request
    const linkTokenRequest: LinkTokenCreateRequest = {
      user: {
        client_user_id: userId,
      },
      client_name: "Common Fabric",
      products: payload.products || ["transactions"],
      country_codes: (payload.countryCodes || ["US"]) as CountryCode[],
      language: "en",
    };

    const response = await plaidClient.linkTokenCreate(linkTokenRequest);
    const { link_token, expiration } = response.data;

    logger.info(
      {
        linkToken: link_token.substring(0, 20) + "...",
        expiration,
      },
      "Created Plaid link token",
    );

    return c.json({
      linkToken: link_token,
      expiration,
    });
  } catch (error) {
    logger.error({ error }, "Failed to create link token");

    // Extract Plaid error details if available
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
      error: error instanceof Error
        ? error.message
        : "Failed to create link token",
    }, 400) as any;
  }
};

/**
 * Plaid Exchange Token Handler
 * Exchanges a public token for an access token and stores account data
 */
export const exchangeToken: AppRouteHandler<ExchangeTokenRoute> = async (c) => {
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

    const plaidClient = createPlaidClient();

    // Exchange public token for access token
    const exchangeResponse = await plaidClient.itemPublicTokenExchange({
      public_token: payload.publicToken,
    });

    const { access_token, item_id } = exchangeResponse.data;

    logger.info({ itemId: item_id }, "Exchanged public token for access token");

    // Fetch account details
    const accountsResponse = await plaidClient.accountsGet({
      access_token,
    });

    const { accounts, item } = accountsResponse.data;

    // Get institution details (use metadata if provided, otherwise fetch)
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
        institutionId = item.institution_id || "unknown";
        institutionName = "Unknown Institution";
      }
    }

    // Prepare item data for storage
    const plaidItem: PlaidItem = {
      accessToken: access_token,
      itemId: item_id,
      institutionId: institutionId || "unknown",
      institutionName: institutionName || "Unknown Institution",
      accounts: accounts.map((account) => ({
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
      })),
      products: item.available_products || ["accounts", "transactions"],
      consentExpirationTime: item.consent_expiration_time || null,
      lastUpdated: new Date().toISOString(),
      lastSyncCursor: null,
    };

    // Save to auth cell
    await upsertPlaidItem(payload.authCellId, plaidItem);

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
    return c.json({
      error: error instanceof Error
        ? error.message
        : "Failed to exchange token",
    }, 400);
  }
};

/**
 * Plaid Refresh Accounts Handler
 * Refreshes account balances and metadata
 */
export const refreshAccounts: AppRouteHandler<RefreshAccountsRoute> = async (
  c,
) => {
  const logger = c.get("logger");

  try {
    const payload = await c.req.json();
    logger.info("Received Plaid refresh accounts request");

    if (!payload.authCellId) {
      logger.error("Missing authCellId in request payload");
      return c.json(
        { success: false, error: "Missing authCellId in request" },
        400,
      ) as any;
    }

    const plaidClient = createPlaidClient();
    const authData = await getAuthData(payload.authCellId);
    let updatedItems = 0;

    // Filter items to refresh
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

    // Refresh each item
    for (const item of itemsToRefresh) {
      try {
        const accountsResponse = await plaidClient.accountsGet({
          access_token: item.accessToken,
        });

        const { accounts } = accountsResponse.data;

        // Update item with fresh account data
        const updatedItem: PlaidItem = {
          accessToken: item.accessToken,
          itemId: item.itemId,
          institutionId: item.institutionId,
          institutionName: item.institutionName,
          accounts: accounts.map((account) => ({
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
          })),
          products: item.products,
          consentExpirationTime: item.consentExpirationTime,
          lastUpdated: new Date().toISOString(),
          lastSyncCursor: item.lastSyncCursor,
        };

        await upsertPlaidItem(payload.authCellId, updatedItem);
        updatedItems++;
      } catch (error) {
        logger.error(
          { error, itemId: item.itemId },
          "Failed to refresh accounts for item",
        );
        // Continue with other items even if one fails
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
      error: error instanceof Error
        ? error.message
        : "Failed to refresh accounts",
    }, 400);
  }
};

/**
 * Plaid Sync Transactions Handler
 * Syncs transactions using the /transactions/sync endpoint
 */
export const syncTransactions: AppRouteHandler<SyncTransactionsRoute> = async (
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

    const plaidClient = createPlaidClient();
    const authData = await getAuthData(payload.authCellId);
    const allAddedTransactions: Transaction[] = [];
    const allModifiedTransactions: Transaction[] = [];
    const allRemovedIds: string[] = [];
    let hasMoreOverall = false;

    // Filter items to sync
    const itemsToSync = payload.itemId
      ? authData.items.filter((item) => item.itemId === payload.itemId)
      : authData.items;

    if (itemsToSync.length === 0) {
      logger.warn("No items found to sync");
      return c.json(
        {
          success: true,
          message: "Transactions synced successfully",
          added: 0,
          modified: 0,
          removed: 0,
          hasMore: false,
        },
        200,
      ) as any;
    }

    // Sync transactions for each item
    for (const item of itemsToSync) {
      try {
        let hasMore = true;
        let cursor = item.lastSyncCursor;

        // Continue syncing until no more updates
        while (hasMore) {
          const syncRequest: TransactionsSyncRequest = {
            access_token: item.accessToken,
            count: payload.count || 500,
          };

          if (cursor) {
            syncRequest.cursor = cursor;
          }

          const syncResponse = await plaidClient.transactionsSync(syncRequest);
          const {
            added,
            modified,
            removed,
            next_cursor,
            has_more,
          } = syncResponse.data;

          // Collect the actual transaction data
          allAddedTransactions.push(...added);
          allModifiedTransactions.push(...modified);
          allRemovedIds.push(...removed.map((r) => r.transaction_id));

          cursor = next_cursor;
          hasMore = has_more;

          // Break after one batch if we're not syncing everything
          if (!env.PLAID_SYNC_ALL_TRANSACTIONS) {
            break;
          }
        }

        // Update the item's sync cursor
        const updatedItem: PlaidItem = {
          accessToken: item.accessToken,
          itemId: item.itemId,
          institutionId: item.institutionId,
          institutionName: item.institutionName,
          accounts: item.accounts as PlaidItem["accounts"],
          products: item.products,
          consentExpirationTime: item.consentExpirationTime,
          lastSyncCursor: cursor,
          lastUpdated: new Date().toISOString(),
        };

        await upsertPlaidItem(payload.authCellId, updatedItem);

        if (hasMore) hasMoreOverall = true;
      } catch (error) {
        logger.error(
          { error, itemId: item.itemId },
          "Failed to sync transactions for item",
        );
        // Continue with other items even if one fails
      }
    }

    // Return the actual transaction data
    return c.json({
      success: true,
      message: "Transactions synced successfully",
      added: allAddedTransactions,
      modified: allModifiedTransactions,
      removed: allRemovedIds,
      hasMore: hasMoreOverall,
    }, 200);
  } catch (error) {
    logger.error({ error }, "Failed to sync transactions");
    return c.json({
      success: false,
      error: error instanceof Error
        ? error.message
        : "Failed to sync transactions",
    }, 400);
  }
};

/**
 * Plaid Remove Item Handler
 * Removes a connected bank account
 */
export const removeItem: AppRouteHandler<RemoveItemRoute> = async (c) => {
  const logger = c.get("logger");

  try {
    const payload = await c.req.json();
    logger.info("Received Plaid remove item request");

    if (!payload.authCellId || !payload.itemId) {
      logger.error("Missing required fields in request payload");
      return c.json({
        success: false,
        error: "Missing authCellId or itemId in request",
      }, 400) as any;
    }

    const plaidClient = createPlaidClient();

    // Get the item to remove
    const item = await getPlaidItem(payload.authCellId, payload.itemId);
    if (!item) {
      logger.warn({ itemId: payload.itemId }, "Item not found");
      return c.json({
        success: false,
        error: "Item not found",
      }, 400) as any;
    }

    // Remove from Plaid
    try {
      await plaidClient.itemRemove({
        access_token: item.accessToken,
      });
    } catch (error) {
      logger.error(
        { error, itemId: payload.itemId },
        "Failed to remove item from Plaid, continuing with local removal",
      );
    }

    // Remove from auth cell
    await removePlaidItem(payload.authCellId, payload.itemId);

    return c.json(
      {
        success: true,
        message: "Item removed successfully",
      },
      200,
    );
  } catch (error) {
    logger.error({ error }, "Failed to remove item");
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to remove item",
    }, 400) as any;
  }
};
