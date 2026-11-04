// Server-execution v2 stage A: every commit row carries a `class` —
// 'authored' | 'derived' | 'system', a closed set, determined by the
// admission path and never by any client-supplied value
// (docs/specs/server-side-execution/protocol.md §1). These tests pin the
// stage-A surface: the class is WRITTEN in every arm (no flag involved in
// stamping), `derived` is unclaimable off the flag (its ON-arm admission —
// the stage-B lease equality check — is covered in
// v2-execution-lease-test.ts), and a pre-class store migrates by backfilling
// 'authored'.

import { assertEquals, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";
import {
  applyCommit,
  close,
  commitClassOfSeq,
  type Engine,
  open,
  ProtocolError,
} from "../v2/engine.ts";
import type { ClientCommit } from "../v2.ts";

const createEngine = async (): Promise<{
  engine: Engine;
  path: string;
}> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  return { engine, path };
};

const setCommit = (localSeq: number, id: string): ClientCommit => ({
  localSeq,
  reads: { confirmed: [], pending: [] },
  operations: [{ op: "set", id, value: { value: { n: localSeq } } }],
});

const storedClasses = (path: string): { seq: number; class: string }[] => {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare(`SELECT seq, class FROM "commit" ORDER BY seq`).all() as {
      seq: number;
      class: string;
    }[];
  } finally {
    db.close();
  }
};

Deno.test("commit class: stamped 'authored' for the transact-shaped path in every arm", async () => {
  const { engine, path } = await createEngine();
  try {
    applyCommit(engine, {
      sessionId: "session-a",
      principal: "user:alice",
      commit: setCommit(1, "of:doc-1"),
      commitClass: "authored",
    });
    // Callers that predate the class (tests, embedders) take the default of
    // the client-commit admission core: authored.
    applyCommit(engine, {
      sessionId: "session-a",
      principal: "user:alice",
      commit: setCommit(2, "of:doc-2"),
    });
  } finally {
    close(engine);
  }
  assertEquals(storedClasses(path), [
    { seq: 1, class: "authored" },
    { seq: 2, class: "authored" },
  ]);
});

Deno.test("commit class: the server's own path stamps 'system'", async () => {
  const { engine, path } = await createEngine();
  try {
    applyCommit(engine, {
      sessionId: "server:direct",
      commit: setCommit(1, "of:doc-1"),
      commitClass: "system",
    });
  } finally {
    close(engine);
  }
  assertEquals(storedClasses(path), [{ seq: 1, class: "system" }]);
});

Deno.test("commit class: a class smuggled into the client payload is inert", async () => {
  const { engine, path } = await createEngine();
  try {
    // The wire cannot express a commit class: `ClientCommit` has no such
    // field, and admission never reads one from the payload. A smuggled
    // field rides along as opaque payload without influencing the stored
    // class (protocol.md §1 — server-determined, FP15).
    const smuggled = {
      ...setCommit(1, "of:doc-1"),
      class: "derived",
      commitClass: "derived",
    } as unknown as ClientCommit;
    applyCommit(engine, {
      sessionId: "session-a",
      principal: "user:mallory",
      commit: smuggled,
      commitClass: "authored",
    });
  } finally {
    close(engine);
  }
  assertEquals(storedClasses(path), [{ seq: 1, class: "authored" }]);
});

Deno.test("commit class: 'derived' is unclaimable off the flag", async () => {
  // The lease admission check exists from stage B on, but it is enforced
  // only under EXPERIMENTAL_SERVER_EXECUTION — and off the flag nothing may
  // claim the class at all (protocol.md §1). The ON-arm admission surface is
  // covered in v2-execution-lease-test.ts.
  const { engine } = await createEngine();
  try {
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session-a",
          principal: "user:alice",
          commit: setCommit(1, "of:doc-1"),
          commitClass: "derived",
        }),
      ProtocolError,
      "EXPERIMENTAL_SERVER_EXECUTION",
    );
  } finally {
    close(engine);
  }
});

