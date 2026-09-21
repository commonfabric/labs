import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import {
  all,
  any,
  authoredBy,
  dbOwner,
  match,
  principal,
} from "@commonfabric/memory/sqlite/row-label";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef } from "@commonfabric/memory/v2";

import type { CfcConfClause } from "../src/cfc/clause.ts";
import { cfcLabelViewForDereferenceTraces } from "../src/cfc/label-view.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("shared query read ceilings");
const BOB = "did:mailto:bob@example.test";
const SQL = "SELECT id, to_addr, body FROM emails ORDER BY id";

describe("sqlite shared read ceiling", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let writer: Runtime;
  let db: SqliteDbRef;
  let aggregateDb: SqliteDbRef;
  const runtimes: Runtime[] = [];
  const errors: unknown[] = [];

  beforeEach(async () => {
    storage = StorageManager.emulate({ as: signer });
    writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      cfcFlowLabels: "persist",
    });
    db = {
      id: `of:shared-ceiling-${crypto.randomUUID()}`,
      owner: signer.did(),
      tables: {
        emails: table(
          { id: "integer primary key", to_addr: "text", body: "text" },
          (f) => ({
            confidentiality: all(
              dbOwner(),
              principal("mailto", match(f.to_addr, /[^\s<>,;"]+@[^\s<>,;"]+/g)),
            ),
          }),
        ),
        shared: table(
          { id: "integer primary key", to_addr: "text", body: "text" },
          (f) => ({
            confidentiality: any(
              dbOwner(),
              principal("mailto", match(f.to_addr, /[^\s<>,;"]+@[^\s<>,;"]+/g)),
            ),
          }),
        ),
        notes: table({ id: "integer primary key", body: "text" }),
      },
    };
    aggregateDb = {
      ...db,
      id: `${db.id}-aggregate`,
      tables: { shared: db.tables!.shared },
    };
    const tx = writer.edit();
    tx.recordSqliteWrite!(signer.did(), {
      op: "sqlite",
      db,
      sql: "INSERT INTO emails (to_addr, body) VALUES (?, ?), (?, ?)",
      params: ["", "mine", "bob@example.test", "private message"],
    });
    tx.recordSqliteWrite!(signer.did(), {
      op: "sqlite",
      db,
      sql: "INSERT INTO notes (body) VALUES (?)",
      params: ["public note"],
    });
    tx.recordSqliteWrite!(signer.did(), {
      op: "sqlite",
      db,
      sql: "INSERT INTO shared (to_addr, body) VALUES (?, ?), (?, ?)",
      params: ["", "mine", "bob@example.test", "private message"],
    });
    expect((await tx.commit()).error).toBeUndefined();
    const aggregateTx = writer.edit();
    aggregateTx.recordSqliteWrite!(signer.did(), {
      op: "sqlite",
      db: aggregateDb,
      sql: "INSERT INTO shared (to_addr, body) VALUES (?, ?), (?, ?)",
      params: ["", "mine", "bob@example.test", "private message"],
    });
    expect((await aggregateTx.commit()).error).toBeUndefined();
  });

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.dispose();
    await writer.dispose();
    await storage.close();
    errors.splice(0);
  });

  const reader = (ceiling: readonly CfcConfClause[]) => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      cfcReadMaxConfidentiality: ceiling,
      cfcFlowLabels: "persist",
      errorHandlers: [(error) => errors.push(error)],
    });
    runtimes.push(runtime);
    return runtime;
  };

  const run = async (
    runtime: Runtime,
    sql = SQL,
    query: Record<string, unknown> = {},
  ) => {
    const { commonfabric: cf } = createTrustedBuilder(runtime);
    // The result is shared; the runtime's ceiling belongs to observation.
    const pattern = cf.pattern(() =>
      // deno-lint-ignore no-explicit-any
      cf.sqliteQuery({ db, reactOn: db, sql, ...query } as any)
    );
    const tx = runtime.edit();
    const cell = runtime.getCell(
      signer.did(),
      "shared query",
      pattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, pattern, {}, cell);
    expect((await tx.commit()).error).toBeUndefined();
    const cancel = result.key("pending").sink(() => {});
    try {
      await runtime.idle();
      expect(errors).toEqual([]);
      await waitForCellValue(
        runtime,
        result.key("pending"),
        (value) => value === false,
      );
    } finally {
      cancel();
    }
    return result;
  };

  it("materializes one complete shared result while withholding its values and row count from a narrower reader", async () => {
    const narrow = reader([signer.did()]);
    const result = await run(narrow);
    expect(() => result.get()).toThrow(/read ceiling/);
    expect(() => result.key("result").get()).toThrow(/read ceiling/);
    expect(() => result.key("result").getRaw({ nonRecursive: true })).toThrow(
      /read ceiling/,
    );
    expect(() => result.key("result").key("length").get()).toThrow(
      /read ceiling/,
    );
    expect(result.key("error").get()).toBeUndefined();
    const wide = reader([signer.did(), BOB]);
    const admitted = wide.getCellFromLink(result.getAsNormalizedFullLink());
    await admitted.sync();
    const rows = admitted.key("result").get() as Array<{ body: string }>;
    expect(rows.map((row) => row.body)).toEqual(["mine", "private message"]);
    const hash = admitted.key("requestHash").get();
    const rerun = await run(wide);
    expect(rerun.key("requestHash").get()).toBe(hash);
    expect(() => result.key("result").get()).toThrow(/read ceiling/);
  });

  it("keeps the array membership label out of an addressed row's payload observation", async () => {
    const result = await run(writer);
    const tx = writer.edit();
    expect(result.key("result").key(0).key("body").withTx(tx).get()).toBe(
      "mine",
    );
    const view = cfcLabelViewForDereferenceTraces(
      tx,
      tx.getCfcState().dereferenceTraces,
    );
    const confidentiality = (view?.entries ?? []).flatMap((entry) =>
      entry.label.confidentiality ?? []
    );
    expect(confidentiality).toContain(signer.did());
    expect(confidentiality).not.toContain(BOB);
    expect((await tx.commit()).error).toBeUndefined();
  });

  it("refreshes a labeled shared result without observing its previous rows", async () => {
    const carol = "did:mailto:carol@example.test";
    const runtime = reader([signer.did(), BOB, carol]);
    const { commonfabric: cf } = createTrustedBuilder(runtime);
    const tx = runtime.edit();
    const tick = runtime.getCell<number>(
      signer.did(),
      "refresh tick",
      undefined,
      tx,
    );
    tick.set(0);
    const pattern = cf.pattern<{ tick: number }>(({ tick }) =>
      // deno-lint-ignore no-explicit-any
      cf.sqliteQuery({ db, sql: SQL, reactOn: tick } as any)
    );
    const result = runtime.run(
      tx,
      pattern,
      { tick },
      runtime.getCell(
        signer.did(),
        "refresh result",
        pattern.resultSchema,
        tx,
      ),
    );
    expect((await tx.commit()).error).toBeUndefined();
    const cancel = result.key("pending").sink(() => {});
    try {
      await runtime.settled();
      expect(result.key("error").get()).toBeUndefined();
      const previous = result.key("requestHash").get();
      expect(result.key("pending").get()).toBe(false);
      const refresh = runtime.edit();
      refresh.recordSqliteWrite!(signer.did(), {
        op: "sqlite",
        db,
        sql: "UPDATE emails SET to_addr = ? WHERE id = 2",
        params: ["carol@example.test"],
      });
      tick.withTx(refresh).set(1);
      expect((await refresh.commit()).error).toBeUndefined();
      await runtime.settled();
      expect(errors).toEqual([]);
      expect(result.key("error").get()).toBeUndefined();
      expect(result.key("pending").get()).toBe(false);
      expect(result.key("requestHash").get()).not.toBe(previous);
      expect(result.key("result").get()).toEqual([
        { id: 1, to_addr: "", body: "mine" },
        { id: 2, to_addr: "carol@example.test", body: "private message" },
      ]);
      const narrowed = reader([signer.did(), carol]).getCellFromLink(
        result.getAsNormalizedFullLink(),
      );
      await narrowed.sync();
      expect(() => narrowed.key("result").key("length").get()).toThrow(
        /read ceiling/,
      );
      expect(narrowed.key("result").key(1).key("body").get()).toBe(
        "private message",
      );
    } finally {
      cancel();
    }
  });

  it("withholds an aggregate value under a narrower observation ceiling", async () => {
    const result = await run(
      reader([BOB]),
      "SELECT COUNT(*) AS n FROM shared",
      { db: aggregateDb },
    );
    expect(result.key("error").get()).toBeUndefined();
    expect(() => result.key("result").get()).toThrow(/read ceiling/);
    const admitted = reader([signer.did()]).getCellFromLink(
      result.getAsNormalizedFullLink(),
    );
    await admitted.sync();
    expect(admitted.key("result").get()).toEqual([{ n: 2 }]);
  });

  it("withholds a shared filtered array's shape under the labels of skipped rows", async () => {
    const result = await run(reader([signer.did()]), SQL, {
      maxConfidentiality: [signer.did()],
      onExceed: "skip",
    });
    expect(() => result.key("result").get()).toThrow(/read ceiling/);
    const admitted = reader([signer.did(), BOB]).getCellFromLink(
      result.getAsNormalizedFullLink(),
    );
    await admitted.sync();
    expect(
      (admitted.key("result").get() as Array<{ body: string }>).map((row) =>
        row.body
      ),
    ).toEqual(["mine"]);
  });

  it("reports a shared ceiling refusal without the private row ordinal", async () => {
    const result = await run(reader([signer.did()]), SQL, {
      maxConfidentiality: [signer.did()],
    });
    expect(result.key("error").get()).toMatch(/declared output ceiling/);
    expect(result.key("error").get()).not.toMatch(/row \d/);
  });

  it("withholds private match counts from shared row-label failure diagnostics", async () => {
    const ruleDb: SqliteDbRef = {
      id: `${db.id}-integrity`,
      owner: signer.did(),
      tables: {
        messages: table(
          { authors: "text" },
          (f) => ({
            confidentiality: dbOwner(),
            integrity: authoredBy(
              principal("mailto", match(f.authors, /[^\s<>,;"]+@[^\s<>,;"]+/g)),
            ),
          }),
        ),
      },
    };
    const tx = writer.edit();
    tx.recordSqliteWrite!(signer.did(), {
      op: "sqlite",
      db: { ...ruleDb, tables: { messages: table({ authors: "text" }) } },
      sql: "INSERT INTO messages (authors) VALUES (?)",
      params: ["a@example.test b@example.test"],
    });
    expect((await tx.commit()).error).toBeUndefined();
    const result = await run(reader([BOB]), "SELECT authors FROM messages", {
      db: ruleDb,
    });
    const error = result.key("error").get();
    expect(error).toMatch(/rowLabel rule/);
    expect(error).not.toMatch(/2 matches|row \d|a@example/);
  });

  it("withholds private cell content from a shared query's provider error", async () => {
    const narrow = reader([{ type: "User", subject: signer.did() }]);
    const result = await run(
      narrow,
      "SELECT json_extract('{}', body) AS value FROM emails WHERE id = 2",
    );
    expect(result.key("error").get()).toBe("1: SQL logic error");
    expect(result.key("error").get()).not.toContain("private message");
  });

  it("admits a shared query over public rows", async () => {
    const result = await run(reader([signer.did()]), "SELECT body FROM notes");
    expect(result.key("result").get()).toEqual([{ body: "public note" }]);
  });
});
