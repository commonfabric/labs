import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";

const tags = ["Plaid OAuth Integration"];

export const createLinkToken = createRoute({
  path: "/api/integrations/plaid-oauth/create-link-token",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              authCellId: z.string().describe("The authentication cell ID"),
              products: z
                .array(z.string())
                .optional()
                .default(["accounts", "transactions"])
                .describe("Plaid products to request access to"),
              countryCodes: z
                .array(z.string())
                .optional()
                .default(["US"])
                .describe("Country codes for institutions"),
              frontendUrl: z
                .string()
                .optional()
                .describe("Frontend URL for Link SDK integration"),
            })
            .openapi({
              example: {
                authCellId: "auth-cell-123",
                products: ["accounts", "transactions"],
                countryCodes: ["US"],
              },
            }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: z.object({
            linkToken: z.string().describe("The Plaid Link token"),
            expiration: z.string().describe("Token expiration timestamp"),
          }),
        },
      },
      description: "Link token created successfully",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
      description: "Invalid request parameters",
    },
  },
});

export const exchangeToken = createRoute({
  path: "/api/integrations/plaid-oauth/exchange-token",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              publicToken: z.string().describe("The Plaid public token"),
              authCellId: z.string().describe("The authentication cell ID"),
              metadata: z
                .object({
                  institution: z.object({
                    institutionId: z.string(),
                    name: z.string(),
                  }),
                  accounts: z.array(
                    z.object({
                      id: z.string(),
                      name: z.string(),
                      mask: z.string().nullable(),
                      type: z.string(),
                      subtype: z.string().nullable(),
                    }),
                  ),
                })
                .optional()
                .describe("Metadata from Plaid Link"),
            })
            .openapi({
              example: {
                publicToken: "public-sandbox-xxx",
                authCellId: "auth-cell-123",
                metadata: {
                  institution: {
                    institutionId: "ins_109508",
                    name: "Chase",
                  },
                  accounts: [
                    {
                      id: "acc_123",
                      name: "Checking",
                      mask: "0000",
                      type: "depository",
                      subtype: "checking",
                    },
                  ],
                },
              },
            }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            message: z.string(),
            itemId: z.string().describe("The Plaid Item ID"),
          }),
        },
      },
      description: "Token exchanged successfully",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
      description: "Invalid request parameters",
    },
  },
});

export const refreshAccounts = createRoute({
  path: "/api/integrations/plaid-oauth/refresh-accounts",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              authCellId: z.string().describe("The authentication cell ID"),
              itemId: z
                .string()
                .optional()
                .describe("Specific item to refresh (optional)"),
            })
            .openapi({
              example: {
                authCellId: "auth-cell-123",
                itemId: "item-123",
              },
            }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            message: z.string(),
            updatedItems: z.number().describe("Number of items updated"),
          }),
        },
      },
      description: "Accounts refreshed successfully",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
      description: "Invalid request parameters",
    },
  },
});

export const syncTransactions = createRoute({
  path: "/api/integrations/plaid-oauth/sync-transactions",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              authCellId: z.string().describe("The authentication cell ID"),
              itemId: z
                .string()
                .optional()
                .describe("Specific item to sync (optional)"),
              count: z
                .number()
                .optional()
                .default(500)
                .describe("Number of transactions to fetch per request"),
            })
            .openapi({
              example: {
                authCellId: "auth-cell-123",
                itemId: "item-123",
                count: 500,
              },
            }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            message: z.string(),
            added: z.number().describe("Number of transactions added"),
            modified: z.number().describe("Number of transactions modified"),
            removed: z.number().describe("Number of transactions removed"),
            hasMore: z.boolean().describe(
              "Whether more transactions are available",
            ),
          }),
        },
      },
      description: "Transactions synced successfully",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
      description: "Invalid request parameters",
    },
  },
});

export const removeItem = createRoute({
  path: "/api/integrations/plaid-oauth/remove-item",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              authCellId: z.string().describe("The authentication cell ID"),
              itemId: z.string().describe("The Plaid Item ID to remove"),
            })
            .openapi({
              example: {
                authCellId: "auth-cell-123",
                itemId: "item-123",
              },
            }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            message: z.string(),
          }),
        },
      },
      description: "Item removed successfully",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
      description: "Invalid request parameters",
    },
  },
});

export type CreateLinkTokenRoute = typeof createLinkToken;
export type ExchangeTokenRoute = typeof exchangeToken;
export type RefreshAccountsRoute = typeof refreshAccounts;
export type SyncTransactionsRoute = typeof syncTransactions;
export type RemoveItemRoute = typeof removeItem;
