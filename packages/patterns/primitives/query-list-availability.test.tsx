/**
 * Exercises the production mail and transaction presentations with native
 * query availability, distinguishing a waiting read from an empty result.
 */
import {
  action,
  assert,
  type AsyncResult,
  FabricUnavailable,
  type HasError,
  type IsPending,
  type IsSyncing,
  pattern,
  type SqliteQueryResult,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { findElement, textContent } from "../test/vnode-helpers.ts";
import {
  LedgerMonthTransactionsPresentation,
  type LedgerTransaction,
} from "./ledger-month-transactions.tsx";
import {
  type MailboxHeader,
  MailboxMonthHeadersPresentation,
} from "./mailbox-month-headers.tsx";

/** A complete row under the ledger query's projection. */
const transaction: LedgerTransaction = {
  transaction_id: "transaction-one",
  date: "2026-10-01",
  amount: 12,
  signed_amount: -12,
  merchant_name: "Cafe",
  name: "Breakfast",
  account_id: "account-one",
  pending: 0,
  category_primary: "FOOD_AND_DRINK",
  iso_currency_code: "USD",
  status: "posted",
};

/** A complete header under the mail query's projection. */
const header: MailboxHeader = {
  id: 1,
  subject: "Breakfast receipt",
  snippet: "Thank you",
  sender: "Cafe",
  received_at: "2026-10-01",
};

export default pattern(() => {
  // SQLite stores each returned row in its own cell, so a waiting query does
  // not replace the document a previously rendered row refers to.
  const mailRow = new Writable<MailboxHeader>(header);
  const ledgerRow = new Writable<LedgerTransaction>(transaction);
  const mailResult = new Writable<SqliteQueryResult<MailboxHeader>>({
    rows: [],
  });
  const ledgerResult = new Writable<SqliteQueryResult<LedgerTransaction>>({
    rows: [],
  });
  const mailRead = new Writable<AsyncResult<SqliteQueryResult<MailboxHeader>>>({
    rows: [],
  });
  const ledgerRead = new Writable<
    AsyncResult<SqliteQueryResult<LedgerTransaction>>
  >({ rows: [] });
  const monthRead = { rows: [{ month: "2026-10" }] };
  const mail = MailboxMonthHeadersPresentation({
    monthRead,
    headersRead: mailRead,
  });
  const ledger = LedgerMonthTransactionsPresentation({
    monthRead,
    rowsRead: ledgerRead,
  });

  return {
    [TESTS]: [
      {
        action: action(() => {
          mailResult.key("rows").key(0).set(mailRow);
          ledgerResult.key("rows").key(0).set(ledgerRow);
          mailRead.set(mailResult);
          ledgerRead.set(ledgerResult);
        }),
      },
      {
        assertion: assert(() => textContent(mail[UI]).includes(header.subject)),
      },
      {
        assertion: assert(() =>
          textContent(ledger[UI]).includes(transaction.merchant_name)
        ),
      },
      {
        action: action(() => {
          const marker = new FabricUnavailable("pending") as IsPending;
          mailRead.set(marker);
          ledgerRead.set(marker);
        }),
      },
      { assertion: assert(() => mail.pending && ledger.pending) },
      {
        assertion: assert(() =>
          findElement(mail[UI], "cf-empty-state") === undefined &&
          findElement(ledger[UI], "cf-empty-state") === undefined
        ),
      },
      {
        action: action(() => {
          const marker = new FabricUnavailable("syncing") as IsSyncing;
          mailRead.set(marker);
          ledgerRead.set(marker);
        }),
      },
      { assertion: assert(() => mail.pending && ledger.pending) },
      {
        assertion: assert(() =>
          findElement(mail[UI], "cf-empty-state") === undefined &&
          findElement(ledger[UI], "cf-empty-state") === undefined
        ),
      },
      {
        assertion: assert(() =>
          mail.errorMessage === "" && ledger.errorMessage === ""
        ),
      },
      {
        action: action(() => {
          const marker = new FabricUnavailable(
            "error",
            "network",
            "store offline",
          ) as HasError;
          mailRead.set(marker);
          ledgerRead.set(marker);
        }),
      },
      { assertion: assert(() => !mail.pending && !ledger.pending) },
      {
        assertion: assert(() =>
          textContent(mail[UI]).includes("store offline") &&
          textContent(ledger[UI]).includes("store offline")
        ),
      },
      {
        assertion: assert(() =>
          findElement(mail[UI], "cf-empty-state") === undefined &&
          findElement(ledger[UI], "cf-empty-state") === undefined
        ),
      },
      {
        action: action(() => {
          mailRead.set({ rows: [] });
          ledgerRead.set({ rows: [] });
        }),
      },
      { assertion: assert(() => !mail.pending && !ledger.pending) },
      {
        assertion: assert(() =>
          findElement(mail[UI], "cf-empty-state") !== undefined &&
          findElement(ledger[UI], "cf-empty-state") !== undefined
        ),
      },
      {
        action: action(() => {
          mailResult.key("rows").key(0).set(mailRow);
          ledgerResult.key("rows").key(0).set(ledgerRow);
        }),
      },
      {
        assertion: assert(() =>
          mail.headerCount === 1 && ledger.rowCount === 1
        ),
      },
      {
        assertion: assert(() =>
          textContent(mail[UI]).includes(header.subject) &&
          textContent(ledger[UI]).includes(transaction.merchant_name)
        ),
      },
      {
        assertion: assert(() =>
          mail.errorMessage === "" && ledger.errorMessage === ""
        ),
      },
    ],
  };
});
