import { taggedHashStringOf } from "@commonfabric/data-model";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";

import {
  applyCommit,
  close,
  ConflictError,
  createBranch,
  type Engine,
  open,
} from "../v2/engine.ts";
import { DEFAULT_BRANCH, ProtocolError } from "../v2.ts";

const setOp = (id: string, value: unknown) =>
  ({ op: "set", id, value: { value } }) as never;

const patchOp = (id: string, patches: unknown[]) =>
  ({ op: "patch", id, patches }) as never;

/** Creates a document-only commit whose reads permit identity elision. */
const commit = (localSeq: number, extra: Record<string, unknown>) => {
  const reads = extra.reads as {
    confirmed: Record<string, unknown>[];
    pending: Record<string, unknown>[];
  } | undefined;
  return {
    localSeq,
    operations: [],
    ...extra,
    reads: {
      confirmed: (reads?.confirmed ?? []).map((read) => ({
        validation: "elidable",
        ...read,
      })),
      pending: (reads?.pending ?? []).map((read) => ({
        validation: "elidable",
        ...read,
      })),
    },
  } as never;
};

const headSeqOf = (engine: Engine, id: string): number | undefined =>
  engine.database.prepare(`SELECT seq FROM head WHERE id = ?`).get<
    { seq: number }
  >(id)?.seq;

