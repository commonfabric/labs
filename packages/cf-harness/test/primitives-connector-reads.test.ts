/**
 * The index atoms that read a loom connector store —
 * `packages/patterns/primitives/ledger-month-transactions.tsx`,
 * `mailbox-month-headers.tsx` and `source-row-count.tsx` — reached the way a
 * harness session reaches them: through `run_pattern` over an injected
 * `SqliteDb` handle.
 *
 * What is stated here is what only this route can state. A pattern test builds
 * its database with `sqliteDatabase()`, which is a cell-derived database in
 * the pattern's own space; a session is instead handed a handle cell naming a
 * store it did not create, and the query it issues is bound to that. The
 * tombstone rule, the month window, the row ceiling and the views are stated
 * in the pattern tests beside each atom, which is also where they earn
 * authored-pattern coverage.
 *
 * A database with rows already in it is the other thing this route has: the
 * handle is seeded before the atom is built, so the read that settles is the
 * atom's first one, and the month it resolves for a caller that names none is
 * whatever month the clock is in.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { createSession, Identity } from "@commonfabric/identity";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { CfHarnessEngine } from "../src/engine.ts";
import type { RunPatternToolSuccessOutput } from "../src/tools/run-pattern.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

const signer = await Identity.fromPassphrase("cf-harness connector atoms");

/** Where the atoms live, relative to this file. */
const atomSource = (name: string): Promise<string> =>
  Deno.readTextFile(
    fromFileUrl(new URL(`../../patterns/primitives/${name}`, import.meta.url)),
  );

/** One SQLite write, as a seed run records it onto a transaction. */
interface SeedWrite {
  sql: string;
  params: (string | number | null)[];
}

class FakeSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string): string {
    return path;
  }

  isPathWithinWorkspace(path: string): boolean {
    return path.startsWith("/workspace");
  }

  isPathWithinAllowedRoots(path: string): boolean {
    return this.isPathWithinWorkspace(path);
  }

  defaultWorkingDirectory(): string {
    return "/workspace";
  }

  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

/** The columns of `rows_plaid_transaction` the ledger atom projects. */
const LEDGER_TABLES = {
  rows_plaid_transaction: table({
    record_id: "text primary key",
    transaction_id: "text",
    account_id: "text",
    date: "text",
    amount: "real",
    signed_amount: "real",
    merchant_name: "text",
    name: "text",
    pending: "integer",
    category_primary: "text",
    iso_currency_code: "text",
    status: "text",
    deleted: "integer",
    deleted_at: "text",
  }),
};

/** The mail tables the mailbox atom reads and joins. */
const MAILBOX_TABLES = {
  messages: table({
    id: "integer primary key",
    subject: "text",
    snippet: "text",
    received_at: "text",
    sent_at: "text",
    internal_date: "text",
    sender_id: "integer",
    deleted_at: "text",
  }),
  participants: table({
    id: "integer primary key",
    display_name: "text",
    email_address: "text",
  }),
};

const LEDGER_INSERT = "INSERT INTO rows_plaid_transaction (record_id, " +
  "transaction_id, account_id, date, amount, signed_amount, merchant_name, " +
  "name, pending, category_primary, iso_currency_code, status, deleted, " +
  "deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

const MESSAGE_INSERT = "INSERT INTO messages (id, subject, snippet, " +
  "received_at, sent_at, internal_date, sender_id, deleted_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

const PARTICIPANT_INSERT =
  "INSERT INTO participants (id, display_name, email_address) VALUES (?, ?, ?)";

/**
 * A ledger row as the connector store writes one: text columns never NULL, a
 * tombstone marked by the integer flag rather than by `deleted_at`.
 */
const ledgerRow = (
  recordId: string,
  date: string,
  merchant: string,
  amount: number,
  deleted: number,
): SeedWrite => ({
  sql: LEDGER_INSERT,
  params: [
    recordId,
    `txn-${recordId}`,
    "acct-1",
    date,
    amount,
    -amount,
    merchant,
    `${merchant} purchase`,
    0,
    "GENERAL_SERVICES",
    "USD",
    "posted",
    deleted,
    deleted === 1 ? `${date}T12:00:00Z` : "",
  ],
});

/** A message as the mail store writes one: a live row leaves `deleted_at` NULL. */
const messageRow = (
  id: number,
  subject: string,
  receivedAt: string,
  deletedAt: string | null,
): SeedWrite => ({
  sql: MESSAGE_INSERT,
  params: [
    id,
    subject,
    `${subject} snippet`,
    receivedAt,
    null,
    null,
    1,
    deletedAt,
  ],
});

