import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  type AccountBase,
  AccountSubtype,
  AccountType,
  PlaidApi,
  Products,
  type Transaction,
  TransactionPaymentChannelEnum,
  type TransactionsSyncRequest,
} from "plaid";
import { createTestApp } from "@/lib/create-app.ts";
import type { PlaidClient } from "./plaid-oauth.handlers.ts";
import { createPlaidRouter } from "./plaid-oauth.router.ts";
import {
  createPlaidClient,
  PlaidAuthSchema,
  plaidConfiguration,
  type PlaidItem,
  upsertPlaidItem,
} from "./plaid-oauth.utils.ts";

const BASE = "/api/integrations/plaid-oauth";
const AUTH_CAUSE = "plaid-auth";

const account = (
  id: string,
  overrides: Partial<AccountBase> = {},
): AccountBase => ({
  account_id: id,
  name: `Account ${id}`,
  official_name: null,
  mask: "1234",
  type: AccountType.Depository,
  subtype: AccountSubtype.Checking,
  balances: {
    available: 100,
    current: 110,
    limit: null,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
  },
  ...overrides,
});

const transaction = (id: string): Transaction => ({
  transaction_id: id,
  account_id: "acc-1",
  amount: 12.5,
  iso_currency_code: "USD",
  unofficial_currency_code: null,
  date: "2026-11-01",
  name: `Purchase ${id}`,
  location: {
    address: null,
    city: null,
    region: null,
    postal_code: null,
    country: null,
    lat: null,
    lon: null,
    store_number: null,
  },
  payment_meta: {
    reference_number: null,
    ppd_id: null,
    payee: null,
    by_order_of: null,
    payer: null,
    payment_method: null,
    payment_processor: null,
    reason: null,
  },
  pending: false,
  pending_transaction_id: null,
  account_owner: null,
  authorized_date: null,
  authorized_datetime: null,
  datetime: null,
  payment_channel: TransactionPaymentChannelEnum.Online,
  transaction_code: null,
});

const storedAccount = {
  accountId: "acc-old",
  name: "Old account",
  mask: "9999",
  type: "depository",
  subtype: "savings",
  balances: {
    available: 1,
    current: 1,
    limit: null,
    isoCurrencyCode: "USD",
    unofficialCurrencyCode: null,
  },
};

const item = (id: string, overrides: Partial<PlaidItem> = {}): PlaidItem => ({
  accessToken: `access-${id}`,
  itemId: id,
  institutionId: "ins_1",
  institutionName: "First Bank",
  accounts: [storedAccount],
  products: ["transactions"],
  consentExpirationTime: null,
  lastUpdated: "2026-01-01T00:00:00.000Z",
  lastSyncCursor: null,
  ...overrides,
});