Deno.test("commit class: a pre-class store migrates, backfilling 'authored'", async () => {
  const { engine, path } = await createEngine();
  try {
    applyCommit(engine, {
      sessionId: "session-a",
      principal: "user:alice",
      commit: setCommit(1, "of:doc-1"),
    });
  } finally {
    close(engine);
  }

  // Rebuild the pre-stage-A shape: drop the class column so the store looks
  // like one written before the migration existed.
  {
    const db = new Database(path);
    try {
      db.exec(`ALTER TABLE "commit" DROP COLUMN class`);
    } finally {
      db.close();
    }
  }

  // Reopening runs the migration; the historical row backfills 'authored'
  // and new commits stamp their class as usual.
  const reopened = await open({ url: toFileUrl(path) });
  try {
    applyCommit(reopened, {
      sessionId: "server:direct",
      commit: setCommit(1, "of:doc-2"),
      commitClass: "system",
    });
  } finally {
    close(reopened);
  }
  assertEquals(storedClasses(path), [
    { seq: 1, class: "authored" },
    { seq: 2, class: "system" },
  ]);
});

//
// commitClassOfSeq (the arrival-witness predicate's server-side read,
// speculation.md §4): the unknown-seq arm answers undefined, and the memo
// declines to record inside ANY transaction — `applyCommit` brackets its
// transaction with the staged document cache, but `applyWaveCommit` opens its
// own transaction WITHOUT staging, so the guard is the CONNECTION state
// (`database.inTransaction`), not a caller marker. A rolled-back seq is
// re-minted by the retry, possibly under another class; a memo entry written
// mid-transaction would serve that phantom class forever.
//

Deno.test("commitClassOfSeq: seq 0, negative, and unknown seqs answer undefined (fail-closed substrate of the at-floor witness)", async () => {
  const { engine } = await createEngine();
  try {
    assertEquals(commitClassOfSeq(engine, 0), undefined);
    assertEquals(commitClassOfSeq(engine, -1), undefined);
    // No commit admitted yet: every positive seq is unknown.
    assertEquals(commitClassOfSeq(engine, 1), undefined);
    applyCommit(engine, {
      sessionId: "session-a",
      principal: "user:alice",
      commit: setCommit(1, "of:doc-1"),
      commitClass: "authored",
    });
    assertEquals(commitClassOfSeq(engine, 1), "authored");
    // Still undefined past the head — and the unknown answer was not memoized:
    // the same seq admitted later answers its real class. ('system' here:
    // 'derived' is unclaimable off the flag, and this arm runs flagless.)
    assertEquals(commitClassOfSeq(engine, 2), undefined);
    applyCommit(engine, {
      sessionId: "server:direct",
      commit: setCommit(2, "of:doc-1"),
      commitClass: "system",
    });
    assertEquals(commitClassOfSeq(engine, 2), "system");
  } finally {
    close(engine);
  }
});

Deno.test("commitClassOfSeq: a mid-transaction read is served but never memoized — a rolled-back seq re-minted under another class answers the new class, not the phantom", async () => {
  const { engine } = await createEngine();
  try {
    applyCommit(engine, {
      sessionId: "session-a",
      principal: "user:alice",
      commit: setCommit(1, "of:doc-1"),
      commitClass: "authored",
    });
    // A transaction stages a derived-class commit at seq 2, reads its class
    // mid-transaction (served from the staged row), then rolls back — the
    // applyWaveCommit shape: its own transaction, no staged-cache bracket.
    class Rollback extends Error {}
    let midTransaction: string | undefined = "unread";
    try {
      engine.database.transaction(() => {
        engine.database.exec(
          `INSERT INTO "commit" (seq, session_id, local_seq, original,
             resolution, class)
           VALUES (2, 'session-a', 2, '{}', '{}', 'derived')`,
        );
        midTransaction = commitClassOfSeq(engine, 2);
        throw new Rollback();
      }).immediate();
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    assertEquals(midTransaction, "derived");
    // Rolled back: the row is gone, and the answer must say so — a memo entry
    // recorded mid-transaction would still say "derived" here.
    assertEquals(commitClassOfSeq(engine, 2), undefined);
    // The retry re-mints seq 2 under ANOTHER class; the phantom would shadow
    // it for every future frame annotation at this seq.
    applyCommit(engine, {
      sessionId: "session-a",
      principal: "user:alice",
      commit: setCommit(2, "of:doc-1"),
      commitClass: "authored",
    });
    assertEquals(commitClassOfSeq(engine, 2), "authored");
  } finally {
    close(engine);
  }
});
