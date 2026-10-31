/**
 * What a `sqliteQuery` result's membership declaration carries across
 * refreshes.
 *
 * The result's membership is declared with every row's label and the
 * request's (CFC spec §8.17.6): the join of what the request read, which
 * includes what the query reacts on. The declaration is grow-only: each
 * settle carries the prior declaration forward, so a refresh whose rows no
 * longer include a labeled one does not take that label back. Which rows a
 * refresh dropped is a fact about them (§8.17.4).
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import {
  all,
  dbOwner,
  match,
  principal,
} from "@commonfabric/memory/sqlite/row-label";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef, SqliteParamsWire } from "@commonfabric/memory/v2";

import type { Cell } from "../src/cell.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-sqlite-membership-declaration",
);
const space = signer.did();

const BOB = "did:mailto:bob@example.test";
const SELECTION = "did:test:selection";
const TRIGGER = "did:test:trigger";

interface QueryState {
  pending?: boolean;
  result?: unknown[];
  error?: unknown;
}

describe("CFC flow labels: a sqlite result's membership declaration", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
      cfcWriteFloor: "enforce",
      cfcPolicyEvaluation: "enforce",
      cfcLabelMetadataProtection: "enforce",
      cfcDeclaredMonotonicity: "enforce",
    });
  });

  afterEach(async () => {
    await runtime.dispose({ closeStorage: false });
    await storageManager.close();
  });

  const seed = async (
    db: SqliteDbRef,
    sql: string,
    params?: SqliteParamsWire,
  ): Promise<void> => {
    const tx = runtime.edit();
    tx.recordSqliteWrite!(space, { op: "sqlite", db, sql, params });
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  /** A cell holding `value` whose label is `confidentiality`. */
  const labeled = <T>(
    tx: ReturnType<Runtime["edit"]>,
    cause: string,
    value: T,
    confidentiality: string,
  ): Cell<T> => {
    const cell = runtime.getCell<T>(space, cause, {
      type: typeof value,
      ifc: { confidentiality: [confidentiality] },
      // deno-lint-ignore no-explicit-any -- `ifc` is not on the schema type
    } as any, tx);
    cell.set(value);
    return cell;
  };

  /** The confidentiality the result's membership declares. */
  // deno-lint-ignore no-explicit-any -- the builtin's state is untyped
  const declaredMembership = (query: Cell<any>): unknown[] => {
    const tx = runtime.edit();
    try {
      const link = query.withTx(tx).resolveAsCell().getAsNormalizedFullLink();
      const entries = readStoredCfcMetadata(tx, link)?.labelMap.entries ?? [];
      return entries
        .filter((entry) =>
          entry.origin === "declared" && entry.observes === "enumerate" &&
          entry.path.length === 1 && entry.path[0] === "result"
        )
        .flatMap((entry) =>
          (entry.label as { confidentiality?: unknown[] }).confidentiality ??
            []
        );
    } finally {
      tx.abort("label read");
    }
  };

  it("keeps a row's label after a refresh that no longer selects the row", async () => {
    const db = {
      id: `of:membership-declaration-${crypto.randomUUID()}`,
      owner: space,
      tables: {
        mail: table(
          { id: "integer primary key", to_addr: "text", body: "text" },
          (f) => ({
            confidentiality: all(
              dbOwner(),
              principal(
                "mailto",
                match(f.to_addr, /[^\s<>,;"]+@[^\s<>,;"]+/g),
              ),
            ),
          }),
        ),
      },
    } as unknown as SqliteDbRef;
    await seed(
      db,
      "INSERT INTO mail (to_addr, body) VALUES (?, ?)",
      ["bob@example.test", "hello"],
    );

    const setup = runtime.edit();
    const excluded = labeled(setup, "excluded", "no such body", SELECTION);
    const trigger = labeled(setup, "trigger", 1, TRIGGER);
    expect((await setup.commit().settled).error).toBeUndefined();

    const { commonfabric: cf } = createTrustedBuilder(runtime);
    const page = cf.pattern<{ excluded: string; trigger: number }>((input) => ({
      query: cf.sqliteQuery({
        db,
        reactOn: input.trigger,
        sql: "SELECT id, to_addr, body FROM mail WHERE body != ?1 ORDER BY id",
        params: [input.excluded],
        // deno-lint-ignore no-explicit-any -- the builtin's input is untyped
      } as any),
    }));

    const tx = runtime.edit();
    const resultCell = runtime.getCell(space, "page", page.resultSchema, tx);
    const result = runtime.run(
      tx,
      page,
      // deno-lint-ignore no-explicit-any -- cells stand in for the arguments
      { excluded, trigger } as any,
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    // deno-lint-ignore no-explicit-any -- the builtin's state is untyped
    const query = result.key("query") as Cell<any>;
    const settled = (rows: number) =>
      waitForCellValue<QueryState>(
        runtime,
        query,
        (value) =>
          (value?.pending === false && (value?.result ?? []).length === rows) ||
          value?.error !== undefined,
      );
    expect((await settled(1)).error).toBeUndefined();

    const first = declaredMembership(query);
    expect(first).toContainEqual(space);
    expect(first).toContainEqual(BOB);
    expect(first).toContainEqual(SELECTION);
    expect(first).toContainEqual(TRIGGER);

    // The owner's own row arrives, the parameter now excludes Bob's row, and
    // the query is told to run again: the refresh holds one row, the
    // owner's, and the declaration keeps Bob's label.
    await seed(
      db,
      "INSERT INTO mail (to_addr, body) VALUES (?, ?)",
      ["", "mine"],
    );
    const bump = runtime.edit();
    excluded.withTx(bump).set("hello");
    trigger.withTx(bump).set(2);
    expect((await bump.commit().settled).error).toBeUndefined();
    const refreshed = await waitForCellValue<QueryState>(
      runtime,
      query,
      (value) =>
        (value?.pending === false && value?.result?.length === 1 &&
          (value.result[0] as { body?: string }).body === "mine") ||
        value?.error !== undefined,
    );
    expect(refreshed.error).toBeUndefined();
    await runtime.idle();

    const second = declaredMembership(query);
    expect(second).toContainEqual(space);
    expect(second).toContainEqual(BOB);
    expect(second).toContainEqual(SELECTION);
    expect(second).toContainEqual(TRIGGER);
  });
});
