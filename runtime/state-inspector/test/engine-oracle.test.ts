// Proof that the durable-history oracle (oracle.ts) is a usable
// post-condition for concurrency tests, and that it is not vacuous:
//
//   1. a real contended engine run — accepted disjoint-key writes, a valid
//      read-modify-write, and a rejected stale commit — yields ZERO
//      anomalies (the engine validated every persisted read); and
//   2. a forged commit inserted behind the engine's back, claiming a read
//      the engine would have rejected, IS flagged; and
//   3. a store whose commits keep only a digest of their reads is reported
//      as unchecked rather than coherent, since the oracle cannot replay
//      those reads.
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
import {
  type ClientCommit,
  type EntityDocument,
  toDocumentPath,
} from "@commonfabric/memory/v2";
import { compactStore } from "@commonfabric/memory/v2/compact";
import { encodeStoredCommit } from "@commonfabric/memory/v2/stored-commit";
import { entityConflicts } from "../conflicts.ts";
import { openSpace } from "../db.ts";
import { readCoherence } from "../oracle.ts";

const doc = (value: unknown): EntityDocument => ({ value } as EntityDocument);

const ALICE = { sessionId: "s-alice", principal: "did:key:zAlice" };
const BOB = { sessionId: "s-bob", principal: "did:key:zBob" };
const CAROL = { sessionId: "s-carol", principal: "did:key:zCarol" };

// Seq 1: seed doc. Seq 2: Bob's valid read-modify-write of the title.
const seedContendedStore = async (storeReadsDigest = false) => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path), storeReadsDigest });

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
    assertEquals(readCoherence(space), { anomalies: [], readSetsNotKept: 0 });
  } finally {
    space.close();
    await Deno.remove(path).catch(() => {});
  }
});

// A commit claiming it read the title at seq 1 — Bob's accepted seq-2 write
// overlaps that read, so the engine would have rejected it.
const forgedCommit: ClientCommit = {
  localSeq: 99,
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
};

/** Inserts `original` at seq 10 behind the engine's back. */
const forge = (path: string, original: string) => {
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
      original,
      JSON.stringify({ seq: 10 }),
      // SQLite's `datetime()` form, as the engine writes it.
      new Date().toISOString().slice(0, 19).replace("T", " "),
    );
  } finally {
    db.close();
  }
};

