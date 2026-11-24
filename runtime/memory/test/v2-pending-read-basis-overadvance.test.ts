// CT-1910: the pending-read basis over-advance and its repair.
//
// The bug (recorded against INV-1 in docs/specs/memory-v2/09-invariants.md,
// machine-found by docs/specs/memory-v2/tla/PendingStacks_Current.cfg): the
// staleness scan for a LEGACY pending read starts at the highest
// dependency's resolution seq, so overlapping FOREIGN writes landing between
// the reader's confirmed basis and that seq are never scanned. The
// engine-level repro is the one verified in the PR #4606 review thread
// (2026-07-24), transcribed to the post-#4606 array-localSeq wire shape.
//
// The repair (`PendingStacks_Repaired.cfg` certifies it): a pending read
// that declares its true confirmed basis (`basisSeq`, in the SERVER's seq
// space) is scanned over the FULL interval (basisSeq, head], excluding the
// session's own accepted commits.
//
// The legacy-shape tests below deliberately assert the UNSOUND accept: they
// are the regression witness for why `basisSeq` exists (the same role the
// violated TLA config plays), and they document the deviation that persists
// for clients that do not declare a basis. The repaired-shape tests assert
// the same schedule is rejected once the basis is declared, that own-session
// exclusion prevents the self-conflict which historically forced the basis
// to over-advance, and the basisSeq validation surface.

import { assertEquals, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import {
  applyCommit,
  close,
  ConflictError,
  type Engine,
  open,
  ProtocolError,
  read,
} from "../v2/engine.ts";
import { type EntityDocument, toDocumentPath } from "../v2.ts";

const createEngine = async (): Promise<{ engine: Engine; path: string }> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  return { engine, path };
};

const invocationFor = (
  localSeq: number,
  extra: Record<string, unknown> = {},
) => ({
  iss: "did:key:alice",
  aud: "did:key:service",
  cmd: "/memory/transact",
  sub: "did:key:space",
  args: { localSeq, ...extra },
});

const authorization = {
  signature: "sig:alice",
  access: { "proof:1": {} },
};

const toEntityDocument = (
  value: unknown,
): EntityDocument => ({ value } as EntityDocument);

// The shared schedule. Seq numbers are the engine's accepted-commit seqs:
//
//   seq 1  session:1  localSeq 1  set   A = {x: 1}
//   seq 2  FOREIGN                patch A.x = 2        <- the write the
//   seq 3  session:1  localSeq 2  patch A.y = 9 (blind)   reader must see
//
// The reader (session:1, localSeq 3) observed x = 1 through its pending
// stack. Its true confirmed basis is seq 0; the foreign x = 2 landed at
// seq 2. Any coherent admission must scan an interval containing seq 2.
const seedSchedule = (engine: Engine): void => {
  applyCommit(engine, {
    sessionId: "session:1",
    invocation: invocationFor(1),
    authorization,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "entity:A",
        value: toEntityDocument({ x: 1 }),
      }],
    },
  });
  applyCommit(engine, {
    sessionId: "session:other",
    invocation: invocationFor(1, { actor: "other" }),
    authorization,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "patch",
        id: "entity:A",
        patches: [{ op: "replace", path: "/value/x", value: 2 }],
      }],
    },
  });
  applyCommit(engine, {
    sessionId: "session:1",
    invocation: invocationFor(2),
    authorization,
    commit: {
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "patch",
        id: "entity:A",
        patches: [{ op: "add", path: "/value/y", value: 9 }],
      }],
    },
  });
};