describe("applyCommit() with an identity commit", () => {
  let path: string;
  let engine: Engine;

  beforeEach(async () => {
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await open({ url: toFileUrl(path) });
  });
  afterEach(async () => {
    close(engine);
    await Deno.remove(path);
  });

  // Session a installs the document, session b rewrites it, and session a
  // still holds the install as its basis. Returns the install's seq.
  function installThenRewrite(): number {
    const install = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:doc", { n: 1 })] }),
    });
    applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(1, { operations: [setOp("of:doc", { n: 2 })] }),
    });
    return install.seq;
  }

  for (const validation of [undefined, "required"] as const) {
    it(`refuses an identity with a stale ${validation ?? "unclassified"} dependency`, () => {
      const installSeq = installThenRewrite();
      expect(() =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(2, {
            reads: {
              confirmed: [{
                id: "of:doc",
                path: [],
                seq: installSeq,
                validation,
              }],
              pending: [],
            },
            operations: [setOp("of:doc", { n: 2 })],
          }),
        })
      ).toThrow(ConflictError);
    });
  }

  it("checks required evidence on an unwritten document after an elidable conflict", () => {
    const installSeq = installThenRewrite();
    const evidence = applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(2, { operations: [setOp("of:evidence", "old")] }),
    });
    applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(3, { operations: [setOp("of:evidence", "new")] }),
    });
    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(2, {
          reads: {
            confirmed: [
              {
                id: "of:doc",
                path: [],
                seq: installSeq,
                validation: "elidable",
              },
              {
                id: "of:evidence",
                path: [],
                seq: evidence.seq,
                validation: "required",
              },
            ],
            pending: [],
          },
          operations: [setOp("of:doc", { n: 2 })],
        }),
      })
    ).toThrow("of:evidence");
  });

  it("refuses stale required pending evidence after an elidable confirmed conflict", () => {
    const installSeq = installThenRewrite();
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, { operations: [setOp("of:evidence", "old")] }),
    });
    applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(2, { operations: [setOp("of:evidence", "new")] }),
    });
    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(3, {
          reads: {
            confirmed: [{ id: "of:doc", path: [], seq: installSeq }],
            pending: [{
              id: "of:evidence",
              path: [],
              localSeq: [2],
              basisSeq: 0,
              validation: "required",
            }],
          },
          operations: [setOp("of:doc", { n: 2 })],
        }),
      })
    ).toThrow("stale pending read: of:evidence");
  });

  it("accepts an identity with fresh required evidence and stale elidable reads", () => {
    const installSeq = installThenRewrite();
    const evidence = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, { operations: [setOp("of:evidence", "current")] }),
    });
    const verdict = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(3, {
        reads: {
          confirmed: [
            { id: "of:doc", path: [], seq: installSeq },
            {
              id: "of:evidence",
              path: [],
              seq: evidence.seq,
              validation: "required",
            },
          ],
          pending: [{
            id: "of:evidence",
            path: [],
            localSeq: [2],
            basisSeq: installSeq,
            validation: "required",
          }],
        },
        operations: [setOp("of:doc", { n: 2 })],
      }),
    });
    expect(verdict.elidedOpIndexes).toEqual([0]);
  });

  it("refuses required evidence changed and restored to the observed value", () => {
    const installSeq = installThenRewrite();
    const evidence = applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(2, { operations: [setOp("of:evidence", "original")] }),
    });
    applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(3, { operations: [setOp("of:evidence", "changed")] }),
    });
    applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(4, { operations: [setOp("of:evidence", "original")] }),
    });
    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(2, {
          reads: {
            confirmed: [
              { id: "of:doc", path: [], seq: installSeq },
              {
                id: "of:evidence",
                path: [],
                seq: evidence.seq,
                validation: "required",
              },
            ],
            pending: [],
          },
          operations: [setOp("of:doc", { n: 2 })],
        }),
      })
    ).toThrow("of:evidence");
  });

  for (const pending of [false, true]) {
    it(`refuses an invalid ${pending ? "pending" : "confirmed"} validation class`, () => {
      const installSeq = installThenRewrite();
      const malformed = { id: "of:doc", path: [], validation: "unknown" };
      expect(() =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(2, {
            reads: {
              confirmed: pending ? [] : [{ ...malformed, seq: installSeq }],
              pending: pending
                ? [{ ...malformed, localSeq: [1], basisSeq: 0 }]
                : [],
            },
            operations: [setOp("of:doc", { n: 2 })],
          }),
        })
      ).toThrow(ProtocolError);
    });
  }

  it("accepts a set of the stored content over a stale confirmed read, eliding the operation", () => {
    const installSeq = installThenRewrite();
    const headBefore = headSeqOf(engine, "of:doc");

    const verdict = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        reads: {
          confirmed: [{ id: "of:doc", path: [], seq: installSeq }],
          pending: [],
        },
        operations: [setOp("of:doc", { n: 2 })],
      }),
    });

    expect(verdict.elidedOpIndexes).toEqual([0]);
    expect(verdict.revisions).toEqual([]);
    expect(verdict.seq).toBeGreaterThan(headBefore!);
    expect(headSeqOf(engine, "of:doc")).toBe(headBefore);
  });

  it("refuses a set of different content over the same stale read", () => {
    const installSeq = installThenRewrite();

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(2, {
          reads: {
            confirmed: [{ id: "of:doc", path: [], seq: installSeq }],
            pending: [],
          },
          operations: [setOp("of:doc", { n: 3 })],
        }),
      })
    ).toThrow(ConflictError);
  });

  it("refuses a commit whose other operation writes, even with one identical set", () => {
    const installSeq = installThenRewrite();

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(2, {
          reads: {
            confirmed: [{ id: "of:doc", path: [], seq: installSeq }],
            pending: [],
          },
          operations: [
            setOp("of:doc", { n: 2 }),
            setOp("of:other", { m: 1 }),
          ],
        }),
      })
    ).toThrow(ConflictError);
  });

  it("refuses an identical set that depends on an unresolved pending layer", () => {
    installThenRewrite();

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(2, {
          reads: {
            confirmed: [],
            pending: [{ id: "of:doc", path: [], localSeq: [7], basisSeq: 0 }],
          },
          operations: [setOp("of:doc", { n: 2 })],
        }),
      })
    ).toThrow("pending dependency not resolved");
  });

  it("accepts an identical set whose pending read sits on a superseded own layer", () => {
    const installSeq = installThenRewrite();

    // Session a read the document through its own install layer, which
    // session b's rewrite has since superseded; the write it derived from
    // that view matches what is stored now, so it lands as a no-op.
    const verdict = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        reads: {
          confirmed: [],
          pending: [{
            id: "of:doc",
            path: [],
            localSeq: [1],
            basisSeq: installSeq - 1,
          }],
        },
        operations: [setOp("of:doc", { n: 2 })],
      }),
    });

    expect(verdict.elidedOpIndexes).toEqual([0]);
    expect(verdict.revisions).toEqual([]);
  });

  it("accepts a patch that replays from the read's basis to the stored document", () => {
    const installSeq = installThenRewrite();
    const headBefore = headSeqOf(engine, "of:doc");

    // Session a derived `n: 2` from what it read and patches it in; session
    // b already landed the same value.
    const verdict = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        reads: {
          confirmed: [{ id: "of:doc", path: [], seq: installSeq }],
          pending: [],
        },
        operations: [patchOp("of:doc", [
          { op: "replace", path: "/value/n", value: 2 },
        ])],
      }),
    });

    expect(verdict.elidedOpIndexes).toEqual([0]);
    expect(verdict.revisions).toEqual([]);
    expect(headSeqOf(engine, "of:doc")).toBe(headBefore);
  });

  it("refuses a patch whose replay from the basis differs from the stored document", () => {
    const installSeq = installThenRewrite();

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(2, {
          reads: {
            confirmed: [{ id: "of:doc", path: [], seq: installSeq }],
            pending: [],
          },
          operations: [patchOp("of:doc", [
            { op: "replace", path: "/value/n", value: 3 },
          ])],
        }),
      })
    ).toThrow(ConflictError);
  });

  it("refuses a patch that reaches the stored document but is not idempotent on it", () => {
    // Session a installs a one-element list and reads it; session b appends
    // `x`; session a's splice from its basis produces the stored list, but
    // replayed on the stored list it would append `x` a second time.
    const install = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:list", ["a"])] }),
    });
    applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(1, {
        operations: [patchOp("of:list", [
          { op: "splice", path: "/value", index: 1, remove: 0, add: ["x"] },
        ])],
      }),
    });

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(2, {
          reads: {
            confirmed: [{ id: "of:list", path: [], seq: install.seq }],
            pending: [],
          },
          operations: [patchOp("of:list", [
            { op: "splice", path: "/value", index: 1, remove: 0, add: ["x"] },
          ])],
        }),
      })
    ).toThrow(ConflictError);
  });

  it("judges a patch on a document the commit did not read by its effect on the stored one", () => {
    const installSeq = installThenRewrite();
    applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(2, { operations: [setOp("of:other", { m: 1 })] }),
    });

    // The stale read is on `of:doc`; the patch on `of:other`, which the
    // commit never read, replays on the stored document alone, and is
    // idempotent there.
    const verdict = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        reads: {
          confirmed: [{ id: "of:doc", path: [], seq: installSeq }],
          pending: [],
        },
        operations: [
          setOp("of:doc", { n: 2 }),
          patchOp("of:other", [{ op: "replace", path: "/value/m", value: 1 }]),
        ],
      }),
    });
    expect(verdict.elidedOpIndexes).toEqual([0, 1]);

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(3, {
          reads: {
            confirmed: [{ id: "of:doc", path: [], seq: installSeq }],
            pending: [],
          },
          operations: [
            setOp("of:doc", { n: 2 }),
            patchOp("of:other", [{
              op: "replace",
              path: "/value/m",
              value: 5,
            }]),
          ],
        }),
      })
    ).toThrow(ConflictError);
  });

  it("accepts a patch built against an absent document that the space now holds identically", () => {
    // Two sessions each install the same derived value into a document
    // neither had seen; the first lands, the second read the document as
    // absent at seq 0 and patches the same content in.
    applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(1, {
        operations: [patchOp("of:fresh", [
          { op: "add", path: "/value", value: { n: 7 } },
        ])],
      }),
    });

    const verdict = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, {
        reads: {
          confirmed: [{ id: "of:fresh", path: [], seq: 0 }],
          pending: [],
        },
        operations: [patchOp("of:fresh", [
          { op: "add", path: "/value", value: { n: 7 } },
        ])],
      }),
    });

    expect(verdict.elidedOpIndexes).toEqual([0]);
    expect(verdict.revisions).toEqual([]);
  });

  it("replays a document's operations in order, so a create-then-patch of stored content is an identity", () => {
    // Session b creates the document with its final content in one set.
    // Session a, which read it as absent, creates it with a set and then
    // patches the value in; only the sequence lands on what is stored.
    applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(1, {
        operations: [{
          op: "set",
          id: "of:built",
          value: { result: "r", value: { n: 3 } },
        } as never],
      }),
    });

    const verdict = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, {
        reads: {
          confirmed: [{ id: "of:built", path: [], seq: 0 }],
          pending: [],
        },
        operations: [
          { op: "set", id: "of:built", value: { result: "r" } } as never,
          patchOp("of:built", [{ op: "add", path: "/value", value: { n: 3 } }]),
        ],
      }),
    });

    expect(verdict.elidedOpIndexes).toEqual([0, 1]);
    expect(verdict.revisions).toEqual([]);
  });

  it("writes a patch that no staleness check refuses as an ordinary revision", () => {
    installThenRewrite();

    // Without a stale read there is nothing to escape from, so an
    // idempotent patch still records its revision like any other write.
    const verdict = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        operations: [patchOp("of:doc", [
          { op: "replace", path: "/value/n", value: 2 },
        ])],
      }),
    });
    expect(verdict.elidedOpIndexes).toBeUndefined();
    expect(verdict.revisions.map((revision) => revision.id)).toEqual([
      "of:doc",
    ]);
  });

  it("writes a first set of an absent document as an ordinary revision", () => {
    const verdict = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:fresh", { n: 1 })] }),
    });

    expect(verdict.elidedOpIndexes).toBeUndefined();
    expect(verdict.revisions.map((revision) => revision.id)).toEqual([
      "of:fresh",
    ]);
  });

  // Session a installs {a: 1}, stacks its own {b: 2} on it, and patches
  // a to 2 from that view, intending {a: 2, b: 2}; session b replaced the
  // document with {a: 2} in between. Returns the install's and the
  // layer's seqs.
  function installStackThenReplace(): { install: number; layer: number } {
    const install = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:doc", { a: 1 })] }),
    });
    const layer = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        reads: {
          confirmed: [{ id: "of:doc", path: [], seq: install.seq }],
          pending: [],
        },
        operations: [patchOp("of:doc", [
          { op: "add", path: "/value/b", value: 2 },
        ])],
      }),
    });
    applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(1, { operations: [setOp("of:doc", { a: 2 })] }),
    });
    return { install: install.seq, layer: layer.seq };
  }

  it("refuses a patch whose replay from the reader's pending view differs from the stored document", () => {
    const { install } = installStackThenReplace();

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(3, {
          reads: {
            confirmed: [],
            pending: [{
              id: "of:doc",
              path: [],
              localSeq: 2,
              basisSeq: install,
            }],
          },
          operations: [patchOp("of:doc", [
            { op: "replace", path: "/value/a", value: 2 },
          ])],
        }),
      })
    ).toThrow(ConflictError);
  });

  it("takes the pending read as the basis when the commit also reads the document confirmed", () => {
    // Replayed from the confirmed seq the patch would land on {a: 2}, the
    // stored document, and pass as an identity; the reader's value came
    // through its layer, where the same replay yields {a: 2, b: 2}.
    const { install } = installStackThenReplace();

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(3, {
          reads: {
            confirmed: [{
              id: "of:doc",
              path: [],
              seq: install,
              nonRecursive: true,
            }],
            pending: [{
              id: "of:doc",
              path: [],
              localSeq: 2,
              basisSeq: install,
            }],
          },
          operations: [patchOp("of:doc", [
            { op: "replace", path: "/value/a", value: 2 },
          ])],
        }),
      })
    ).toThrow(ConflictError);
  });

  it("replays a pending read's view from its declared basis, not from the layer's durable snapshot", () => {
    // Session a's view of the document is {a: 0} plus its own blind layer
    // adding c: 1, so {a: 0, c: 1}. Session b replaced the document with
    // {a: 1} before that layer landed, and then added b: 2, so the
    // durable document at the layer's resolution is {a: 1, c: 1} and the
    // stored one {a: 1, b: 2, c: 1}. A patch adding b: 2, replayed from
    // the layer's durable snapshot, would match what is stored; replayed
    // from the view session a in fact held it yields {a: 0, b: 2, c: 1},
    // so the commit's stale read of a is a real one and it is refused.
    const install = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:doc", { a: 0 })] }),
    });
    applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(1, { operations: [setOp("of:doc", { a: 1 })] }),
    });
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        operations: [patchOp("of:doc", [
          { op: "add", path: "/value/c", value: 1 },
        ])],
      }),
    });
    applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(2, {
        operations: [patchOp("of:doc", [
          { op: "add", path: "/value/b", value: 2 },
        ])],
      }),
    });

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(3, {
          reads: {
            confirmed: [],
            pending: [{
              id: "of:doc",
              path: [],
              localSeq: 2,
              basisSeq: install.seq,
            }],
          },
          operations: [patchOp("of:doc", [
            { op: "add", path: "/value/b", value: 2 },
          ])],
        }),
      })
    ).toThrow(ConflictError);
  });

  it("reconstructs the view past a layer's operations on other documents", () => {
    // Session a's layer sets another document beside its patch of this
    // one; only the patch is replayed. Session b's replace of n makes the
    // read stale, and from the view {n: 1, m: 1} the replace of n lands
    // on the stored {n: 2, m: 1}.
    const install = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:doc", { n: 1 })] }),
    });
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        operations: [
          setOp("of:other", { x: 1 }),
          patchOp("of:doc", [{ op: "add", path: "/value/m", value: 1 }]),
        ],
      }),
    });
    applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(1, {
        operations: [patchOp("of:doc", [
          { op: "replace", path: "/value/n", value: 2 },
        ])],
      }),
    });

    const verdict = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(3, {
        reads: {
          confirmed: [],
          pending: [{
            id: "of:doc",
            path: [],
            localSeq: 2,
            basisSeq: install.seq,
          }],
        },
        operations: [patchOp("of:doc", [
          { op: "replace", path: "/value/n", value: 2 },
        ])],
      }),
    });

    expect(verdict.elidedOpIndexes).toEqual([0]);
    expect(verdict.revisions).toEqual([]);
  });

  it("reconstructs the view through a layer that deleted the document", () => {
    // Session a deletes the document in one layer and recreates it in the
    // next, so its view is the recreated {n: 2}; session b then adds m: 1.
    // Adding m: 1 from that view lands on what is stored.
    const install = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:doc", { n: 1 })] }),
    });
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        operations: [{ op: "delete", id: "of:doc" } as never],
      }),
    });
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(3, { operations: [setOp("of:doc", { n: 2 })] }),
    });
    applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(1, {
        operations: [patchOp("of:doc", [
          { op: "add", path: "/value/m", value: 1 },
        ])],
      }),
    });

    const verdict = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(4, {
        reads: {
          confirmed: [],
          pending: [{
            id: "of:doc",
            path: [],
            localSeq: [2, 3],
            basisSeq: install.seq,
          }],
        },
        operations: [patchOp("of:doc", [
          { op: "add", path: "/value/m", value: 1 },
        ])],
      }),
    });

    expect(verdict.elidedOpIndexes).toEqual([0]);
    expect(verdict.revisions).toEqual([]);
  });

  it("gives no exemption to a pending read naming a layer on another branch", () => {
    // Session a's named layer was committed on `feature`; its operations
    // say nothing about the parent branch's document, so the view cannot
    // be reconstructed and the refusal stands.
    const install = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:doc", { n: 1 })] }),
    });
    createBranch(engine, "feature");
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        branch: "feature",
        operations: [patchOp("of:doc", [
          { op: "add", path: "/value/m", value: 1 },
        ])],
      }),
    });
    applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(1, {
        operations: [patchOp("of:doc", [
          { op: "replace", path: "/value/n", value: 2 },
        ])],
      }),
    });

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(3, {
          reads: {
            confirmed: [],
            pending: [{
              id: "of:doc",
              path: [],
              localSeq: 2,
              basisSeq: install.seq,
            }],
          },
          operations: [patchOp("of:doc", [
            { op: "replace", path: "/value/n", value: 2 },
          ])],
        }),
      })
    ).toThrow(ConflictError);
  });

  it("gives no exemption to a pending read that declares no basis", () => {
    // The same shape as the accepted patch-from-basis case, with a legacy
    // pending read: without a declared basis the reader's view cannot be
    // reconstructed, and the staleness refusal stands.
    const install = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:doc", { n: 1 })] }),
    });
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        reads: {
          confirmed: [{ id: "of:doc", path: [], seq: install.seq }],
          pending: [],
        },
        operations: [patchOp("of:doc", [
          { op: "add", path: "/value/m", value: 1 },
        ])],
      }),
    });
    applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(1, {
        operations: [patchOp("of:doc", [
          { op: "replace", path: "/value/n", value: 2 },
        ])],
      }),
    });

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(3, {
          reads: {
            confirmed: [],
            pending: [{ id: "of:doc", path: [], localSeq: 2 }],
          },
          operations: [patchOp("of:doc", [
            { op: "replace", path: "/value/n", value: 2 },
          ])],
        }),
      })
    ).toThrow(ConflictError);
  });

  // Session a installs the document with the parent branch at seq 1,
  // `feature` forks there, session a writes {a: 1, b: 1} on `feature`, and
  // session x replaces that with {a: 1, b: 0}. Returns the install seq and
  // the seq of session a's feature write.
  function installForkThenReplaceOnFeature(): {
    install: number;
    onFeature: number;
  } {
    const install = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:doc", { a: 1, b: 0 })] }),
    });
    createBranch(engine, "feature");
    const onFeature = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        branch: "feature",
        operations: [setOp("of:doc", { a: 1, b: 1 })],
      }),
    });
    applyCommit(engine, {
      sessionId: "s:x",
      commit: commit(1, {
        branch: "feature",
        operations: [setOp("of:doc", { a: 1, b: 0 })],
      }),
    });
    return { install: install.seq, onFeature: onFeature.seq };
  }

  it("passes over a read of the entity on another branch when choosing the basis", () => {
    // The parent-branch read comes first and its seq names a feature
    // revision that happens to equal the stored one, so a replay from it
    // would pass; the feature read is the commit's view of this branch,
    // and from {a: 1, b: 1} the replace of a leaves b: 1, not the stored
    // b: 0.
    const { install, onFeature } = installForkThenReplaceOnFeature();

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(3, {
          branch: "feature",
          reads: {
            confirmed: [
              { id: "of:doc", branch: DEFAULT_BRANCH, path: [], seq: install },
              { id: "of:doc", path: [], seq: onFeature },
            ],
            pending: [],
          },
          operations: [patchOp("of:doc", [
            { op: "replace", path: "/value/a", value: 1 },
          ])],
        }),
      })
    ).toThrow(ConflictError);
  });

  it("reads a confirmed read that names no branch as a read of the commit's branch", () => {
    // The wire shape omits a branch equal to the commit's. Passed over as
    // a default-branch read, the commit would have no read of the document
    // and the idempotent patch would pass on the stored document alone;
    // as the feature read it is, its view {a: 1, b: 1} replays to a
    // document the stored {a: 1, b: 0} is not.
    const { onFeature } = installForkThenReplaceOnFeature();

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(3, {
          branch: "feature",
          reads: {
            confirmed: [{ id: "of:doc", path: [], seq: onFeature }],
            pending: [],
          },
          operations: [patchOp("of:doc", [
            { op: "replace", path: "/value/a", value: 1 },
          ])],
        }),
      })
    ).toThrow(ConflictError);
  });

  it("gives no exemption to a confirmed read below the branch's creation seq", () => {
    // Two parent-branch commits precede the branch, so a feature read at
    // seq 1 names no state of the feature branch (06-branching.md
    // §6.10.1); the idempotent replace would pass on the stored document
    // alone, and the refusal stands instead.
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:doc", { a: 1 })] }),
    });
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, { operations: [setOp("of:other", { x: 1 })] }),
    });
    createBranch(engine, "feature");
    applyCommit(engine, {
      sessionId: "s:x",
      commit: commit(1, {
        branch: "feature",
        operations: [setOp("of:doc", { a: 3 })],
      }),
    });

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(3, {
          branch: "feature",
          reads: {
            confirmed: [{ id: "of:doc", path: [], seq: 1 }],
            pending: [],
          },
          operations: [patchOp("of:doc", [
            { op: "replace", path: "/value/a", value: 3 },
          ])],
        }),
      })
    ).toThrow(ConflictError);
  });

  it("gives no exemption to a pending read whose basis is below the branch's creation seq", () => {
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:doc", { a: 1 })] }),
    });
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, { operations: [setOp("of:other", { x: 1 })] }),
    });
    createBranch(engine, "feature");
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(3, {
        branch: "feature",
        operations: [patchOp("of:doc", [
          { op: "add", path: "/value/m", value: 1 },
        ])],
      }),
    });
    applyCommit(engine, {
      sessionId: "s:x",
      commit: commit(1, {
        branch: "feature",
        operations: [patchOp("of:doc", [
          { op: "replace", path: "/value/a", value: 3 },
        ])],
      }),
    });

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(4, {
          branch: "feature",
          reads: {
            confirmed: [],
            pending: [{ id: "of:doc", path: [], localSeq: 3, basisSeq: 1 }],
          },
          operations: [patchOp("of:doc", [
            { op: "replace", path: "/value/a", value: 3 },
          ])],
        }),
      })
    ).toThrow(ConflictError);
  });

  it("refuses rather than failing to read when the other branch's read seq predates the fork", () => {
    // Two parent-branch writes precede the fork, so the parent read's seq
    // has no feature revision to read; taken as the basis it would surface
    // as a read failure instead of the conflict the feature read carries.
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:doc", { a: 1 })] }),
    });
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, { operations: [setOp("of:other", { x: 1 })] }),
    });
    createBranch(engine, "feature");
    const onFeature = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(3, {
        branch: "feature",
        operations: [setOp("of:doc", { a: 2 })],
      }),
    });
    applyCommit(engine, {
      sessionId: "s:x",
      commit: commit(1, {
        branch: "feature",
        operations: [setOp("of:doc", { a: 3 })],
      }),
    });

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(4, {
          branch: "feature",
          reads: {
            confirmed: [
              { id: "of:doc", branch: DEFAULT_BRANCH, path: [], seq: 1 },
              { id: "of:doc", path: [], seq: onFeature.seq },
            ],
            pending: [],
          },
          operations: [patchOp("of:doc", [
            { op: "replace", path: "/value/a", value: 2 },
          ])],
        }),
      })
    ).toThrow(ConflictError);
  });

  it("still refuses a malformed pending basis on the identity path", () => {
    // The stale confirmed read sends the commit to the proof, which would
    // accept the identical set; the pending read of another document
    // claims a basis ahead of the log, and that is a protocol violation
    // whichever path the commit takes.
    const installSeq = installThenRewrite();
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, { operations: [setOp("of:other", { x: 1 })] }),
    });

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(3, {
          reads: {
            confirmed: [{ id: "of:doc", path: [], seq: installSeq }],
            pending: [{
              id: "of:other",
              path: [],
              localSeq: 2,
              basisSeq: 999,
            }],
          },
          operations: [setOp("of:doc", { n: 2 })],
        }),
      })
    ).toThrow(ProtocolError);
  });

  it("refuses a commit with no operations over a stale confirmed read", () => {
    // Only the wave path admits an empty operation list, for a wave whose
    // outbound appends ride the transaction; a stale read on one is still
    // a stale read, with nothing for the identity proof to prove.
    const installSeq = installThenRewrite();

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(2, {
          reads: {
            confirmed: [{ id: "of:doc", path: [], seq: installSeq }],
            pending: [],
          },
        }),
        allowEmptyOperations: true,
      })
    ).toThrow(ConflictError);
  });

  it("refuses a delete over a stale confirmed read", () => {
    const installSeq = installThenRewrite();

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(2, {
          reads: {
            confirmed: [{ id: "of:doc", path: [], seq: installSeq }],
            pending: [],
          },
          operations: [{ op: "delete", id: "of:doc" } as never],
        }),
      })
    ).toThrow(ConflictError);
  });

  it("accepts an identical content-addressed re-set beside an identical set over a stale read", () => {
    const installSeq = installThenRewrite();
    const content = { type: "string" };
    const contentId = `cid:${taggedHashStringOf(content)}`;
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        operations: [setOp(contentId, content)],
      }),
    });

    const verdict = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(3, {
        reads: {
          confirmed: [{ id: "of:doc", path: [], seq: installSeq }],
          pending: [],
        },
        operations: [
          setOp(contentId, content),
          setOp("of:doc", { n: 2 }),
        ],
      }),
    });

    expect(verdict.elidedOpIndexes).toEqual([0, 1]);
    expect(verdict.revisions).toEqual([]);
  });

  it("refuses a content-addressed set of new content over a stale read", () => {
    const installSeq = installThenRewrite();
    const content = { type: "number" };
    const contentId = `cid:${taggedHashStringOf(content)}`;

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(2, {
          reads: {
            confirmed: [{ id: "of:doc", path: [], seq: installSeq }],
            pending: [],
          },
          operations: [
            setOp(contentId, content),
            setOp("of:doc", { n: 2 }),
          ],
        }),
      })
    ).toThrow(ConflictError);
  });

  it("refuses a patch that cannot apply on the document at its basis", () => {
    const installSeq = installThenRewrite();

    expect(() =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(2, {
          reads: {
            confirmed: [{ id: "of:doc", path: [], seq: installSeq }],
            pending: [],
          },
          // A path through the scalar `n` is not traversable, where a
          // missing object key would be created on the way down.
          operations: [patchOp("of:doc", [
            { op: "replace", path: "/value/n/x", value: 2 },
          ])],
        }),
      })
    ).toThrow(ConflictError);
  });
});