Deno.test("oracle: flags a forged commit that bypassed validation", async () => {
  const { engine, path } = await seedContendedStore();
  close(engine);
  forge(path, JSON.stringify(forgedCommit));

  const space = openSpace(path);
  try {
    const { anomalies, readSetsNotKept } = readCoherence(space);
    assertEquals(readSetsNotKept, 0);
    assertEquals(anomalies.length, 1);
    assertEquals(anomalies[0].readerCommitSeq, 10);
    assertEquals(anomalies[0].readAtSeq, 1);
    assertEquals(anomalies[0].missedWriteSeq, 2);
  } finally {
    space.close();
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("oracle: reports a store whose commits keep only a digest of their reads as unchecked", async () => {
  // Bob's seq-2 commit reads the title, so an engine storing digests keeps
  // only its digest.
  const { engine, path } = await seedContendedStore(true);
  close(engine);

  const space = openSpace(path);
  try {
    assertEquals(readCoherence(space), { anomalies: [], readSetsNotKept: 1 });
  } finally {
    space.close();
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("oracle: does not certify a store when a forged commit's reads are stored as a digest", async () => {
  const { engine, path } = await seedContendedStore();
  close(engine);
  forge(path, encodeStoredCommit(forgedCommit, false));

  const space = openSpace(path);
  try {
    // The forged read cannot be replayed, so it goes uncounted as an anomaly
    // and is counted as unchecked instead.
    assertEquals(readCoherence(space), { anomalies: [], readSetsNotKept: 1 });
  } finally {
    space.close();
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("oracle: scans the log for unchecked commits once per report", async () => {
  const { engine, path } = await seedContendedStore(true);
  close(engine);

  const space = openSpace(path);
  try {
    // Count the coverage scans the report prepares, whatever entities it
    // analyzes.
    let scans = 0;
    const prepare = space.db.prepare.bind(space.db);
    space.db.prepare = ((sql: string) => {
      if (sql.includes(`'$.reads.confirmed'`)) scans++;
      return prepare(sql);
    }) as typeof space.db.prepare;

    readCoherence(space);

    assertEquals(scans, 1);
  } finally {
    space.close();
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("oracle: does not certify a store whose write history compaction squashed", async () => {
  // The forged seq-10 read missed Bob's seq-2 write. Compaction keeps every
  // payload (its default window) but squashes entity:doc's history into its
  // own commit, so write 2 is gone.
  const { engine, path } = await seedContendedStore();
  close(engine);
  forge(path, JSON.stringify(forgedCommit));
  const out = `${path}.compacted.sqlite`;
  await compactStore({
    store: path,
    out,
    selection: { prefixes: ["entity:"] },
    runId: "squash",
  });

  const space = openSpace(out);
  try {
    // Bob's seq-2 read and the forged seq-10 read are at seq 1, below seq 2,
    // the oldest revision compaction kept.
    assertEquals(readCoherence(space), { anomalies: [], readSetsNotKept: 2 });
  } finally {
    space.close();
    await Deno.remove(path).catch(() => {});
    await Deno.remove(out).catch(() => {});
  }
});

Deno.test("oracle: counts a commit whose payload breaks off before it names the entity", async () => {
  const { engine, path } = await seedContendedStore();
  close(engine);
  const whole = JSON.stringify(forgedCommit);
  forge(path, whole.slice(0, whole.indexOf("entity:doc")));

  const space = openSpace(path);
  try {
    assertEquals(readCoherence(space), { anomalies: [], readSetsNotKept: 1 });
    assertEquals(entityConflicts(space, "entity:doc").readSetsNotKept, 1);
  } finally {
    space.close();
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("oracle: counts a commit whose payload is JSON that does not show its reads", async () => {
  // Valid JSON naming neither the entity nor a digest, which the codec
  // cannot decode: a payload shaped like no commit, and a read set whose
  // read names no entity in text.
  for (
    const original of [
      `fvj1:{"/":{"invalid-type@999":{}}}`,
      `fvj1:${
        JSON.stringify({
          localSeq: 99,
          reads: { confirmed: [{ "/": { "invalid-type@999": {} } }] },
          operations: [],
        })
      }`,
    ]
  ) {
    const { engine, path } = await seedContendedStore();
    close(engine);
    forge(path, original);

    const space = openSpace(path);
    try {
      assertEquals(readCoherence(space), {
        anomalies: [],
        readSetsNotKept: 1,
      });
      assertEquals(entityConflicts(space, "entity:doc").readSetsNotKept, 1);
    } finally {
      space.close();
      await Deno.remove(path).catch(() => {});
    }
  }
});

Deno.test("oracle: does not count a commit whose reads it sees, whatever else it cannot decode", async () => {
  // The reads name no entity, so no read was hidden, though an operation's
  // value carries a tag the codec does not know.
  const { engine, path } = await seedContendedStore();
  close(engine);
  forge(
    path,
    `fvj1:${
      JSON.stringify({
        localSeq: 99,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:derived",
          value: { "/": { "invalid-type@999": {} } },
        }],
      })
    }`,
  );

  const space = openSpace(path);
  try {
    assertEquals(readCoherence(space), { anomalies: [], readSetsNotKept: 0 });
  } finally {
    space.close();
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("oracle: counts a read below what compaction kept of the instance it read, and no other", async () => {
  // User-scoped of:x is written at 1 and space-scoped of:x at 2, 4 and 5.
  // Commit 3 reads space of:x at 2, commit 6 user of:x at 1, and commit 7
  // space of:x at 5. Compacting the space scope alone, keeping two revisions
  // of each instance, keeps space of:x's 4 and 5 and deletes its 2. Only
  // commit 3's read is below what compaction kept of the instance it read:
  // commit 6's basis is lower still, but compaction left its instance whole.
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const out = `${path}.compacted.sqlite`;
  const engine = await open({ url: toFileUrl(path) });
  const alice = {
    sessionId: "session:did%3Akey%3AzAlice:s1",
    principal: "did:key:zAlice",
  };
  let localSeq = 0;
  const commit = (
    operations: ClientCommit["operations"],
    confirmed: ClientCommit["reads"]["confirmed"] = [],
  ) =>
    applyCommit(engine, {
      ...alice,
      commit: {
        localSeq: ++localSeq,
        reads: { confirmed, pending: [] },
        operations,
      },
    });
  const at = (seq: number, scope?: "user") => ({
    id: "of:x",
    path: toDocumentPath(["value"]),
    seq,
    ...(scope ? { scope } : {}),
  });
  try {
    commit([{ op: "set", id: "of:x", scope: "user", value: doc(1) }]);
    commit([{ op: "set", id: "of:x", value: doc(2) }]);
    commit([{ op: "set", id: "of:a", value: doc(3) }], [at(2)]);
    commit([{ op: "set", id: "of:x", value: doc(4) }]);
    commit([{ op: "set", id: "of:x", value: doc(5) }]);
    commit([{ op: "set", id: "of:b", value: doc(6) }], [at(1, "user")]);
    commit([{ op: "set", id: "of:c", value: doc(7) }], [at(5)]);
  } finally {
    close(engine);
  }
  await compactStore({
    store: path,
    out,
    selection: { prefixes: ["of:"], scope: "space" },
    cut: { keepLast: 2 },
    runId: "one-scope",
  });

  const space = openSpace(out);
  try {
    assertEquals(readCoherence(space), { anomalies: [], readSetsNotKept: 1 });
    assertEquals(entityConflicts(space, "of:x").readSetsNotKept, 1);
  } finally {
    space.close();
    await Deno.remove(path).catch(() => {});
    await Deno.remove(out).catch(() => {});
  }
});

Deno.test("oracle: does not count a digest of pending reads only", async () => {
  // The audit replays confirmed reads, and the digest records none.
  const { engine, path } = await seedContendedStore();
  close(engine);
  forge(
    path,
    encodeStoredCommit({
      ...forgedCommit,
      reads: {
        confirmed: [],
        pending: [{
          id: "entity:doc",
          path: toDocumentPath(["value", "title"]),
          localSeq: [1],
          basisSeq: 0,
        }],
      },
    }, false),
  );

  const space = openSpace(path);
  try {
    assertEquals(readCoherence(space), { anomalies: [], readSetsNotKept: 0 });
  } finally {
    space.close();
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("oracle: looks up first writes only when some reads go unchecked, and then once", async () => {
  /** Counts the first-write queries one report prepares. */
  const firstWriteQueries = (space: ReturnType<typeof openSpace>) => {
    let queries = 0;
    const prepare = space.db.prepare.bind(space.db);
    space.db.prepare = ((sql: string) => {
      if (sql.includes("min(commit_seq)")) queries++;
      return prepare(sql);
    }) as typeof space.db.prepare;
    readCoherence(space);
    return queries;
  };

  for (const storeReadsDigest of [false, true]) {
    const { engine, path } = await seedContendedStore(storeReadsDigest);
    // A second entity, so a lookup per entity would show.
    applyCommit(engine, {
      ...CAROL,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "entity:other", value: doc(1) }],
      },
    });
    close(engine);
    const space = openSpace(path);
    try {
      assertEquals(firstWriteQueries(space), storeReadsDigest ? 1 : 0);
    } finally {
      space.close();
      await Deno.remove(path).catch(() => {});
    }
  }
});