describe("connector-reading primitives", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `connector-atoms-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Seeds a database holding `writes` and answers the link naming its handle. */
  async function seedDatabase(
    tables: Record<string, unknown>,
    writes: readonly SeedWrite[],
  ): Promise<string> {
    const space = pieces.getSpace();
    const dbRef = {
      id: `connector-atoms-${crypto.randomUUID()}`,
      tables,
    } as SqliteDbRef;
    const tx = runtime.edit();
    const handle = runtime.getCell<SqliteDbRef>(
      space,
      `connector-atoms-handle-${crypto.randomUUID()}`,
      undefined,
      tx,
    );
    handle.set(dbRef);
    for (const write of writes) {
      tx.recordSqliteWrite!(space, {
        op: "sqlite",
        db: dbRef,
        sql: write.sql,
        params: write.params,
      });
    }
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();
    return createLLMFriendlyLink(handle.getAsNormalizedFullLink(), space);
  }

  /** Runs `source` over `inputs` and answers the piece's settled result. */
  async function runAtom(
    source: string,
    inputs: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `connector-atoms-${crypto.randomUUID()}`,
      cfcEnforcementMode: "disabled",
      fabricSessionFactory: () => Promise.resolve({ pieces }),
    });
    const result = await engine.invokeBuiltinTool("run_pattern", {
      sourceText: source,
      inputs,
    });
    const output = result.output as RunPatternToolSuccessOutput;
    expect(output.status).toBe("ok");

    // The query is a server round-trip, so the run returns while it is still
    // in flight; the piece's own result is where it lands.
    const piece = await pieces.get(output.pieceId);
    await runtime.idle();
    await pieces.synced();
    await runtime.idle();
    return (await piece.result.get()) as Record<string, unknown>;
  }

  describe("ledger-month-transactions", () => {
    it("returns the month's live rows and leaves out the tombstoned ones", async () => {
      const bank = await seedDatabase(LEDGER_TABLES, [
        ledgerRow("live", "2026-03-04", "Pacific Gas", 84.2, 0),
        ledgerRow("gone", "2026-03-06", "Refunded Co", 12, 1),
        ledgerRow("later", "2026-04-02", "Next Month", 9, 0),
      ]);

      const result = await runAtom(
        await atomSource(
          "ledger-month-transactions.tsx",
        ),
        { bank, month: "2026-03" },
      );

      expect(result.errorMessage).toBe("");
      expect(result.month).toBe("2026-03");
      expect(result.rowCount).toBe(1);
      expect((result.rows as Array<{ merchant_name: string }>)[0].merchant_name)
        .toBe("Pacific Gas");
    });

    it("reads the current month when the caller names none", async () => {
      const thisMonth = new Date().toISOString().slice(0, 7);
      const bank = await seedDatabase(LEDGER_TABLES, [
        ledgerRow("now", `${thisMonth}-01`, "Current Month Co", 10, 0),
        ledgerRow("old", "2020-01-01", "Long Ago Co", 10, 0),
      ]);

      const result = await runAtom(
        await atomSource("ledger-month-transactions.tsx"),
        { bank },
      );

      expect(result.errorMessage).toBe("");
      expect(result.month).toBe(thisMonth);
      expect(result.rowCount).toBe(1);
    });
  });

  describe("source-row-count", () => {
    it("counts the whole table and the rows the predicate admits", async () => {
      const source = await seedDatabase(LEDGER_TABLES, [
        ledgerRow("live", "2026-03-04", "Pacific Gas", 84.2, 0),
        ledgerRow("also-live", "2026-03-05", "Water Co", 12, 0),
        ledgerRow("gone", "2026-03-06", "Refunded Co", 9, 1),
      ]);

      const result = await runAtom(
        await atomSource("source-row-count.tsx"),
        {
          source,
          table: "rows_plaid_transaction",
          predicate: "deleted = 0",
        },
      );

      expect(result.errorMessage).toBe("");
      expect(result.total).toBe(3);
      expect(result.matching).toBe(2);
    });

    it("counts no row for a predicate the store's rows do not satisfy", async () => {
      // The other tombstone spelling over a store that writes the text column
      // never-NULL: the difference between the two numbers is what says the
      // predicate is wrong rather than the table empty.

      const source = await seedDatabase(LEDGER_TABLES, [
        ledgerRow("live", "2026-03-04", "Pacific Gas", 84.2, 0),
        ledgerRow("gone", "2026-03-06", "Refunded Co", 9, 1),
      ]);

      const result = await runAtom(
        await atomSource("source-row-count.tsx"),
        {
          source,
          table: "rows_plaid_transaction",
          predicate: "deleted_at IS NULL",
        },
      );

      expect(result.errorMessage).toBe("");
      expect(result.total).toBe(2);
      expect(result.matching).toBe(0);
    });
  });

  describe("mailbox-month-headers", () => {
    it("returns the month's live headers with their sender, and leaves out the deleted ones", async () => {
      const mail = await seedDatabase(MAILBOX_TABLES, [
        {
          sql: PARTICIPANT_INSERT,
          params: [1, "Pacific Gas", "billing@pge.example"],
        },
        messageRow(1, "Your bill is ready", "2026-03-04T09:00:00Z", null),
        messageRow(2, "Deleted notice", "2026-03-05T09:00:00Z", "2026-03-06"),
        messageRow(3, "Next month", "2026-04-01T09:00:00Z", null),
      ]);

      const result = await runAtom(
        await atomSource("mailbox-month-headers.tsx"),
        { mail, month: "2026-03" },
      );

      expect(result.errorMessage).toBe("");
      expect(result.month).toBe("2026-03");
      expect(result.headerCount).toBe(1);
      const headers = result.headers as Array<
        { subject: string; sender: string }
      >;
      expect(headers[0].subject).toBe("Your bill is ready");
      expect(headers[0].sender).toBe("Pacific Gas");
    });
  });
});