describe("plaid-oauth", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let space: ReturnType<Identity["did"]>;
  let authCellId: string;
  let unexpectedCalls: string[];

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("plaid-oauth-test");
    space = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    // CFC enforcement refuses any write to an auth cell that already holds an
    // access token, since the write reads the token's secret label along
    // with the items it keeps. Only the first item of a cell can be stored
    // under it, so the handlers run here without it.
    runtime = new Runtime({
      apiUrl: new URL("https://plaid-oauth-test.invalid"),
      storageManager,
      cfcEnforcementMode: "disabled",
    });
    authCellId = JSON.stringify(
      runtime.getCell(space, AUTH_CAUSE).getAsNormalizedFullLink(),
    );
    unexpectedCalls = [];
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  // A client whose every call is recorded as unexpected and fails, with the
  // calls a test expects supplied in `calls`.
  const fakeClient = (calls: Partial<PlaidClient> = {}): PlaidClient => {
    const refuse = (name: string) => () => {
      unexpectedCalls.push(name);
      return Promise.reject(new Error(`unexpected ${name} call`));
    };
    return {
      linkTokenCreate: refuse("linkTokenCreate"),
      itemPublicTokenExchange: refuse("itemPublicTokenExchange"),
      accountsGet: refuse("accountsGet"),
      institutionsGetById: refuse("institutionsGetById"),
      transactionsSync: refuse("transactionsSync"),
      itemRemove: refuse("itemRemove"),
      ...calls,
    };
  };

  const post = async (
    path: string,
    body: unknown,
    client: PlaidClient,
    syncAllTransactions = false,
  ) => {
    const app = createTestApp(createPlaidRouter({
      runtime: () => runtime,
      client: () => client,
      syncAllTransactions,
    }));
    const res = await app.request(`${BASE}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  const storedItems = async () => {
    const cell = runtime.getCell(space, AUTH_CAUSE, PlaidAuthSchema);
    await cell.sync();
    await runtime.storageManager.synced();
    return cell.get()?.items ?? [];
  };

  const seed = async (...items: PlaidItem[]) => {
    for (const each of items) {
      await upsertPlaidItem(runtime, authCellId, each);
    }
  };

  describe("plaidConfiguration()", () => {
    it("addresses the configured environment with the configured credentials", () => {
      const sandbox = plaidConfiguration({
        PLAID_ENV: "sandbox",
        PLAID_CLIENT_ID: "client-1",
        PLAID_SECRET: "secret-1",
      });
      const production = plaidConfiguration({
        PLAID_ENV: "production",
        PLAID_CLIENT_ID: "client-2",
        PLAID_SECRET: "secret-2",
      });

      expect(sandbox.basePath).toBe("https://sandbox.plaid.com");
      expect(sandbox.baseOptions).toMatchObject({
        headers: { "PLAID-CLIENT-ID": "client-1", "PLAID-SECRET": "secret-1" },
      });
      expect(production.basePath).toBe("https://production.plaid.com");
      expect(production.baseOptions.headers["PLAID-SECRET"]).toBe("secret-2");
    });
  });

  describe("createPlaidClient()", () => {
    it("returns a Plaid client for the given settings and for the environment's", () => {
      expect(createPlaidClient({
        PLAID_ENV: "sandbox",
        PLAID_CLIENT_ID: "client",
        PLAID_SECRET: "secret",
      })).toBeInstanceOf(PlaidApi);
      expect(createPlaidClient()).toBeInstanceOf(PlaidApi);
    });
  });

  describe("CORS", () => {
    it("returns the CORS origin header on a route's own response", async () => {
      const app = createTestApp(createPlaidRouter({
        runtime: () => runtime,
        client: () => fakeClient(),
        syncAllTransactions: false,
      }));
      const request = (path: string) =>
        app.request(path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://app.example.com",
          },
          body: JSON.stringify({ authCellId: "" }),
        });

      const response = await request(`${BASE}/create-link-token`);
      expect(response.status).toBe(400);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");

      const elsewhere = await request("/api/integrations/other/route");
      expect(elsewhere.status).toBe(404);
      expect(elsewhere.headers.get("Access-Control-Allow-Origin")).toBe(null);
    });
  });

  describe("POST create-link-token", () => {
    it("returns 400 without an auth cell and calls nothing at Plaid", async () => {
      const res = await post(
        "create-link-token",
        { authCellId: "" },
        fakeClient(),
      );

      expect(res).toEqual({
        status: 400,
        body: { error: "Missing authCellId in request" },
      });
      expect(unexpectedCalls).toEqual([]);
    });

    it("returns the link token Plaid creates for the default products and countries", async () => {
      const requests: unknown[] = [];
      const client = fakeClient({
        linkTokenCreate: (request) => {
          requests.push(request);
          return Promise.resolve({
            data: {
              link_token: "link-sandbox-0123456789abcdefghij",
              expiration: "2026-11-12T12:00:00Z",
            },
          });
        },
      });

      const res = await post(
        "create-link-token",
        { authCellId },
        client,
      );

      expect(res).toEqual({
        status: 200,
        body: {
          linkToken: "link-sandbox-0123456789abcdefghij",
          expiration: "2026-11-12T12:00:00Z",
        },
      });
      expect(requests).toEqual([{
        user: { client_user_id: "commonfabric-user" },
        client_name: "Common Fabric",
        products: ["transactions"],
        country_codes: ["US"],
        language: "en",
      }]);
    });

    it("passes the requested products and countries to Plaid", async () => {
      const requests: { products?: unknown; country_codes?: unknown }[] = [];
      const client = fakeClient({
        linkTokenCreate: (request) => {
          requests.push(request);
          return Promise.resolve({
            data: { link_token: "link", expiration: "later" },
          });
        },
      });

      await post(
        "create-link-token",
        {
          authCellId,
          products: ["auth", "transactions"],
          countryCodes: ["CA"],
        },
        client,
      );

      expect(requests[0].products).toEqual(["auth", "transactions"]);
      expect(requests[0].country_codes).toEqual(["CA"]);
    });

    it("returns the fields of a Plaid error document as a 400", async () => {
      const client = fakeClient({
        linkTokenCreate: () =>
          Promise.reject({
            response: {
              data: {
                error_message: "client_id is invalid",
                error_code: "INVALID_API_KEYS",
                error_type: "INVALID_INPUT",
                display_message: null,
              },
            },
          }),
      });

      const res = await post("create-link-token", { authCellId }, client);

      expect(res).toEqual({
        status: 400,
        body: {
          error: "client_id is invalid",
          error_code: "INVALID_API_KEYS",
          error_type: "INVALID_INPUT",
          display_message: null,
        },
      });
    });

    it("returns a generic message for a Plaid error document without one", async () => {
      const client = fakeClient({
        linkTokenCreate: () =>
          Promise.reject({ response: { data: { error_code: "X" } } }),
      });

      const res = await post("create-link-token", { authCellId }, client);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Failed to create link token");
      expect(res.body.error_code).toBe("X");
    });

    it("returns the message of an error carrying no Plaid document", async () => {
      const client = fakeClient({
        linkTokenCreate: () => Promise.reject(new Error("connection reset")),
      });

      const res = await post("create-link-token", { authCellId }, client);

      expect(res).toEqual({
        status: 400,
        body: { error: "connection reset" },
      });
    });

    it("returns a generic message for a thrown value that is not an error", async () => {
      const client = fakeClient({
        linkTokenCreate: () => Promise.reject("nope"),
      });

      const res = await post("create-link-token", { authCellId }, client);

      expect(res).toEqual({
        status: 400,
        body: { error: "Failed to create link token" },
      });
    });
  });

  describe("POST exchange-token", () => {
    const exchanging = (
      calls: Partial<PlaidClient>,
      institutionId: string | null = "ins_42",
    ) =>
      fakeClient({
        itemPublicTokenExchange: () =>
          Promise.resolve({
            data: { access_token: "access-new", item_id: "item-new" },
          }),
        accountsGet: () =>
          Promise.resolve({
            data: {
              accounts: [
                account("acc-1"),
                account("acc-2", { mask: null, subtype: null }),
              ],
              item: {
                institution_id: institutionId,
                available_products: [Products.Transactions, Products.Auth],
                consent_expiration_time: "2027-01-01T00:00:00Z",
              },
            },
          }),
        ...calls,
      });

    it("returns 400 without a public token and stores nothing", async () => {
      const res = await post(
        "exchange-token",
        { publicToken: "", authCellId },
        fakeClient(),
      );

      expect(res).toEqual({
        status: 400,
        body: { error: "Missing publicToken or authCellId in request" },
      });
      expect(unexpectedCalls).toEqual([]);
      expect(await storedItems()).toEqual([]);
    });

    it("stores the item with its accounts and Link's institution, without looking the institution up", async () => {
      const res = await post(
        "exchange-token",
        {
          publicToken: "public-1",
          authCellId,
          metadata: {
            institution: { institutionId: "ins_meta", name: "Meta Bank" },
            accounts: [],
          },
        },
        exchanging({}),
      );

      expect(res).toEqual({
        status: 200,
        body: {
          success: true,
          message: "Token exchanged successfully",
          itemId: "item-new",
        },
      });
      expect(unexpectedCalls).toEqual([]);
      expect(await storedItems()).toEqual([{
        accessToken: "access-new",
        itemId: "item-new",
        institutionId: "ins_meta",
        institutionName: "Meta Bank",
        accounts: [
          {
            accountId: "acc-1",
            name: "Account acc-1",
            mask: "1234",
            type: "depository",
            subtype: "checking",
            balances: {
              available: 100,
              current: 110,
              limit: null,
              isoCurrencyCode: "USD",
              unofficialCurrencyCode: null,
            },
          },
          {
            accountId: "acc-2",
            name: "Account acc-2",
            mask: "",
            type: "depository",
            subtype: "",
            balances: {
              available: 100,
              current: 110,
              limit: null,
              isoCurrencyCode: "USD",
              unofficialCurrencyCode: null,
            },
          },
        ],
        products: ["transactions", "auth"],
        consentExpirationTime: "2027-01-01T00:00:00Z",
        lastUpdated: expect.any(String),
        lastSyncCursor: null,
      }]);
    });

    it("stores the institution Plaid names when Link gave none", async () => {
      const lookups: unknown[] = [];
      const client = exchanging({
        institutionsGetById: (request) => {
          lookups.push(request);
          return Promise.resolve({
            data: {
              institution: { institution_id: "ins_42", name: "Bank 42" },
            },
          });
        },
      });

      await post(
        "exchange-token",
        { publicToken: "public-1", authCellId },
        client,
      );

      expect(lookups).toEqual([{
        institution_id: "ins_42",
        country_codes: ["US"],
      }]);
      const [stored] = await storedItems();
      expect(stored.institutionId).toBe("ins_42");
      expect(stored.institutionName).toBe("Bank 42");
    });

    it("stores the item's institution id under a placeholder name when the lookup fails", async () => {
      const client = exchanging({
        institutionsGetById: () => Promise.reject(new Error("lookup failed")),
      });

      const res = await post(
        "exchange-token",
        {
          publicToken: "public-1",
          authCellId,
          metadata: {
            institution: { institutionId: "", name: "Link Bank" },
            accounts: [],
          },
        },
        client,
      );

      expect(res.status).toBe(200);
      const [stored] = await storedItems();
      expect(stored.institutionId).toBe("ins_42");
      expect(stored.institutionName).toBe("Unknown Institution");
    });

    it("stores placeholders when neither Link nor Plaid names an institution", async () => {
      await post(
        "exchange-token",
        { publicToken: "public-1", authCellId },
        exchanging({}, null),
      );

      expect(unexpectedCalls).toEqual([]);
      const [stored] = await storedItems();
      expect(stored.institutionId).toBe("unknown");
      expect(stored.institutionName).toBe("Unknown Institution");
    });

    it("returns 400 when the auth cell link does not parse", async () => {
      const res = await post(
        "exchange-token",
        { publicToken: "public-1", authCellId: "not a link" },
        exchanging({}),
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Failed to get auth cell");
    });

    it("returns 400 with the failure's message and stores nothing when the exchange fails", async () => {
      const client = fakeClient({
        itemPublicTokenExchange: () =>
          Promise.reject(new Error("public token expired")),
      });

      const res = await post(
        "exchange-token",
        { publicToken: "public-1", authCellId },
        client,
      );

      expect(res).toEqual({
        status: 400,
        body: { error: "public token expired" },
      });
      expect(await storedItems()).toEqual([]);
    });
  });

  describe("POST refresh-accounts", () => {
    const accountsBy = (byToken: Record<string, AccountBase[] | Error>) =>
      fakeClient({
        accountsGet: ({ access_token }) => {
          const answer = byToken[access_token];
          return answer instanceof Error ? Promise.reject(answer) : (
            Promise.resolve({
              data: {
                accounts: answer,
                item: {
                  institution_id: null,
                  available_products: [],
                  consent_expiration_time: null,
                },
              },
            })
          );
        },
      });

    it("returns 400 without an auth cell", async () => {
      const res = await post(
        "refresh-accounts",
        { authCellId: "" },
        fakeClient(),
      );

      expect(res).toEqual({
        status: 400,
        body: { success: false, error: "Missing authCellId in request" },
      });
    });

    it("reports no items and calls nothing at Plaid when none is stored", async () => {
      const res = await post(
        "refresh-accounts",
        { authCellId },
        fakeClient(),
      );

      expect(res).toEqual({
        status: 200,
        body: {
          success: true,
          message: "No items found to refresh",
          updatedItems: 0,
        },
      });
      expect(unexpectedCalls).toEqual([]);
    });

    it("replaces each item's accounts and keeps its other fields", async () => {
      await seed(
        item("item-a", { lastSyncCursor: "cursor-a" }),
        item("item-b"),
      );

      const res = await post(
        "refresh-accounts",
        { authCellId },
        accountsBy({
          "access-item-a": [account("acc-a")],
          "access-item-b": [account("acc-b1"), account("acc-b2")],
        }),
      );

      expect(res.body).toEqual({
        success: true,
        message: "Accounts refreshed successfully",
        updatedItems: 2,
      });
      const [a, b] = await storedItems();
      expect(a.accounts?.map((x) => x.accountId)).toEqual(["acc-a"]);
      expect(a.lastSyncCursor).toBe("cursor-a");
      expect(a.institutionName).toBe("First Bank");
      expect(a.lastUpdated).not.toBe("2026-01-01T00:00:00.000Z");
      expect(b.accounts?.map((x) => x.accountId)).toEqual(["acc-b1", "acc-b2"]);
    });

    it("refreshes only the item named", async () => {
      await seed(item("item-a"), item("item-b"));

      const res = await post(
        "refresh-accounts",
        { authCellId, itemId: "item-b" },
        accountsBy({ "access-item-b": [account("acc-b")] }),
      );

      expect(res.body.updatedItems).toBe(1);
      const [a, b] = await storedItems();
      expect(a.accounts).toEqual([storedAccount]);
      expect(b.accounts?.map((x) => x.accountId)).toEqual(["acc-b"]);
    });

    it("refreshes the other items when one fails", async () => {
      await seed(item("item-a"), item("item-b"));

      const res = await post(
        "refresh-accounts",
        { authCellId },
        accountsBy({
          "access-item-a": new Error("ITEM_LOGIN_REQUIRED"),
          "access-item-b": [account("acc-b")],
        }),
      );

      expect(res.body.updatedItems).toBe(1);
      const [a, b] = await storedItems();
      expect(a).toEqual(item("item-a"));
      expect(b.accounts?.map((x) => x.accountId)).toEqual(["acc-b"]);
    });

    it("returns 400 when the auth cell link does not parse", async () => {
      const res = await post(
        "refresh-accounts",
        { authCellId: "not a link" },
        fakeClient(),
      );

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("Failed to get auth cell");
    });
  });

  describe("POST sync-transactions", () => {
    type Batch = {
      added?: Transaction[];
      modified?: Transaction[];
      removed?: string[];
      next_cursor: string;
      has_more: boolean;
    };

    // A client answering each item's syncs with its batches in turn, and
    // recording every request.
    const syncing = (
      batches: Record<string, (Batch | Error)[]>,
      requests: TransactionsSyncRequest[] = [],
    ) =>
      fakeClient({
        transactionsSync: (request) => {
          requests.push(request);
          const batch = batches[request.access_token].shift();
          if (batch === undefined || batch instanceof Error) {
            return Promise.reject(batch ?? new Error("no batch left"));
          }
          return Promise.resolve({
            data: {
              added: batch.added ?? [],
              modified: batch.modified ?? [],
              removed: (batch.removed ?? []).map((transaction_id) => ({
                transaction_id,
                account_id: "acc-1",
              })),
              next_cursor: batch.next_cursor,
              has_more: batch.has_more,
            },
          });
        },
      });

    it("returns 400 without an auth cell", async () => {
      const res = await post(
        "sync-transactions",
        { authCellId: "" },
        fakeClient(),
      );

      expect(res).toEqual({
        status: 400,
        body: { success: false, error: "Missing authCellId in request" },
      });
    });

    it("returns empty lists and calls nothing at Plaid when no item is stored", async () => {
      const res = await post(
        "sync-transactions",
        { authCellId },
        fakeClient(),
      );

      expect(res).toEqual({
        status: 200,
        body: {
          success: true,
          message: "Transactions synced successfully",
          added: [],
          modified: [],
          removed: [],
          hasMore: false,
        },
      });
      expect(unexpectedCalls).toEqual([]);
    });

    it("fetches one batch per item from its stored cursor and stores the next cursor", async () => {
      await seed(
        item("item-a", { lastSyncCursor: "cursor-a0" }),
        item("item-b"),
      );
      const requests: TransactionsSyncRequest[] = [];

      const res = await post(
        "sync-transactions",
        { authCellId, count: 2 },
        syncing({
          "access-item-a": [
            {
              added: [transaction("t1")],
              modified: [transaction("t2")],
              removed: ["t0"],
              next_cursor: "cursor-a1",
              has_more: true,
            },
            { next_cursor: "cursor-a2", has_more: false },
          ],
          "access-item-b": [
            {
              added: [transaction("t3")],
              next_cursor: "cursor-b1",
              has_more: false,
            },
          ],
        }, requests),
      );

      expect(res.body).toEqual({
        success: true,
        message: "Transactions synced successfully",
        added: [transaction("t1"), transaction("t3")],
        modified: [transaction("t2")],
        removed: ["t0"],
        hasMore: true,
      });
      expect(requests).toEqual([
        { access_token: "access-item-a", count: 2, cursor: "cursor-a0" },
        { access_token: "access-item-b", count: 2 },
      ]);
      const [a, b] = await storedItems();
      expect(a.lastSyncCursor).toBe("cursor-a1");
      expect(a.accounts).toEqual([storedAccount]);
      expect(b.lastSyncCursor).toBe("cursor-b1");
    });

    it("asks for 500 transactions a batch when the request names no count", async () => {
      await seed(item("item-a"));
      const requests: TransactionsSyncRequest[] = [];

      await post(
        "sync-transactions",
        { authCellId },
        syncing({
          "access-item-a": [{ next_cursor: "c1", has_more: false }],
        }, requests),
      );

      expect(requests).toEqual([{ access_token: "access-item-a", count: 500 }]);
    });

    it("follows each item's batches to the end when syncing all transactions", async () => {
      await seed(item("item-a"));
      const requests: TransactionsSyncRequest[] = [];

      const res = await post(
        "sync-transactions",
        { authCellId },
        syncing({
          "access-item-a": [
            { added: [transaction("t1")], next_cursor: "c1", has_more: true },
            { added: [transaction("t2")], next_cursor: "c2", has_more: true },
            { added: [transaction("t3")], next_cursor: "c3", has_more: false },
          ],
        }, requests),
        true,
      );

      expect(res.body.added).toEqual([
        transaction("t1"),
        transaction("t2"),
        transaction("t3"),
      ]);
      expect(res.body.hasMore).toBe(false);
      expect(requests.map((r) => r.cursor)).toEqual([undefined, "c1", "c2"]);
      const [a] = await storedItems();
      expect(a.lastSyncCursor).toBe("c3");
    });

    it("syncs only the item named", async () => {
      await seed(item("item-a"), item("item-b"));
      const requests: TransactionsSyncRequest[] = [];

      await post(
        "sync-transactions",
        { authCellId, itemId: "item-b" },
        syncing({
          "access-item-b": [{ next_cursor: "cursor-b1", has_more: false }],
        }, requests),
      );

      expect(requests.map((r) => r.access_token)).toEqual(["access-item-b"]);
      const [a, b] = await storedItems();
      expect(a.lastSyncCursor).toBe(null);
      expect(b.lastSyncCursor).toBe("cursor-b1");
    });

    it("syncs the other items and keeps the failed item's cursor when one fails", async () => {
      await seed(
        item("item-a", { lastSyncCursor: "cursor-a0" }),
        item("item-b"),
      );

      const res = await post(
        "sync-transactions",
        { authCellId },
        syncing({
          "access-item-a": [new Error("ITEM_LOGIN_REQUIRED")],
          "access-item-b": [
            {
              added: [transaction("t3")],
              next_cursor: "cursor-b1",
              has_more: false,
            },
          ],
        }),
      );

      expect(res.status).toBe(200);
      expect(res.body.added).toEqual([transaction("t3")]);
      const [a, b] = await storedItems();
      expect(a).toEqual(item("item-a", { lastSyncCursor: "cursor-a0" }));
      expect(b.lastSyncCursor).toBe("cursor-b1");
    });

    it("returns 400 when the auth cell link does not parse", async () => {
      const res = await post(
        "sync-transactions",
        { authCellId: "not a link" },
        fakeClient(),
      );

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("Failed to get auth cell");
    });
  });

  describe("POST remove-item", () => {
    it("returns 400 without an item id", async () => {
      const res = await post(
        "remove-item",
        { authCellId, itemId: "" },
        fakeClient(),
      );

      expect(res).toEqual({
        status: 400,
        body: {
          success: false,
          error: "Missing authCellId or itemId in request",
        },
      });
    });

    it("returns 400 for an item that is not stored and calls nothing at Plaid", async () => {
      await seed(item("item-a"));

      const res = await post(
        "remove-item",
        { authCellId, itemId: "item-z" },
        fakeClient(),
      );

      expect(res).toEqual({
        status: 400,
        body: { success: false, error: "Item not found" },
      });
      expect(unexpectedCalls).toEqual([]);
      expect(await storedItems()).toHaveLength(1);
    });

    it("removes the item at Plaid and from the auth cell, leaving the others", async () => {
      await seed(item("item-a"), item("item-b"));
      const removed: unknown[] = [];

      const res = await post(
        "remove-item",
        { authCellId, itemId: "item-a" },
        fakeClient({
          itemRemove: (request) => {
            removed.push(request);
            return Promise.resolve({});
          },
        }),
      );

      expect(res).toEqual({
        status: 200,
        body: { success: true, message: "Item removed successfully" },
      });
      expect(removed).toEqual([{ access_token: "access-item-a" }]);
      expect(await storedItems()).toEqual([item("item-b")]);
    });

    it("removes the item from the auth cell when Plaid's removal fails", async () => {
      await seed(item("item-a"));

      const res = await post(
        "remove-item",
        { authCellId, itemId: "item-a" },
        fakeClient({
          itemRemove: () => Promise.reject(new Error("Plaid unavailable")),
        }),
      );

      expect(res.status).toBe(200);
      expect(await storedItems()).toEqual([]);
    });

    it("returns 400 when the auth cell link does not parse", async () => {
      const res = await post(
        "remove-item",
        { authCellId: "not a link", itemId: "item-a" },
        fakeClient(),
      );

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("Failed to get auth cell");
    });
  });
});
