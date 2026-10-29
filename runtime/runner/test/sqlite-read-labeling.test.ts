// CFC read-labeling (Phase 2, per-column static `ifc`):
//  (1) labelResultSchema — pure: origin (table,column) -> per-output-field ifc,
//      fail closed on an unattributable column.
//  (2) provider path — when the db declares column `ifc`, the server returns each
//      result column's TRUE origin (resolving aliases); unlabeled dbs return none.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { SqliteDbRef, SqliteParamsWire } from "@commonfabric/memory/v2";
import { Runtime } from "../src/runtime.ts";
import { labelResultSchema } from "../src/builtins/sqlite-builtins.ts";
import { cfcLabelViewForCell } from "../src/cfc/label-view.ts";
import { cfcConfidentialityForObservationNode } from "../src/cfc/observation.ts";

describe("labelResultSchema (pure)", () => {
  const tables = {
    emails: {
      properties: {
        from_email: { ifc: { confidentiality: ["sender"] } },
        subject: {},
      },
    },
  };

  it("carries a labeled column's ifc under its OUTPUT name (alias-safe)", () => {
    // Output name is the alias `s`; ifc comes from the origin column from_email.
    const { schema, error } = labelResultSchema(
      [{ output: "s", table: "emails", column: "from_email" }],
      tables,
    );
    expect(error).toBeUndefined();
    expect(schema).toEqual({
      type: "object",
      additionalProperties: true,
      properties: {
        result: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            properties: { s: { ifc: { confidentiality: ["sender"] } } },
          },
        },
      },
    });
  });

  it("no schema when no selected column is labeled", () => {
    const { schema, error } = labelResultSchema(
      [{ output: "subject", table: "emails", column: "subject" }],
      tables,
    );
    expect(error).toBeUndefined();
    expect(schema).toBeUndefined();
  });

  it("null-origin column unions confidentiality but carries no integrity", () => {
    // An expression / aggregate (COUNT(*), upper(x)) has no single origin. It
    // conservatively unions the confidentiality of every declared labeled column
    // (a sound over-approximation). It carries NO integrity: an aggregate is a
    // new computed value and inherits no integrity evidence — unioning would let
    // it falsely claim an atom held by a single column (§8.17.1: meet, never
    // union; propagation classes pending, conservatively empty). [CT-1668]
    const t = {
      emails: {
        properties: {
          from_email: {
            ifc: { confidentiality: ["sender"], integrity: ["a", "b"] },
          },
          body: {
            ifc: { confidentiality: ["body-secret"], integrity: ["b", "c"] },
          },
          subject: {},
        },
      },
    };
    const { schema, error } = labelResultSchema(
      [{ output: "n", table: null, column: null }],
      t,
    );
    expect(error).toBeUndefined();
    const ifc = (schema as Record<string, any>).properties.result.items
      .properties.n.ifc;
    expect([...ifc.confidentiality].sort()).toEqual(["body-secret", "sender"]);
    expect(ifc.integrity ?? []).toEqual([]);
  });

  it("refuses a query with duplicate output column names (ambiguous label)", () => {
    const { error } = labelResultSchema(
      [
        { output: "x", table: "emails", column: "from_email" },
        { output: "x", table: "emails", column: "subject" },
      ],
      tables,
    );
    expect(error).toMatch(/same output name/i);
  });
});

const signer = await Identity.fromPassphrase("read-labeling test");
const space = signer.did();

