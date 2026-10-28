// Proof that the durable-history oracle (oracle.ts) is a usable
// post-condition for concurrency tests, and that it is not vacuous:
//
//   1. a real contended engine run — accepted disjoint-key writes, a valid
//      read-modify-write, and a rejected stale commit — yields ZERO
//      anomalies (the engine validated every persisted read); and
//   2. a forged commit inserted behind the engine's back, claiming a read
//      the engine would have rejected, IS flagged.
//
// See docs/specs/memory-v2/09-invariants.md, INV-1.

import { assertEquals, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";
import {
  applyCommit,
  close,
  ConflictError,
  open,
} from "@commonfabric/memory/v2/engine";
import { type EntityDocument, toDocumentPath } from "@commonfabric/memory/v2";
import { openSpace } from "../db.ts";
import { staleReadAnomalies } from "../oracle.ts";

const doc = (value: unknown): EntityDocument => ({ value } as EntityDocument);

const ALICE = { sessionId: "s-alice", principal: "did:key:zAlice" };
const BOB = { sessionId: "s-bob", principal: "did:key:zBob" };
const CAROL = { sessionId: "s-carol", principal: "did:key:zCarol" };

// Seq 1: seed doc. Seq 2: Bob's valid read-modify-write of the title.
const seedContendedStore = async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });

  applyCommit(engine, {
    ...ALICE,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "entity:doc",
        value: doc({ title: "t0", votes: {} }),
      }],
    },
  });

  applyCommit(engine, {
    ...BOB,
    commit: {
      localSeq: 1,
      reads: {
        confirmed: [{
          id: "entity:doc",
          path: toDocumentPath(["value", "title"]),
          seq: 1,
        }],
        pending: [],
      },
      operations: [{
        op: "patch",
        id: "entity:doc",
        patches: [{ op: "replace", path: "/value/title", value: "t1" }],
      }],
    },
  });

  return { engine, path };
};

Deno.test("oracle: a contended engine run yields zero anomalies", async () => {
  const { engine, path } = await seedContendedStore();
  try {
    // Disjoint-key writers on the same container: both accepted thanks to
    // the leaf-only matcher, and both coherent.
    applyCommit(engine, {
      ...ALICE,
      commit: {
        localSeq: 2,
        reads: {
          confirmed: [{
            id: "entity:doc",
            path: toDocumentPath(["value", "votes", "alice"]),
            seq: 1,
          }],
          pending: [],
        },
        operations: [{
          op: "patch",
          id: "entity:doc",
          patches: [{ op: "add", path: "/value/votes/alice", value: 1 }],
        }],
      },
    });
    applyCommit(engine, {
      ...BOB,
      commit: {
        localSeq: 2,
        reads: {
          confirmed: [{
            id: "entity:doc",
            path: toDocumentPath(["value", "votes", "bob"]),
            seq: 1,
          }],
          pending: [],
        },
        operations: [{
          op: "patch",
          id: "entity:doc",
          patches: [{ op: "add", path: "/value/votes/bob", value: 1 }],
        }],
      },
    });

    // A genuinely stale read is rejected and therefore never persisted.
    assertThrows(
      () =>
        applyCommit(engine, {
          ...CAROL,
          commit: {
            localSeq: 1,
            reads: {
              confirmed: [{
                id: "entity:doc",
                path: toDocumentPath(["value", "title"]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:derived",
              value: doc("built from t0"),
            }],
          },
        }),
      ConflictError,
    );
  } finally {
    close(engine);
  }

  const space = openSpace(path);
  try {
    assertEquals(staleReadAnomalies(space), []);
  } finally {
    space.close();
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("oracle: flags a forged commit that bypassed validation", async () => {
  const { engine, path } = await seedContendedStore();
  close(engine);

  // Forge a commit claiming it read the title at seq 1 — Bob's accepted
  // seq-2 write overlaps that read, so the engine would have rejected it.
  const db = new Database(path);
  try {
    db.prepare(
      `INSERT INTO "commit"
         (seq, branch, session_id, local_seq, invocation_ref,
          authorization_ref, original, resolution, created_at)
       VALUES (?, '', ?, ?, NULL, NULL, ?, ?, ?)`,
    ).run(
      10,
      "session:forged",
      99,
      JSON.stringify({
        localSeq: 99,
        reads: {
          confirmed: [{
            id: "entity:doc",
            path: ["value", "title"],
            seq: 1,
          }],
          pending: [],
        },
        operations: [{
          op: "set",
          id: "entity:derived",
          value: { value: "built from t0" },
        }],
      }),
      JSON.stringify({ seq: 10 }),
      new Date().toISOString(),
    );
  } finally {
    db.close();
  }

  const space = openSpace(path);
  try {
    const anomalies = staleReadAnomalies(space);
    assertEquals(anomalies.length, 1);
    assertEquals(anomalies[0].readerCommitSeq, 10);
    assertEquals(anomalies[0].readAtSeq, 1);
    assertEquals(anomalies[0].missedWriteSeq, 2);
  } finally {
    space.close();
    await Deno.remove(path).catch(() => {});
  }
});
