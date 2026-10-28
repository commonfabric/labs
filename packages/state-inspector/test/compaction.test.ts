// Verification of a compacted store against its backup: passes on what the
// run produces, and names the property a tampered result lost.

import { assert, assertEquals, assertFalse } from "@std/assert";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";

import { applyCommit, close, open } from "@commonfabric/memory/v2/engine";
import { compactStore } from "@commonfabric/memory/v2/compact";
import { encodeMemoryBoundary } from "@commonfabric/memory/v2";

import {
  type CompactionVerification,
  formatCompactionVerification,
  verifyCompaction,
} from "../compaction.ts";
import { openSpace } from "../db.ts";
import { decodeStored } from "../decode.ts";
import { reconstructRevision } from "../reconstruct.ts";

const SPACE = "did:key:z6MkTestSpace";
const ACL = `of:${SPACE}`;

const commit = (localSeq: number, operations: unknown[]) =>
  ({ localSeq, reads: { confirmed: [], pending: [] }, operations }) as never;

/** A store with an ACL genesis, two computed instances with long histories,
 * one authored document, and a per-user instance. */
async function buildStore(
  path: string,
  withAcl = true,
  deleteAcl = false,
): Promise<void> {
  const engine = await open({ url: toFileUrl(path), snapshotInterval: 5 });
  let local = 1;
  const apply = (operations: unknown[]) =>
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(local++, operations),
    });
  if (withAcl) {
    applyCommit(engine, {
      sessionId: `session:${SPACE}:genesis`,
      principal: SPACE,
      // An explicit-null member beside `value`: its removal must show.
      commit: commit(1, [{
        op: "set",
        id: ACL,
        value: { value: { [SPACE]: "OWNER" }, note: null },
      }]),
    } as never);
  }
  for (const id of ["computed:a", "computed:b"]) {
    apply([{ op: "set", id, value: { value: { n: 0, items: [] } } }]);
    for (let index = 1; index <= 12; index++) {
      apply([{
        op: "patch",
        id,
        patches: [
          { op: "replace", path: "/value/n", value: index },
          { op: "add", path: "/value/items/-", value: `item ${index}` },
        ],
      }]);
    }
  }
  if (withAcl && deleteAcl) {
    applyCommit(engine, {
      sessionId: `session:${SPACE}:genesis`,
      principal: SPACE,
      commit: commit(2, [{ op: "delete", id: ACL }]),
    } as never);
  }
  // An unselected authored document with enough patches for a snapshot of
  // its own, which the run must leave alone.
  apply([{ op: "set", id: "of:topic", value: { value: { title: "kept" } } }]);
  for (let edit = 1; edit <= 6; edit++) {
    apply([{
      op: "patch",
      id: "of:topic",
      patches: [{
        op: "replace",
        path: "/value/title",
        value: `kept, edit ${edit}`,
      }],
    }]);
  }
  // What I7 keeps: a blob, and a table a pattern made through the builtin.
  // The second column collates NOCASE: a comparison that inherited the
  // declared collation would not see a change of case.
  engine.database.exec(
    `INSERT INTO blob_store (hash, data, content_type, size) VALUES ('h1', X'0102', 'application/octet-stream', 2);
     CREATE TABLE "pattern notes" (k TEXT, v TEXT COLLATE NOCASE);
     INSERT INTO "pattern notes" VALUES ('a', '1'), ('a', '1'), ('b', 'ImportantCase'),
       ('c', 'keep' || char(0) || 'before'), ('d', 1), ('e', 1.0);`,
  );
  applyCommit(engine, {
    sessionId: "s:a",
    principal: "did:key:zAlice",
    commit: commit(local++, [{
      op: "set",
      id: "computed:a",
      scope: "user",
      value: { value: { n: 99 } },
    }]),
  } as never);
  close(engine);
}

const failing = (verification: CompactionVerification): string[] =>
  verification.checks.filter((check) => !check.passed).map((check) =>
    check.name
  );

