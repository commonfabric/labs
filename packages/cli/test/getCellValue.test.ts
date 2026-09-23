import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { createSession, Identity } from "@commonfabric/identity";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime, type RuntimeProgram } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { defer } from "@commonfabric/utils/defer";

import { getCellValue } from "../lib/piece.ts";

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `
import { computed, pattern, SqliteDb, sqliteQuery } from "commonfabric";

export default pattern<{ db: SqliteDb }>(({ db }) => {
  const query = sqliteQuery.asScope("session")<{ body: string }>({
    db,
    sql: "SELECT body FROM notes ORDER BY id",
  });
  const rows = computed(() => query.result ?? []);
  return { rows, rowCount: computed(() => rows.length), pending: query.pending };
});
`,
  }],
};

describe("getCellValue()", () => {
  it("returns the session query rows on the first stepped read", async () => {
    const identity = await Identity.fromPassphrase("cli first session read");
    const storageManager = StorageManager.emulate({ as: identity });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    const releaseQuery = defer<void>();
    try {
      const pieces = new PiecesController(
        await createSession({
          identity,
          spaceName: "cli-first-session-read",
        }),
        runtime,
      );
      await pieces.synced();
      const space = pieces.getSpace();
      const db: SqliteDbRef = {
        id: "of:first-session-read",
        scope: "session",
        tables: { notes: table({ id: "integer primary key", body: "text" }) },
      };
      const tx = runtime.edit();
      tx.recordSqliteWrite!(space, {
        op: "sqlite",
        db,
        sql: "INSERT INTO notes (body) VALUES (?), (?)",
        params: ["first", "second"],
      });
      expect((await tx.commit()).error).toBeUndefined();

      const compiled = await runtime.patternManager.compilePattern(PROGRAM, {
        space,
      });
      const piece = await pieces.runPersistent(compiled, { db }, undefined, {
        start: false,
      });
      const provider = storageManager.open(space);
      const query = provider.sqliteQuery!.bind(provider);
      const queryScopes: (string | undefined)[] = [];
      provider.sqliteQuery = async (...args) => {
        queryScopes.push(args[0].scope);
        await releaseQuery.promise;
        return await query(...args);
      };
      const settleEntered = defer<void>();
      const settled = runtime.settled.bind(runtime);
      using _settledObserver = stub(runtime, "settled", (...args) => {
        const result = settled(...args);
        settleEntered.resolve();
        return result;
      });

      const read = getCellValue(
        {
          apiUrl: "https://example.com",
          identity: "/unused-identity.pem",
          space,
          piece: entityRefToString(piece.entityId),
        },
        [],
        { step: true },
        {
          loadPieces: () => Promise.resolve(pieces),
        },
      );
      // Release the real query when the read waits for it. An early return
      // also releases it, so a missing barrier fails on the returned value.
      await Promise.race([read, settleEntered.promise]);
      releaseQuery.resolve();

      expect(await read).toEqual({
        rows: [{ body: "first" }, { body: "second" }],
        rowCount: 2,
        pending: false,
      });
      expect(queryScopes).toEqual(["session"]);
    } finally {
      releaseQuery.resolve();
      await runtime.dispose({ closeStorage: false });
      await storageManager.close();
    }
  });
});