describe("writing rows under the label schema persists per-field confidentiality", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });
  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("a consumer reading q.result[i].col inherits the column's confidentiality", async () => {
    const { schema } = labelResultSchema(
      [{ output: "sender", table: "emails", column: "from_email" }],
      {
        emails: {
          properties: { from_email: { ifc: { confidentiality: ["sec"] } } },
        },
      },
    );
    expect(schema).toBeDefined();

    // Write as the builtin does (asSchema). The write is CFC-relevant, so the
    // tx MUST be prepared before commit (the builtin's editWithRetry does this
    // for free; here we do it explicitly).
    const tx = runtime.edit();
    const cell = runtime.getCell(space, "rl-result", undefined, tx);
    cell.asSchema(schema!).withTx(tx).set({
      pending: false,
      result: [{ sender: "a@x.com" }, { sender: "b@x.com" }],
      requestHash: "h1",
    });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();

    const tx2 = runtime.edit();
    const c = runtime.getCell(space, "rl-result", undefined, tx2).withTx(tx2);
    // Sibling fields survive (not shaped away by the labeling schema).
    expect((c.get() as { requestHash: string }).requestHash).toBe("h1");
    expect((c.get() as { result: unknown[] }).result).toHaveLength(2);

    // Each row's `sender` carries the column confidentiality — a consumer
    // reading it inherits it.
    for (const i of [0, 1]) {
      const rowView = cfcLabelViewForCell(
        c.key("result").key(i),
      );
      const conf = cfcConfidentialityForObservationNode({
        labelView: rowView,
        logicalPath: ["sender"],
      });
      expect(conf).toContainEqual("sec");
    }
    await tx2.commit().settled;
  });
});

// Raw wire schema with a labeled column (what the server sees).
const labeledTables = {
  emails: {
    type: "object",
    properties: {
      id: { type: "integer", sqlType: "integer primary key" },
      from_email: {
        type: "string",
        sqlType: "text",
        ifc: { confidentiality: ["sender-secret"] },
      },
      subject: { type: "string", sqlType: "text" },
    },
    required: [],
  },
} as unknown as SqliteDbRef["tables"];

describe({
  // FFI loads the column-metadata lib (process-lifetime by design); exempt this
  // suite from the dynamic-library leak detector.
  name: "server returns column provenance only when ifc is declared",
  sanitizeResources: false,
}, () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });
  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const seed = async (
    db: SqliteDbRef,
    sql: string,
    params?: SqliteParamsWire,
  ) => {
    const tx = runtime.edit();
    tx.recordSqliteWrite!(space, { op: "sqlite", db, sql, params });
    return await tx.commit().settled;
  };

  it({
    // FFI loads the column-metadata lib (process-lifetime by design); exempt
    // this test from the dynamic-library leak detector.
    name: "labeled db: result columns carry the TRUE origin (alias resolved)",
    sanitizeResources: false,
  }, async () => {
    const db: SqliteDbRef = {
      id: `of:lbl-${crypto.randomUUID()}`,
      tables: labeledTables,
    };
    expect(
      (await seed(
        db,
        "INSERT INTO emails (from_email, subject) VALUES (?, ?)",
        [
          "a@x.com",
          "hi",
        ],
      )).error,
    ).toBeUndefined();

    const provider = storageManager.open(space);
    const r = await provider.sqliteQuery!(
      db,
      "SELECT from_email AS sender, subject FROM emails",
    );
    expect(r.rows).toEqual([{ sender: "a@x.com", subject: "hi" }]);
    // Aliased output `sender`, but origin is the real source column from_email.
    expect(r.columns).toEqual([
      { output: "sender", table: "emails", column: "from_email" },
      { output: "subject", table: "emails", column: "subject" },
    ]);
  });

  it("unlabeled db: no provenance captured (zero overhead)", async () => {
    const db: SqliteDbRef = {
      id: `of:plain-${crypto.randomUUID()}`,
      tables: {
        emails: {
          type: "object",
          properties: {
            id: { type: "integer", sqlType: "integer primary key" },
            subject: { type: "string", sqlType: "text" },
          },
          required: [],
        },
      } as unknown as SqliteDbRef["tables"],
    };
    await seed(db, "INSERT INTO emails (subject) VALUES (?)", ["hi"]);
    const provider = storageManager.open(space);
    const r = await provider.sqliteQuery!(db, "SELECT subject FROM emails");
    expect(r.rows).toEqual([{ subject: "hi" }]);
    expect(r.columns).toBeUndefined();
  });
});