async function withCompacted(
  run: (
    t: { backup: string; result: string; dir: string },
  ) => void | Promise<void>,
  options: {
    withAcl?: boolean;
    deleteAcl?: boolean;
    keepPayloadsMs?: number;
    keepLast?: number;
    twice?: boolean;
    /** Interrupt the first run after one instance and resume it. */
    interrupt?: boolean;
    /** Interrupt the first run after its ACL audit, before VACUUM INTO, and
     * resume it: two runs, two audits. */
    interruptAfterAudit?: boolean;
    /** Between the two runs of `twice`, tombstone the ACL document. */
    tombstoneBetween?: boolean;
  } = {},
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "compaction-verify-" });
  try {
    const store = `${dir}/work.sqlite`;
    const backup = `${dir}/backup.sqlite`;
    const result = `${dir}/result.sqlite`;
    await buildStore(store, options.withAcl ?? true, options.deleteAcl);
    await Deno.copyFile(store, backup);
    const first = {
      store,
      out: result,
      selection: { prefixes: ["computed:"] },
      keepPayloadsMs: options.keepPayloadsMs ?? 0,
      ...(options.keepLast === undefined
        ? {}
        : { cut: { keepLast: options.keepLast } }),
    };
    if (options.interrupt || options.interruptAfterAudit) {
      const stop = new Error("stop");
      const at: (progress: { phase: string; completed?: number }) => boolean =
        options.interruptAfterAudit
          ? (progress) => progress.phase === "vacuum"
          : (progress) =>
            progress.phase === "instance" && progress.completed === 1;
      await compactStore({
        ...first,
        runId: "interrupted",
        onProgress: (progress) => {
          if (at(progress)) throw stop;
        },
      }).catch((error) => {
        if (error !== stop) throw error;
      });
      await compactStore({ ...first, runId: "resumed" });
      await run({ backup, result, dir });
      return;
    }
    await compactStore({ ...first, runId: "first" });
    if (options.twice) {
      // A second run over the first's output, against that output as its
      // backup: an earlier run's markers are in both files.
      await Deno.copyFile(result, `${dir}/second-backup.sqlite`);
      if (options.tombstoneBetween) {
        // The owner deletes the ACL document after the first run; the second
        // run finds a tombstone whose history holds the first run's audit.
        const engine = await open({
          url: toFileUrl(`${dir}/second-backup.sqlite`),
        });
        applyCommit(engine, {
          sessionId: `session:${SPACE}:owner`,
          principal: SPACE,
          commit: commit(1, [{ op: "delete", id: ACL }]),
        } as never);
        close(engine);
      }
      await Deno.copyFile(
        `${dir}/second-backup.sqlite`,
        `${dir}/second-work.sqlite`,
      );
      await compactStore({
        store: `${dir}/second-work.sqlite`,
        out: `${dir}/second-result.sqlite`,
        selection: { prefixes: ["computed:", "of:"] },
        keepPayloadsMs: 0,
        runId: "second",
      });
      await run({
        backup: `${dir}/second-backup.sqlite`,
        result: `${dir}/second-result.sqlite`,
        dir,
      });
      return;
    }
    await run({ backup, result, dir });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("verifyCompaction passes on the run's own output, in full and sampled", async () => {
  await withCompacted(({ backup, result }) => {
    const full = verifyCompaction({ result, against: backup });
    assertEquals(failing(full), []);
    assert(full.ok);
    assertEquals(full.compactionCommits.length, 1);
    assert(full.compactionCommits[0].report !== undefined);
    const names = full.checks.map((check) => check.name);
    assert(names.includes("fingerprint"));
    assert(names.includes("the run did what it planned"));
    const text = formatCompactionVerification(full);
    assert(text.startsWith("ok  "));
    assert(
      text.endsWith(`checks passed in ${(full.elapsedMs / 1000).toFixed(1)} s`),
    );
    const compared = full.checks.find((check) =>
      check.name === "every document reads back identical"
    )!;
    assert(
      compared.detail.startsWith("4 of 4 instance(s) compared"),
      compared.detail,
    );

    const sampled = verifyCompaction({ result, against: backup, sample: 2 });
    assertEquals(failing(sampled), []);
    assertFalse(sampled.checks.some((check) => check.name === "fingerprint"));
    const sampledDocs = sampled.checks.find((check) =>
      check.name === "every document reads back identical"
    )!.detail;
    assert(
      sampledDocs.startsWith("2 of 4 instance(s) compared (every 2th)"),
      sampledDocs,
    );
    // `sample: 1` is every document, with only the fingerprint skipped.
    const everyOne = verifyCompaction({ result, against: backup, sample: 1 });
    assertEquals(failing(everyOne), []);
    assert(
      everyOne.checks.find((check) =>
        check.name === "every document reads back identical"
      )!.detail.startsWith("4 of 4"),
    );
    assertFalse(everyOne.checks.some((check) =>
      check.name === "fingerprint"
    ));
    const payloads = full.checks.find((check) =>
      check.name === "hollowed payloads"
    )!;
    assert(/^(\d+) hollowed; \1 marker/.test(payloads.detail), payloads.detail);
    assert(names.includes("tables outside the history are untouched"));
    assert(
      names.includes(
        "materialized boundaries hold the backup's state at their row",
      ),
    );
  });
});

Deno.test("verifyCompaction passes when the space has no ACL document", async () => {
  await withCompacted(({ backup, result }) => {
    const verification = verifyCompaction({ result, against: backup });
    assertEquals(failing(verification), []);
    assertEquals(
      verification.checks.find((check) => check.name === "ACL document")!
        .detail,
      "the space has no ACL document; none was written",
    );
  }, { withAcl: false });
});

Deno.test("verifyCompaction passes when the ACL document is a tombstone the run left alone, and catches it moved", async () => {
  await withCompacted(async ({ backup, result, dir }) => {
    const verification = verifyCompaction({ result, against: backup });
    assertEquals(failing(verification), []);
    const detail = verification.checks.find((check) =>
      check.name === "ACL document"
    )!.detail;
    assert(detail.startsWith("tombstone in the backup at "), detail);
    // The tombstone's head moved back to the genesis set: the engine would
    // read the old owner ACL again.
    const copy = `${dir}/resurrected.sqlite`;
    await Deno.copyFile(result, copy);
    const db = new Database(copy);
    db.exec(
      `UPDATE head SET seq = 1, op_index = 0, op = 'set' WHERE id = '${ACL}'`,
    );
    db.close();
    const moved = verifyCompaction({ result: copy, against: backup });
    assert(
      failing(moved).includes("ACL document"),
      formatCompactionVerification(moved),
    );
  }, { deleteAcl: true });
});

Deno.test("verifyCompaction passes on a second run whose backup already holds markers", async () => {
  await withCompacted(({ backup, result }) => {
    const verification = verifyCompaction({ result, against: backup });
    assertEquals(
      failing(verification),
      [],
      formatCompactionVerification(verification),
    );
    assertEquals(verification.compactionCommits.length, 2);
    const acl = verification.checks.find((check) =>
      check.name === "ACL document"
    )!;
    assert(
      acl.detail.includes("1 audit revision(s) for 1 new run(s)"),
      acl.detail,
    );
    // The backup, which already holds a run, against itself: a compaction
    // commit is there, but none the backup lacks.
    const same = verifyCompaction({ result: backup, against: backup });
    assertFalse(same.ok);
    assert(
      failing(same).includes("compaction commit added"),
      formatCompactionVerification(same),
    );
    assert(
      verification.checks.find((check) =>
        check.name === "compaction commit added"
      )!
        .detail.includes("1 already in the backup"),
    );
  }, { twice: true });
});

Deno.test("verifyCompaction passes on a run interrupted after one instance and resumed", async () => {
  await withCompacted(({ backup, result }) => {
    const verification = verifyCompaction({ result, against: backup });
    assertEquals(
      failing(verification),
      [],
      formatCompactionVerification(verification),
    );
    assertEquals(verification.compactionCommits.length, 2);
    const acl = verification.checks.find((check) =>
      check.name === "ACL document"
    )!;
    assert(
      acl.detail.includes("1 audit revision(s) for 2 new run(s)"),
      acl.detail,
    );
    // Two runs this result adds, so the plan cross-check has no single plan
    // to hold it to.
    assertFalse(
      verification.checks.some((check) =>
        check.name === "the run did what it planned"
      ),
    );
  }, { interrupt: true });
});

Deno.test("verifyCompaction passes on a run interrupted after its audit and resumed", async () => {
  await withCompacted(({ backup, result }) => {
    const verification = verifyCompaction({ result, against: backup });
    assertEquals(
      failing(verification),
      [],
      formatCompactionVerification(verification),
    );
    assertEquals(verification.compactionCommits.length, 2);
    const acl = verification.checks.find((check) =>
      check.name === "ACL document"
    )!;
    assert(
      acl.detail.includes("2 audit revision(s) for 2 new run(s)"),
      acl.detail,
    );
  }, { interruptAfterAudit: true });
});

Deno.test("verifyCompaction holds an interrupted attempt's retained audit to the backup", async () => {
  await withCompacted(async ({ backup, result, dir }) => {
    // The first attempt wrote its audit before the interruption; the resumed
    // run wrote the one the head reads. A changed owner in the retained
    // earlier audit leaves the head correct and must still fail.
    const copy = `${dir}/retained-audit.sqlite`;
    await Deno.copyFile(result, copy);
    const db = new Database(copy);
    const first = db.prepare(
      `SELECT seq FROM "commit" WHERE session_id = 'compaction:interrupted'`,
    ).get<{ seq: number }>()!.seq;
    const row = db.prepare(
      `SELECT data FROM revision WHERE id = ? AND seq = ? AND op_index = 0`,
    ).get<{ data: string }>(ACL, first)!;
    const document = decodeStored(row.data) as Record<string, unknown>;
    db.prepare(
      `UPDATE revision SET data = ? WHERE id = ? AND seq = ? AND op_index = 0`,
    ).run(
      encodeMemoryBoundary(
        { ...document, value: { "did:key:zInjected": "OWNER" } } as never,
      ),
      ACL,
      first,
    );
    db.close();
    const verification = verifyCompaction({ result: copy, against: backup });
    assertEquals(
      failing(verification),
      ["ACL document"],
      formatCompactionVerification(verification),
    );

    // The same retained audit, with each of the other things that can be
    // wrong with it: a row that does not decode, a value that is not an
    // ACL, a marker that is not an object, a marker naming another run; and
    // the newest run's audit gone.
    const retained = async (
      data: string | null,
      ...expected: string[]
    ): Promise<string> => {
      const tampered = `${dir}/retained-${crypto.randomUUID()}.sqlite`;
      await Deno.copyFile(result, tampered);
      const tdb = new Database(tampered);
      if (data === null) {
        tdb.prepare(
          `DELETE FROM revision WHERE id = ? AND seq = (SELECT MAX(seq) FROM "commit") AND op_index = 0`,
        ).run(ACL);
      } else {
        tdb.prepare(
          `UPDATE revision SET data = ? WHERE id = ? AND seq = ? AND op_index = 0`,
        ).run(data, ACL, first);
      }
      tdb.close();
      const v = verifyCompaction({ result: tampered, against: backup });
      for (const name of expected) {
        assert(failing(v).includes(name), formatCompactionVerification(v));
      }
      await Deno.remove(tampered);
      return v.checks.find((check) => check.name === "ACL document")!.detail;
    };
    {
      const detail = await retained("garbage", "ACL document");
      assert(detail.includes("does not decode"), detail);
    }
    {
      const detail = await retained(
        encodeMemoryBoundary(5 as never),
        "ACL document",
      );
      assert(detail.includes("not a document"), detail);
    }
    // A member added with an explicit null, and the explicit-null member
    // the backup carries removed: neither is "no difference".
    {
      const detail = await retained(
        encodeMemoryBoundary({ ...document, extra: null } as never),
        "ACL document",
      );
      assert(/differs from the backup in [a-z, ]*extra/.test(detail), detail);
    }
    {
      const { note: _note, ...withoutNote } = document;
      {
        const detail = await retained(
          encodeMemoryBoundary(withoutNote as never),
          "ACL document",
        );
        assert(/differs from the backup in [a-z, ]*note/.test(detail), detail);
      }
    }
    {
      const detail = await retained(
        encodeMemoryBoundary(
          { ...document, value: { "not a did": "OWNER" } } as never,
        ),
        "ACL document",
      );
      assert(detail.includes("value is not an ACL"), detail);
    }
    {
      const detail = await retained(
        encodeMemoryBoundary({ ...document, compaction: 7 } as never),
        "ACL document",
      );
      assert(detail.includes("marker malformed or missing"), detail);
    }
    {
      const detail = await retained(
        encodeMemoryBoundary(
          {
            ...document,
            compaction: {
              ...(document.compaction as Record<string, unknown>),
              runs: [{ commitSeq: 1 }],
            },
          } as never,
        ),
        "ACL document",
      );
      assert(detail.includes("names another run"), detail);
    }
    {
      const detail = await retained(
        null,
        "every head has its revision row",
        "ACL document",
      );
      assert(detail.includes("none at the newest run"), detail);
    }
  }, { interruptAfterAudit: true });
});

Deno.test("verifyCompaction passes on a second run after the ACL document was tombstoned", async () => {
  await withCompacted(({ backup, result }) => {
    const verification = verifyCompaction({ result, against: backup });
    assertEquals(
      failing(verification),
      [],
      formatCompactionVerification(verification),
    );
    const acl = verification.checks.find((check) =>
      check.name === "ACL document"
    )!;
    assert(acl.detail.startsWith("tombstone in the backup at "), acl.detail);
  }, { twice: true, tombstoneBetween: true });
});

Deno.test("verifyCompaction holds an earlier run's commit to the backup", async () => {
  await withCompacted(async ({ backup, result, dir }) => {
    const copy = `${dir}/earlier-run-tampered.sqlite`;
    await Deno.copyFile(result, copy);
    const db = new Database(copy);
    db.exec(
      `UPDATE "commit" SET created_at = '1900-01-01 00:00:00', resolution = '{"seq":-1}'
       WHERE session_id = 'compaction:first'`,
    );
    db.close();
    const verification = verifyCompaction({ result: copy, against: backup });
    assert(
      failing(verification).includes(
        "every commit row survives; only payloads go",
      ),
      formatCompactionVerification(verification),
    );
  }, { twice: true });
});

Deno.test("verifyCompaction catches a materialized boundary holding the wrong state under a bounded cut", async () => {
  await withCompacted(async ({ backup, result, dir }) => {
    const clean = verifyCompaction({ result, against: backup });
    assertEquals(failing(clean), [], formatCompactionVerification(clean));
    // The boundary is a kept patch materialized mid-history; later retained
    // patches set `n` again, so the head still reads right whatever the
    // boundary holds. Only the exact-row comparison sees it.
    const copy = `${dir}/boundary.sqlite`;
    await Deno.copyFile(result, copy);
    const db = new Database(copy);
    const boundary = db.prepare(
      `SELECT seq, op_index FROM revision WHERE id = 'computed:a' AND scope_key = 'space' AND op = 'set' ORDER BY seq LIMIT 1`,
    ).get<{ seq: number; op_index: number }>()!;
    db.prepare(
      `UPDATE revision SET data = replace(data, '"n":', '"n":99') WHERE id = 'computed:a' AND scope_key = 'space' AND seq = ? AND op_index = ?`,
    ).run(boundary.seq, boundary.op_index);
    db.close();
    const verification = verifyCompaction({ result: copy, against: backup });
    assertEquals(failing(verification), [
      "materialized boundaries hold the backup's state at their row",
    ]);
  }, { keepLast: 6 });
});

Deno.test("verifyCompaction names what a tampered result lost", async () => {
  await withCompacted(async ({ backup, result, dir }) => {
    const tampered = async (
      sql: string,
      ...expected: string[]
    ): Promise<CompactionVerification> => {
      const copy = `${dir}/tampered.sqlite`;
      await Deno.copyFile(result, copy);
      const db = new Database(copy);
      db.prepare(`ATTACH DATABASE ? AS against`).run(backup);
      db.exec(sql);
      db.close();
      const verification = verifyCompaction({ result: copy, against: backup });
      assertFalse(verification.ok, sql);
      for (const name of expected) {
        assert(
          failing(verification).includes(name),
          `${sql}\n${formatCompactionVerification(verification)}`,
        );
      }
      await Deno.remove(copy);
      return verification;
    };

    // A materialized boundary holding the wrong document.
    await tampered(
      `UPDATE revision SET data = replace(data, '"n":12', '"n":13') WHERE id = 'computed:a' AND scope_key = 'space' AND op = 'set'`,
      "every document reads back identical",
      "fingerprint",
    );
    // Every document differs: the list of them is capped at five.
    const many = await tampered(
      `UPDATE revision SET data = replace(data, '"n":', '"m":') WHERE op = 'set' AND id NOT LIKE 'of:did:%'`,
      "every document reads back identical",
    );
    const differ = many.checks.find((check) =>
      check.name === "every document reads back identical"
    )!.detail;
    assert(differ.includes("differ or unreadable: "), differ);
    assert(differ.split(", ").length <= 6, differ);
    // A head moved.
    await tampered(
      `UPDATE head SET seq = seq + 1 WHERE id = 'of:topic'`,
      "heads keep their addresses",
      "every head has its revision row",
    );
    // An untouched instance's row altered.
    await tampered(
      `UPDATE revision SET data = '[]' WHERE id = 'of:topic' AND op = 'patch'`,
      "rows above the boundaries are byte-identical",
    );
    // A row deleted from the middle of a surviving history: a hole.
    await tampered(
      `DELETE FROM revision WHERE id = 'of:topic' AND op = 'set'`,
      "deleted rows lie below a boundary and above no surviving row",
    );
    // A case change in a NOCASE column: the declared collation must not
    // hide it. A change after an embedded NUL: nothing may render the text
    // short. An integer turned real of the same magnitude: the storage class
    // is part of the value.
    await tampered(
      `UPDATE "pattern notes" SET v = 'importantcase' WHERE k = 'b'`,
      "tables outside the history are untouched",
    );
    await tampered(
      `UPDATE "pattern notes" SET v = 'keep' || char(0) || 'AFTER' WHERE k = 'c'`,
      "tables outside the history are untouched",
    );
    await tampered(
      `UPDATE "pattern notes" SET v = 1.0 WHERE k = 'd'`,
      "tables outside the history are untouched",
    );
    // The ACL document's marker replaced by null: a failed check, not a
    // thrown one.
    await tampered(
      `UPDATE revision SET data = '${
        encodeMemoryBoundary(
          { compaction: null, value: { [SPACE]: "OWNER" } } as never,
        )
      }' WHERE id = '${ACL}' AND seq = (SELECT seq FROM head WHERE id = '${ACL}')`,
      "ACL document",
    );
    // Live data outside the history lost: a blob row, a pattern's table
    // dropped, a duplicate row removed from a table without a key.
    await tampered(
      `DELETE FROM blob_store`,
      "tables outside the history are untouched",
    );
    await tampered(
      `DROP TABLE "pattern notes"`,
      "schema identical",
      "tables outside the history are untouched",
    );
    await tampered(
      `DELETE FROM "pattern notes" WHERE rowid = (SELECT MIN(rowid) FROM "pattern notes" WHERE k = 'a')`,
      "tables outside the history are untouched",
    );
    // An eligible payload kept intact.
    await tampered(
      `UPDATE "commit" SET original = (SELECT original FROM against."commit" WHERE seq = 3) WHERE seq = 3`,
      "hollowed payloads",
    );
    // A marker whose hash is wrong, wherever it sits.
    await tampered(
      `UPDATE "commit" SET original = replace(original, '"hash":"', '"hash":"x') WHERE seq = (SELECT MAX(seq) FROM "commit" WHERE original LIKE 'fvj1:{"hollowed":%')`,
      "hollowed payloads",
    );
    // A marker that does not decode.
    await tampered(
      `UPDATE "commit" SET original = substr(original, 1, length(original) - 3) WHERE seq = 3`,
      "hollowed payloads",
    );
    // Commit metadata changed; a compaction commit's local_seq changed; a
    // run's plan replaced by something that is not one.
    await tampered(
      `UPDATE "commit" SET created_at = '1900-01-01 00:00:00' WHERE seq = 2`,
      "every commit row survives; only payloads go",
    );
    await tampered(
      `UPDATE "commit" SET local_seq = 9 WHERE session_id LIKE 'compaction:%'`,
      "compaction commit recorded",
    );
    await tampered(
      `UPDATE "commit" SET original = 'fvj1:{"compaction":{"report":{}}}' WHERE session_id LIKE 'compaction:%'`,
      "compaction commit recorded",
    );
    // A retained snapshot of an untouched instance removed.
    await tampered(
      `DELETE FROM snapshot WHERE id = 'of:topic'`,
      "snapshots are the backup's, removed only at or below a boundary",
    );
    // A hollowed row the backup never had.
    await tampered(
      `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
       SELECT 0, 'ghost', 1, original, resolution FROM "commit" WHERE seq = 3`,
      "hollowed payloads",
    );
    // A marker with the right prefix and the wrong shape.
    await tampered(
      `UPDATE "commit" SET original = 'fvj1:{"hollowed":{"bytes":1}}' WHERE seq = 3`,
      "hollowed payloads",
    );
    // The compaction commit under another identity, class or branch, with a
    // plan that is not an object, and with a payload that does not decode.
    await tampered(
      `UPDATE "commit" SET session_id = 'compaction:other' WHERE session_id LIKE 'compaction:%'`,
      "compaction commit recorded",
    );
    await tampered(
      `UPDATE "commit" SET class = 'authored', branch = 'b' WHERE session_id LIKE 'compaction:%'`,
      "compaction commit recorded",
    );
    await tampered(
      `UPDATE "commit" SET original = 'fvj1:{"compaction":{"report":"x"}}' WHERE session_id LIKE 'compaction:%'`,
      "compaction commit recorded",
    );
    await tampered(
      `UPDATE "commit" SET original = 'not a payload' WHERE session_id LIKE 'compaction:%'`,
      "compaction commit recorded",
    );
    // A second ACL document, and an ACL document whose head row is gone.
    await tampered(
      `INSERT INTO head (branch, id, scope_key, seq, op_index, op) VALUES ('', 'of:did:key:z6MkOther', 'space', 1, 0, 'set')`,
      "ACL document",
    );
    await tampered(
      `DELETE FROM revision WHERE id = '${ACL}' AND seq = (SELECT seq FROM head WHERE id = '${ACL}')`,
      "every head has its revision row",
      "ACL document",
    );
    // An ACL document with no rows left at all.
    await tampered(
      `DELETE FROM revision WHERE id = '${ACL}'`,
      "ACL document",
    );
    // The genesis receipt hollowed by hand.
    await tampered(
      `UPDATE "commit" SET original = (SELECT original FROM "commit" WHERE seq = 3) WHERE seq = 1`,
      "hollowed payloads",
      "genesis receipt byte-identical",
    );
    // A commit row dropped.
    await tampered(
      `PRAGMA foreign_keys = OFF; DELETE FROM "commit" WHERE seq = 4`,
      "every commit row survives; only payloads go",
    );
    // A write after the compaction commit.
    await tampered(
      `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
       SELECT seq + 1, 'late', 1, original, resolution FROM "commit" WHERE seq = (SELECT MAX(seq) FROM "commit")`,
      "no commit after the compaction commit",
    );
    // The ACL marker stripped.
    await tampered(
      `DELETE FROM revision WHERE id = '${ACL}' AND seq = (SELECT MAX(seq) FROM "commit");
       UPDATE head SET seq = 1, op_index = 0, op = 'set' WHERE id = '${ACL}'`,
      "ACL document",
    );
    // A backup whose boundary row does not decode: the exact-row comparison
    // fails rather than throws.
    const taintedBackup = `${dir}/tainted-backup.sqlite`;
    await Deno.copyFile(backup, taintedBackup);
    const tainted = new Database(taintedBackup);
    const boundary = tainted.prepare(
      `SELECT seq, op_index FROM revision WHERE id = 'computed:a' AND scope_key = 'space' ORDER BY seq DESC, op_index DESC LIMIT 1`,
    ).get<{ seq: number; op_index: number }>()!;
    tainted.prepare(
      `UPDATE revision SET data = 'garbage' WHERE id = 'computed:a' AND scope_key = 'space' AND seq = ? AND op_index = ?`,
    ).run(boundary.seq, boundary.op_index);
    tainted.close();
    const againstTainted = verifyCompaction({ result, against: taintedBackup });
    assert(
      failing(againstTainted).includes(
        "materialized boundaries hold the backup's state at their row",
      ),
      formatCompactionVerification(againstTainted),
    );
    // No compaction commit at all: the backup against itself.
    const none = verifyCompaction({ result: backup, against: backup });
    assertFalse(none.ok);
    assertEquals(failing(none), ["compaction commit recorded"]);
  });
});

Deno.test("reconstructRevision gives the state after exactly one row", async () => {
  const dir = await Deno.makeTempDir({ prefix: "reconstruct-revision-" });
  try {
    const path = `${dir}/space.sqlite`;
    // A snapshot at every commit, so a reconstruction at a commit's first
    // operation has a snapshot at its own seq to wrongly start from.
    const engine = await open({ url: toFileUrl(path), snapshotInterval: 1 });
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, [{
        op: "set",
        id: "of:list",
        value: { value: { items: [] } },
      }]),
    });
    const twoOps = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, [
        {
          op: "patch",
          id: "of:list",
          patches: [{ op: "add", path: "/value/items/-", value: "a" }],
        },
        {
          op: "patch",
          id: "of:list",
          patches: [{ op: "add", path: "/value/items/-", value: "b" }],
        },
      ]),
    }).seq;
    const deleted = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(3, [{ op: "delete", id: "of:list" }]),
    }).seq;
    close(engine);
    const space = openSpace(path);
    try {
      const items = (document: unknown) =>
        (document as { value: { items: unknown[] } }).value.items;
      assertEquals(
        items(
          reconstructRevision(space, { id: "of:list", seq: 1, opIndex: 0 }),
        ),
        [],
      );
      assertEquals(
        items(
          reconstructRevision(space, {
            id: "of:list",
            seq: twoOps,
            opIndex: 0,
          }),
        ),
        ["a"],
      );
      assertEquals(
        items(
          reconstructRevision(space, {
            id: "of:list",
            seq: twoOps,
            opIndex: 1,
          }),
        ),
        ["a", "b"],
      );
      assertEquals(
        reconstructRevision(space, { id: "of:list", seq: deleted, opIndex: 0 }),
        undefined,
      );
      let thrown: unknown;
      try {
        reconstructRevision(space, { id: "of:list", seq: twoOps, opIndex: 7 });
      } catch (error) {
        thrown = error;
      }
      assert(thrown instanceof Error && thrown.message.includes("no revision"));
    } finally {
      space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
