import type {
  JSONSchema,
  Mutable,
  Runtime,
  Schema,
} from "@commonfabric/runner";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

import env from "@/env.ts";
import {
  custodyIngest,
  durableUpdate,
  type VouchedChannel,
} from "@/lib/custody-ingest.ts";
import { getAuthCell } from "@/routes/integrations/oauth2-common/oauth2-common.utils.ts";

// Plaid Auth Schema
export const PlaidAuthSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          accessToken: {
            type: "string",
            ifc: { confidentiality: ["secret"] },
          },
          itemId: { type: "string" },
          institutionId: { type: "string" },
          institutionName: { type: "string" },
          accounts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                accountId: { type: "string" },
                name: { type: "string" },
                mask: { type: "string" },
                type: { type: "string" },
                subtype: { type: "string" },
                balances: {
                  type: "object",
                  properties: {
                    available: { type: ["number", "null"] },
                    current: { type: ["number", "null"] },
                    limit: { type: ["number", "null"] },
                    isoCurrencyCode: { type: ["string", "null"] },
                    unofficialCurrencyCode: { type: ["string", "null"] },
                  },
                },
              },
            },
          },
          products: {
            type: "array",
            items: { type: "string" },
          },
          consentExpirationTime: { type: ["string", "null"] },
          lastUpdated: { type: "string" },
          lastSyncCursor: { type: ["string", "null"] },
        },
        required: [
          "accessToken",
          "itemId",
          "institutionId",
          "institutionName",
          "accounts",
          "products",
          "lastUpdated",
        ],
      },
      default: [],
    },
  },
  required: ["items"],
} as const satisfies JSONSchema;

//
// Types
//

export type PlaidAuthData = Mutable<Schema<typeof PlaidAuthSchema>>;

export type PlaidItem = PlaidAuthData["items"][number];

/** The settings a Plaid client is built from. */
export type PlaidSettings = Pick<
  typeof env,
  "PLAID_ENV" | "PLAID_CLIENT_ID" | "PLAID_SECRET"
>;

/** The client configuration for the environment and credentials given. */
export const plaidConfiguration = (settings: PlaidSettings): Configuration =>
  new Configuration({
    basePath: PlaidEnvironments[settings.PLAID_ENV],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": settings.PLAID_CLIENT_ID,
        "PLAID-SECRET": settings.PLAID_SECRET,
      },
    },
  });

/** A Plaid client for the configured environment and credentials. */
export const createPlaidClient = (settings: PlaidSettings = env): PlaidApi =>
  new PlaidApi(plaidConfiguration(settings));

// Get auth data from the auth cell
export async function getAuthData(
  runtime: Runtime,
  authCellDocLink: string,
): Promise<PlaidAuthData> {
  try {
    const authCell = await getAuthCell(
      runtime,
      authCellDocLink,
      PlaidAuthSchema,
    );
    return (authCell.get() as PlaidAuthData | null) ?? { items: [] };
  } catch (error) {
    throw new Error(`Error getting auth data: ${error}`);
  }
}

// Build the vouched-ingest channel for a Plaid auth cell. As with OAuth,
// channel/audience are recorded-not-enforced provenance: pre-grant-infra the
// channel is the cell's own space and audience records the Plaid source.
function plaidIngestChannel(
  authCell: Awaited<ReturnType<typeof getAuthCell>>,
): VouchedChannel {
  return {
    channel: authCell.getAsNormalizedFullLink().space,
    audience: "did:web:commonfabric.org#plaid",
  };
}

// Add or update an item in the auth data. The read-merge-write runs inside the
// retrying custody transaction, so concurrent item updates re-read the current
// value on each retry and do not overwrite each other with a stale snapshot. A
// new or updated item is Plaid data arriving from the provider, so it mints the
// ExternalIngest mark.
export async function upsertPlaidItem(
  runtime: Runtime,
  authCellDocLink: string,
  item: PlaidItem,
): Promise<void> {
  const authCell = await getAuthCell(runtime, authCellDocLink, PlaidAuthSchema);
  await custodyIngest.update(
    authCell,
    (current) => {
      const data = (current as PlaidAuthData | undefined) ?? { items: [] };
      const items = data.items ? [...data.items] : [];
      const idx = items.findIndex((i) => i.itemId === item.itemId);
      if (idx >= 0) items[idx] = item;
      else items.push(item);
      return { ...data, items };
    },
    plaidIngestChannel(authCell),
  );
}

// Remove an item from the auth data. Removal is an operator action, not ingest,
// so it uses the governed read-modify-write with no mark, still atomic
// (re-reads inside the retry) so it does not clobber a concurrent upsert.
export async function removePlaidItem(
  runtime: Runtime,
  authCellDocLink: string,
  itemId: string,
): Promise<void> {
  const authCell = await getAuthCell(runtime, authCellDocLink, PlaidAuthSchema);
  await durableUpdate(authCell, (current) => {
    const data = (current as PlaidAuthData | undefined) ?? { items: [] };
    return {
      ...data,
      items: (data.items ?? []).filter((i) => i.itemId !== itemId),
    };
  });
}

// Get a specific item from auth data
export async function getPlaidItem(
  runtime: Runtime,
  authCellDocLink: string,
  itemId: string,
): Promise<PlaidItem | null> {
  try {
    const authData = await getAuthData(runtime, authCellDocLink);
    return authData.items?.find((i) => i.itemId === itemId) ?? null;
  } catch (error) {
    throw new Error(`Error getting Plaid item: ${error}`);
  }
}
