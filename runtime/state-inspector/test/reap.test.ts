import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";

import { applyCommit, close, open } from "@commonfabric/memory/v2/engine";
import { reapStore } from "@commonfabric/memory/v2/reap";

import { openSpace } from "../db.ts";
import { summarizeSpace } from "../queries.ts";
import { verifyReap } from "../reap.ts";

const SPACE = "did:key:z6MkVerifyReapSpace";
const ALICE = "did:key:z6MkVerifyReapAlice";
const ACL = `of:${SPACE}`;

describe("reap", () => {
  describe("verifyReap()", () => {
    let dir: string;
    let store: string;
    let out: string;

    beforeEach(async () => {
      dir = await Deno.makeTempDir({ prefix: "verify-reap-" });
      store = `${dir}/space.sqlite`;
      out = `${dir}/space.reaped.sqlite`;
      const engine = await open({ url: toFileUrl(store) });
      let local = 1;
      const apply = (operations: unknown[]) =>
        applyCommit(engine, {
          sessionId: "session:alice",
          space: SPACE,
          principal: ALICE,
          commit: {
            localSeq: local++,
            reads: { confirmed: [], pending: [] },
            operations,
          },
        } as never);
      apply([{ op: "set", id: ACL, value: { value: { [ALICE]: "OWNER" } } }]);
      apply([{ op: "set", id: "of:doc", value: { value: { n: 1 } } }]);
      engine.database.exec(
        `CREATE TABLE private_rows (x TEXT); INSERT INTO private_rows VALUES ('a');
         CREATE TABLE "constructor" (x TEXT); INSERT INTO "constructor" VALUES ('a');
         CREATE TABLE sqliteX (x TEXT); INSERT INTO sqliteX VALUES ('a')`,
      );
      apply([{
        op: "set",
        id: ACL,
        value: { value: { deleted: { by: ALICE } } },
      }]);
      // The engine records no invocation or authorization for a commit, so
      // the rows the deletion commit references, and one it does not, are
      // written here.
      for (const ref of ["ref:deletion", "ref:earlier"]) {
        engine.database.prepare(
          `INSERT INTO invocation (ref, iss, cmd, sub, invocation)
           VALUES (?, ?, '/memory/transact', ?, '{}')`,
        ).run(ref, ALICE, SPACE);
        engine.database.prepare(
          `INSERT INTO authorization (ref, authorization) VALUES (?, '{}')`,
        ).run(ref);
      }
      engine.database.exec(
        `UPDATE "commit" SET invocation_ref = 'ref:deletion',
           authorization_ref = 'ref:deletion' WHERE seq = 3`,
      );
      close(engine);
      await reapStore({ store, out });
    });
    afterEach(async () => {
      await Deno.remove(dir, { recursive: true });
    });

    /** Runs `sql` against the reaped result. */
    const tamper = (sql: string) => {
      const db = new Database(out);
      try {
        db.exec(sql);
      } finally {
        db.close();
      }
    };

    it("leaves a result the inspector's summary reads as the deleted space, not as a damaged one", () => {
      const space = openSpace(out);
      try {
        expect(summarizeSpace(space).deletion).toEqual({ by: ALICE, seq: 3 });
      } finally {
        space.close();
      }
    });

    it("passes a result the reap wrote", () => {
      const verification = verifyReap({ result: out, against: store });
      expect(
        verification.checks.filter((check) => !check.passed),
      ).toEqual([]);
      expect(verification.ok).toBe(true);
    });

    it("fails a result that kept a row it should have removed", () => {
      tamper(
        `INSERT INTO head (branch, id, scope_key, seq, op_index, op)
         VALUES ('', 'of:doc', 'space', 2, 0, 'set')`,
      );
      const verification = verifyReap({ result: out, against: store });
      expect(verification.ok).toBe(false);
      expect(
        verification.checks.filter((check) => !check.passed).map((check) =>
          check.name
        ),
      ).toContain("head: only the kept rows, unchanged");
    });

    it("fails a result holding a row of a table the reap empties", () => {
      tamper(`INSERT INTO private_rows VALUES ('a')`);
      const verification = verifyReap({ result: out, against: store });
      expect(
        verification.checks.filter((check) => !check.passed).map((check) =>
          check.name
        ),
      ).toContain("private_rows: only the kept rows, unchanged");
    });

    it("fails a result holding a row of a table whose name only looks like SQLite's own", () => {
      tamper(`INSERT INTO sqliteX VALUES ('a')`);
      const verification = verifyReap({ result: out, against: store });
      expect(
        verification.checks.filter((check) => !check.passed).map((check) =>
          check.name
        ),
      ).toEqual(["sqliteX: only the kept rows, unchanged"]);
    });

    it("fails a result holding a table the backup lacks", () => {
      tamper(`CREATE TABLE added (x TEXT); INSERT INTO added VALUES ('a')`);
      const verification = verifyReap({ result: out, against: store });
      expect(
        verification.checks.filter((check) => !check.passed).map((check) =>
          check.name
        ),
      ).toEqual(["every table of the result is in the backup"]);
    });

    it("fails a result whose deletion commit was changed", () => {
      tamper(`UPDATE "commit" SET session_id = 'someone-else'`);
      const verification = verifyReap({ result: out, against: store });
      expect(
        verification.checks.filter((check) => !check.passed).map((check) =>
          check.name
        ),
      ).toContain("commit: only the kept rows, unchanged");
    });

    it("fails a result whose backup's ACL payload cannot be decoded", () => {
      const backup = new Database(store);
      try {
        backup.prepare(
          `UPDATE revision SET data = '{' WHERE id = ? AND seq = 3`,
        ).run(ACL);
      } finally {
        backup.close();
      }
      const verification = verifyReap({ result: out, against: store });
      expect(verification.ok).toBe(false);
      expect(
        verification.checks.filter((check) => !check.passed).map((check) =>
          check.name
        ),
      ).toEqual(["the backup's ACL document holds a deletion tombstone"]);
    });

    it("fails, as a check, against a backup that is not a database", async () => {
      const notStore = `${dir}/not-a-store.sqlite`;
      await Deno.writeTextFile(notStore, "plain text, not SQLite");
      const verification = verifyReap({ result: out, against: notStore });
      expect(verification.ok).toBe(false);
      const failed = verification.checks.filter((check) => !check.passed);
      expect(failed.map((check) => check.name)).toEqual([
        "the stores can be compared",
      ]);
      expect(failed[0].detail).not.toBe("");
    });

    it("fails a result reaped from a store whose space is not deleted", async () => {
      const live = `${dir}/live.sqlite`;
      const engine = await open({ url: toFileUrl(live) });
      applyCommit(engine, {
        sessionId: "session:alice",
        space: SPACE,
        principal: ALICE,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: ACL,
            value: { value: { [ALICE]: "OWNER" } },
          }],
        },
      } as never);
      close(engine);
      const verification = verifyReap({ result: out, against: live });
      expect(verification.ok).toBe(false);
      expect(
        verification.checks.find((check) =>
          check.name === "the backup's ACL document holds a deletion tombstone"
        )?.passed,
      ).toBe(false);
    });
  });
});