Deno.test("memory v2 engine: CT-1910 — pending-read staleness scan misses a foreign write between the reader's confirmed basis and its resolution basis", async () => {
  const { engine, path } = await createEngine();
  try {
    seedSchedule(engine);

    // Reader: full-stack dependency declaration per #4606 — the array names
    // every pending layer the view sat on, including the doc's top-of-stack
    // layer (localSeq 2, resolved at seq 3). Basis = resolve(max) = 3, so
    // the staleness scan covers (3, head] and can never reach the foreign
    // x = 2 at seq 2. No dependency-recording shape fixes this: the scan
    // interval is wrong, not the dependency set (tla/README.md).
    applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(3),
      authorization,
      commit: {
        localSeq: 3,
        reads: {
          confirmed: [],
          pending: [{
            id: "entity:A",
            path: toDocumentPath(["value", "x"]),
            localSeq: [1, 2],
          }],
        },
        operations: [{
          op: "set",
          id: "entity:derived",
          value: toEntityDocument({ observedX: 1 }),
        }],
      },
    });

    // Durable history says x has been 2 since seq 2 …
    assertEquals(
      (read(engine, { id: "entity:A" })?.value as { x: number }).x,
      2,
    );
    // … yet the accepted commit durably recorded an observation of x = 1:
    // observed ⊂ durable, the INV-1 "missed write" direction. This accept IS
    // the deviation, kept as a regression witness: it persists exactly for
    // readers that declare no basisSeq. The repaired-shape test below shows
    // the identical schedule rejecting once the basis is declared.
    assertEquals(
      (read(engine, { id: "entity:derived" })?.value as { observedX: number })
        .observedX,
      1,
    );
  } finally {
    close(engine);
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("memory v2 engine: CT-1910 counterfactual — the same observation at its true confirmed basis is rejected as stale", async () => {
  const { engine, path } = await createEngine();
  try {
    seedSchedule(engine);

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(3),
          authorization,
          commit: {
            localSeq: 3,
            reads: {
              confirmed: [{
                id: "entity:A",
                path: toDocumentPath(["value", "x"]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:derived",
              value: toEntityDocument({ observedX: 1 }),
            }],
          },
        }),
      ConflictError,
      "stale confirmed read",
    );

    assertEquals(read(engine, { id: "entity:derived" }), null);
  } finally {
    close(engine);
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("memory v2 engine: CT-1910 repair — a pending read declaring its true basis is scanned over the full interval and rejects", async () => {
  const { engine, path } = await createEngine();
  try {
    seedSchedule(engine);

    // Identical to the legacy-shape reader except for basisSeq: 0 — the
    // reader's true confirmed basis. The scan now covers (0, head] and finds
    // the foreign x = 2 at seq 2; the reader's own writes at seq 1 and 3 are
    // excluded by session attribution, not by basis placement.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(3),
          authorization,
          commit: {
            localSeq: 3,
            reads: {
              confirmed: [],
              pending: [{
                id: "entity:A",
                path: toDocumentPath(["value", "x"]),
                localSeq: [1, 2],
                basisSeq: 0,
              }],
            },
            operations: [{
              op: "set",
              id: "entity:derived",
              value: toEntityDocument({ observedX: 1 }),
            }],
          },
        }),
      ConflictError,
      "stale pending read",
    );

    assertEquals(read(engine, { id: "entity:derived" }), null);
  } finally {
    close(engine);
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("memory v2 engine: CT-1910 repair — own-session exclusion admits a reader whose interval contains only its own writes", async () => {
  const { engine, path } = await createEngine();
  try {
    seedSchedule(engine);

    // The reader observes y = 9 through its own stack. From basis 0 the
    // interval holds its own whole-doc set (seq 1, Tier-1 path-blind) and
    // its own y patch (seq 3) — both excluded as own-session — plus the
    // foreign x patch (seq 2), which does not overlap the y read. Without
    // the exclusion this reader would self-conflict on seq 3 (or seq 1),
    // which is exactly why pending reads historically over-advanced their
    // basis instead of declaring the true one.
    const applied = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(3),
      authorization,
      commit: {
        localSeq: 3,
        reads: {
          confirmed: [],
          pending: [{
            id: "entity:A",
            path: toDocumentPath(["value", "y"]),
            localSeq: [1, 2],
            basisSeq: 0,
          }],
        },
        operations: [{
          op: "set",
          id: "entity:derived",
          value: toEntityDocument({ observedY: 9 }),
        }],
      },
    });
    assertEquals(applied.seq, 4);
    assertEquals(
      (read(engine, { id: "entity:derived" })?.value as { observedY: number })
        .observedY,
      9,
    );
  } finally {
    close(engine);
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("memory v2 engine: CT-1910 repair — a reader that integrated the foreign write commits coherently from its later basis", async () => {
  const { engine, path } = await createEngine();
  try {
    seedSchedule(engine);

    // The reader received the log through seq 2, so its confirmed view holds
    // the foreign x = 2 and its observation is x = 2. From basis 2 the
    // interval holds only its own seq-3 patch, excluded. Coherent — accepted.
    const applied = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(3),
      authorization,
      commit: {
        localSeq: 3,
        reads: {
          confirmed: [],
          pending: [{
            id: "entity:A",
            path: toDocumentPath(["value", "x"]),
            localSeq: [1, 2],
            basisSeq: 2,
          }],
        },
        operations: [{
          op: "set",
          id: "entity:derived",
          value: toEntityDocument({ observedX: 2 }),
        }],
      },
    });
    assertEquals(applied.seq, 4);
    assertEquals(
      (read(engine, { id: "entity:derived" })?.value as { observedX: number })
        .observedX,
      2,
    );
  } finally {
    close(engine);
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("memory v2 engine: CT-1910 repair — an own-session write accepted out of submission order is not excluded from the scan", async () => {
  const { engine, path } = await createEngine();
  try {
    // session:1 localSeq 1: A = {x: 1} -> seq 1.
    applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:A",
          value: toEntityDocument({ x: 1 }),
        }],
      },
    });
    // session:1 localSeq 10 OVERTAKES localSeq 5 (out-of-order submission —
    // e.g. hold-mode admission releasing a later blind commit while an
    // earlier read-bearing commit waits): x = 2 -> seq 2.
    applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(10),
      authorization,
      commit: {
        localSeq: 10,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:A",
          patches: [{ op: "replace", path: "/value/x", value: 2 }],
        }],
      },
    });
    // session:1 localSeq 5 reads x through its layer [1] at basisSeq 0 and
    // claims it observed x = 1. The overtaking own write (localSeq 10, seq
    // 2) was NOT in its view: a session-wide exclusion would excuse it and
    // accept the incoherent observation — the declared-set exclusion
    // (only the named layer 1 is excluded) must conflict, like a foreign
    // write.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(5),
          authorization,
          commit: {
            localSeq: 5,
            reads: {
              confirmed: [],
              pending: [{
                id: "entity:A",
                path: toDocumentPath(["value", "x"]),
                localSeq: [1],
                basisSeq: 0,
              }],
            },
            operations: [{
              op: "set",
              id: "entity:derived",
              value: toEntityDocument({ observedX: 1 }),
            }],
          },
        }),
      ConflictError,
      "stale pending read",
    );
    assertEquals(read(engine, { id: "entity:derived" }), null);
  } finally {
    close(engine);
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("memory v2 engine: CT-1910 repair — basisSeq validation", async () => {
  const { engine, path } = await createEngine();
  try {
    seedSchedule(engine);

    const readerWithBasis = (basisSeq: number) => ({
      sessionId: "session:1",
      invocation: invocationFor(3),
      authorization,
      commit: {
        localSeq: 3,
        reads: {
          confirmed: [],
          pending: [{
            id: "entity:A",
            path: toDocumentPath(["value", "y"]),
            localSeq: [1, 2],
            basisSeq,
          }],
        },
        operations: [{
          op: "set" as const,
          id: "entity:derived",
          value: toEntityDocument({ observedY: 9 }),
        }],
      },
    });

    assertThrows(
      () => applyCommit(engine, readerWithBasis(-1)),
      ProtocolError,
      "malformed basisSeq",
    );
    assertThrows(
      () => applyCommit(engine, readerWithBasis(1.5)),
      ProtocolError,
      "malformed basisSeq",
    );
    // Head is 3; claiming a basis beyond it claims knowledge the server
    // never produced. (A basis AT head is legal: empty scan, same
    // client-trusted claim a confirmed read at head makes.)
    assertThrows(
      () => applyCommit(engine, readerWithBasis(4)),
      ProtocolError,
      "ahead of the log",
    );
    assertEquals(read(engine, { id: "entity:derived" }), null);
  } finally {
    close(engine);
    await Deno.remove(path).catch(() => {});
  }
});
